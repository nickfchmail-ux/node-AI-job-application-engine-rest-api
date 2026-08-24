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
import { enqueue, ensureQueues } from "../serviceBus";
import { getSupabaseClient } from "../supabase";
import type { ScrapeRequestMessage } from "../types";

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

    if (!userId) {
      return { status: 401, jsonBody: { error: "user_id is required" } };
    }

    const searchKey = keyword.toLowerCase().replace(/\s+/g, "_");

    // ── Create pipeline_run (subscription record) ────────────
    const supabase = getSupabaseClient();
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
    };

    let messageId: string;
    try {
      messageId = await enqueue("scrapeRequests", message, {
        messageId: `scrape-${runId}`,
        ttlSeconds: 3600, // 1 hour
      });
    } catch (err) {
      console.error(`[scrape] Service Bus enqueue failed: ${err}`);
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
