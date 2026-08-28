// ============================================================
//  POST /api/scrape — HTTP trigger (Function 1)
//
//  Accepts a scrape request, creates a pipeline_run (subscription)
//  in Supabase, enqueues a message on Service Bus `scrape-requests`,
//  returns 202 { runId } immediately. Heavy work happens in the
//  scraper worker function.
// ============================================================

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { enqueue, ensureQueues } from "../storageQueue";
import { getSupabaseClient } from "../supabase";
import type { ScrapeRequestMessage } from "../types";
import { consumeUsage, refundUsage, UsageLimitReachedError } from "../usage";

// Boards that are actively working (all routed through the Cloudflare proxy
// or public APIs — NO ScraperAPI):
//   jobsdb      → Cloudflare proxy (residential fallback, HTML parse)   ✅
//   ctgoodjobs  → Cloudflare proxy (residential fallback, HTML parse)   ✅
//   offertoday  → public JSON API (no proxy needed)                     ✅
//   linkedin    → public guest API (no proxy needed)                    ✅
//   indeed      → Cloudflare proxy (render/anti-bot) + RPC batch detail ✅
const DEFAULT_BOARDS = [
  "jobsdb",
  "ctgoodjobs",
  "indeed",
  "offertoday",
  "linkedin",
];
const ALLOWED_BOARDS = [
  "jobsdb",
  "ctgoodjobs",
  "indeed",
  "offertoday",
  "linkedin",
];

app.http("scrape", {
  methods: ["POST"],
  authLevel: "function", // function key — client authenticates via x-functions-key
  route: "scrape",
  handler: async (
    req: HttpRequest,
    context: InvocationContext,
  ): Promise<HttpResponseInit> => {
    // ── Parse + validate body ────────────────────────────────
    let body: {
      keyword?: string;
      pages?: number;
      boards?: string[];
      country_code?: string;
      user_id?: string;
      max_results_per_board?: number;
      retry?: boolean;
    } = {};
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return { status: 400, jsonBody: { error: "invalid JSON body" } };
    }

    const keyword = (body.keyword ?? "").trim();
    if (!keyword) {
      return { status: 400, jsonBody: { error: "keyword is required" } };
    }

    const pages = Math.min(Math.max(Number(body.pages) || 1, 1), 5);
    const boards = Array.isArray(body.boards)
      ? body.boards.filter((b) => ALLOWED_BOARDS.includes(b))
      : [...DEFAULT_BOARDS];
    const userId = body.user_id?.trim() ?? "";
    const countryCode =
      typeof body.country_code === "string"
        ? body.country_code.slice(0, 5)
        : undefined;
    const maxResultsPerBoard =
      body.max_results_per_board !== undefined &&
      Number.isFinite(Number(body.max_results_per_board)) &&
      Number(body.max_results_per_board) > 0
        ? Number(body.max_results_per_board)
        : undefined;

    if (!userId) {
      return { status: 401, jsonBody: { error: "user_id is required" } };
    }

    const searchKey = keyword.toLowerCase().replace(/\s+/g, "_");
    const supabase = getSupabaseClient();

    // ── VALIDATE RETRY (anti-abuse) ───────────────────────────
    // `retry:true` must NOT be a free pass. An attacker could send
    // retry:true with a brand-new keyword to bypass quota. A retry is only
    // honored when:
    //   1. the user has a PRIOR run with the SAME keyword that FAILED, and
    //   2. the requested boards are a subset of the boards that failed in
    //      that prior run (so a retry can never broaden into a fresh
    //      multi-board search).
    // Otherwise we treat it as a NEW search and consume quota normally.
    let isRetry = body.retry === true;
    if (isRetry) {
      const { data: prior } = await supabase
        .from("pipeline_runs")
        .select("id, boards, status, created_at")
        .eq("user_id", userId)
        .eq("search_key", searchKey)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const priorFailed =
        prior?.status === "failed" && Array.isArray(prior.boards);

      if (!priorFailed || !prior) {
        // No failed prior run for this keyword → this is NOT a legit retry.
        console.warn(
          `[scrape] retry rejected for ${userId}/${searchKey}: no failed prior run`,
        );
        isRetry = false;
      } else {
        // Only allow re-scraping boards that were part of the FAILED prior
        // run — never boards the user didn't already attempt. This stops an
        // attacker from using retry to broaden into boards (e.g. Indeed)
        // they're not entitled to, or to widen a search for free.
        const priorBoards = (prior.boards as string[]) ?? [];
        const allRequestedInPrior = boards.every((b) =>
          priorBoards.includes(b),
        );
        if (!allRequestedInPrior || boards.length === 0) {
          console.warn(
            `[scrape] retry rejected for ${userId}/${searchKey}: boards not subset of prior run`,
          );
          isRetry = false;
        } else {
          // Strongest check: every requested board must have a recorded
          // failed/blocked stage in the prior run's run_boards. A board that
          // succeeded must NOT be retryable (would be a free re-fetch).
          const { data: boardRows } = await supabase
            .from("run_boards")
            .select("board_key, stage")
            .eq("run_id", prior.id);
          const failedBoardStages = new Set(
            (boardRows ?? [])
              .filter(
                (r) =>
                  r.stage === "failed" ||
                  r.stage === "blocked" ||
                  r.stage === "pending",
              )
              .map((r) => r.board_key),
          );
          // If we have board-stage data, require each requested board to be
          // in the failed/blocked/pending set. If run_boards has no rows
          // (older runs), fall back to the subset check above.
          const hasBoardData = (boardRows ?? []).length > 0;
          if (hasBoardData) {
            const allBoardsFailed = boards.every((b) =>
              failedBoardStages.has(b),
            );
            if (!allBoardsFailed) {
              console.warn(
                `[scrape] retry rejected for ${userId}/${searchKey}: requested board(s) did not fail in prior run`,
              );
              isRetry = false;
            }
          }
        }
      }
    }

    // ── AUTHORITATIVE USAGE ENFORCEMENT ───────────────────────
    // The backend deducts the search quota HERE (single writer), BEFORE any
    // pipeline_run is created — so a quota-rejected request leaves NO dangling
    // rows. The frontend only disables the button; this is the real check.
    // A VALIDATED retry skips the deduction (the search was already counted
    // once); anything else consumes quota.
    let usageId: string | null = null;
    if (!isRetry) {
      try {
        const usage = await consumeUsage(userId, "search", { searchKey });
        if (!usage.ok) {
          if (usage.reason === "limit_reached") {
            return {
              status: 402,
              jsonBody: { error: `LIMIT_REACHED: ${usage.message}` },
            };
          }
          return { status: 400, jsonBody: { error: usage.message } };
        }
        usageId = usage.id ?? null;
      } catch (err) {
        if (err instanceof UsageLimitReachedError) {
          return {
            status: 402,
            jsonBody: { error: `LIMIT_REACHED: ${err.message}` },
          };
        }
        throw err;
      }
    }

    // ── Create pipeline_run (subscription record) ────────────
    const { data: run, error: runErr } = await supabase
      .from("pipeline_runs")
      .insert({
        user_id: userId,
        keyword,
        search_key: searchKey,
        boards,
        country_code: countryCode,
        status: "queued",
      })
      .select("id")
      .single();

    if (runErr || !run) {
      console.error(`Failed to create pipeline_run: ${runErr?.message}`);
      return { status: 500, jsonBody: { error: "failed to create run" } };
    }
    const runId = run.id as string;
    console.info(`Created pipeline_run ${runId} for "${keyword}"`);

    // ── Ensure queues exist (idempotent; cheap in local dev) ─
    try {
      await ensureQueues();
    } catch (err) {
      console.warn(`ensureQueues warning: ${err}`);
    }

    // ── Enqueue scrape request on Service Bus ────────────────
    const message: ScrapeRequestMessage = {
      type: "scrape",
      runId,
      userId,
      keyword,
      pages,
      boards,
      countryCode,
      maxResultsPerBoard,
      retry: isRetry || undefined,
      // Pass the consumed usage row id so the worker can refund it if the
      // run ends with 0 jobs (all boards failed) — no time-window dependence.
      usageId: usageId ?? undefined,
    };

    let messageId: string;
    try {
      messageId = await enqueue("scrapeRequests", message, {
        messageId: `scrape-${runId}`,
        ttlSeconds: 3600, // 1 hour
      });
    } catch (err) {
      console.error(`[scrape] Service Bus enqueue failed: ${err}`);
      // The search quota was already deducted — refund it since the message
      // never got enqueued (no scrape actually ran).
      if (usageId != null) {
        await refundUsage(userId, "search", searchKey).catch(() => {});
      }
      // The run row exists but never got queued — leave it in `queued` with a
      // last_error so the user sees something actionable on the run page.
      try {
        await supabase
          .from("pipeline_runs")
          .update({
            status: "failed",
            last_error: `Failed to start scrape: ${String(err).slice(0, 500)}`,
            completed_at: new Date().toISOString(),
          })
          .eq("id", runId);
      } catch {
        // non-fatal — best-effort cleanup
      }
      return {
        status: 503,
        jsonBody: { error: "enqueue failed", detail: String(err) },
      };
    }

    return {
      status: 202,
      jsonBody: {
        runId,
        messageId,
        status: "queued",
        pollUrl: `/api/runs/${runId}`,
      },
    };
  },
});
