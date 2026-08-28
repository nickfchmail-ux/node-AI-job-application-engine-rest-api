// ============================================================
//  Scraper worker — Service Bus queue trigger on `scrape-requests`
//  (Function 2)
//
//  For each scrape request:
//    1. marks run → scraping
//    2. fetches each board page via the Cloudflare proxy
//    3. extracts job listings from HTML (board-specific parsers)
//    4. dedupes by URL against Supabase `jobs`
//    5. enqueues one `jobs` Service Bus message per listing
//    6. marks run → processing (or completed if none)
// ============================================================

import { app, InvocationContext } from "@azure/functions";
import { extractListings } from "../boardParsers";
import { getBoardPattern } from "../boardRegistry";
import { fetchBoardPage } from "../cloudflareProxy";
import { applyNormalized, canonicalizeUrl, normalizeJobs } from "../normalize";
import {
  fetchIndeedBatchDescriptionsApi,
  scrapeLinkedInApi,
  scrapeOfferTodayApi,
} from "../publicApiScrapers";
import { incrementCounters, setRunMeta } from "../redisState";
import {
  markBoardBlocked,
  markBoardDone,
  markBoardExtracting,
  markBoardFailed,
  markBoardFetching,
} from "../runBoardState";
import { enqueue } from "../storageQueue";
import {
  getSupabaseClient,
  markRunCompleted,
  markRunFailed,
  markRunProcessing,
  markRunScraping,
} from "../supabase";
import type {
  JobMessage,
  RunSelfHealMessage,
  ScrapedJob,
  ScrapeRequestMessage,
} from "../types";
import { recordRetryUsage, refundUsageById } from "../usage";

app.storageQueue("scrape-requests", {
  queueName: "scrape-requests",
  connection: "AzureWebJobsStorage",
  handler: async (rawBody: unknown, context: InvocationContext) => {
    // Wrap the ENTIRE body so ANY error (including JSON.parse or a missing
    // field) is captured, logged, and recorded on the run — never a silent
    // crash to the poison queue with no trace.
    try {
      const rawStr =
        typeof rawBody === "string"
          ? rawBody
          : typeof rawBody === "object" && rawBody !== null
            ? JSON.stringify(rawBody)
            : String(rawBody ?? "");
      let body: ScrapeRequestMessage;
      try {
        body = JSON.parse(rawStr) as ScrapeRequestMessage;
      } catch {
        body = rawBody as ScrapeRequestMessage;
      }
      const runId = body.runId;
      const boards = Array.isArray(body.boards) ? body.boards : [];

      console.info(
        `[scraper] run ${runId}: "${body.keyword}" boards=${boards.join(",")} pages=${body.pages} rawType=${typeof rawBody}`,
      );

      // ── Redis: create run meta + mark active (user-keyed) ──
      try {
        await setRunMeta(body.userId, runId, {
          runId,
          userId: body.userId,
          keyword: body.keyword,
          pages: body.pages,
          boards,
          countryCode: body.countryCode ?? null,
          createdAt: new Date().toISOString(),
        });
      } catch {
        // non-fatal
      }

      try {
        await markRunScraping(runId);
      } catch {
        // non-fatal — supabase helper logs
      }

      try {
        await runScraper({ ...body, boards }, context);
      } catch (err) {
        const e = err as Error;
        const detail = `${e.message}\n${e.stack ?? ""}`.slice(0, 2000);
        console.error(`[scraper] run ${runId} CRASHED: ${detail}`);
        console.error(
          `[scraper] rawBody type=${typeof rawBody} isStr=${
            typeof rawBody === "string"
          }`,
        );
        await markRunFailed(runId, detail).catch(() => {});
        throw err; // rethrow → Storage Queue retry (up to maxDequeueCount)
      }
    } catch (outerErr) {
      const e = outerErr as Error;
      console.error(
        `[scraper] FATAL pre-parse error: ${e.message}\n${e.stack ?? ""}`,
      );
      console.error(`[scraper] rawBody: ${String(rawBody).slice(0, 500)}`);
      throw outerErr; // rethrow → Storage Queue retry (up to maxDequeueCount)
    }
  },
});

async function runScraper(
  body: ScrapeRequestMessage,
  context: InvocationContext,
): Promise<void> {
  const runId = body.runId;

  const allJobs: (ScrapedJob & { board: string })[] = [];
  const boardErrors: string[] = [];

  // ── Fetch ALL boards in PARALLEL (async — no waiting 30s per board) ──
  // Each board is an independent unit of work (own proxy/ScraperAPI calls),
  // so we run them concurrently. Within a board, its pages are also fetched
  // concurrently. This collapses the wall-clock time from
  //   boards × pages × (proxy/ScraperAPI latency)
  // down to roughly ONE page-fetch latency.
  const BOARDS_IN_PARALLEL = Math.max(
    1,
    Number(process.env.BOARDS_IN_PARALLEL ?? 5),
  );

  const fetchOneBoard = async (board: string): Promise<void> => {
    const pattern = getBoardPattern(board);
    const displayName = pattern?.displayName ?? board;

    // ── Per-board state: fetching ──
    await markBoardFetching(runId, board, body.pages).catch(() => {});

    // ── Fetch pages SEQUENTIALLY with early-exit on hard anti-bot failure ──
    // Page 1 is fetched first; if it hits a hard anti-bot error
    // (blocked/challenge/rate_limited), pages 2+ WILL fail identically, so we
    // STOP and don't waste proxy/ScraperAPI credits + wall-clock time fetching
    // them. Public-API boards (offertoday/linkedin) are still sequential but
    // cheap. This also avoids tripping rate-limits by bursting all pages at once.
    const pageNums = Array.from({ length: body.pages }, (_, i) => i + 1);
    const results: (
      | {
          status: "fulfilled";
          value: {
            page: number;
            ok: boolean;
            jobs?: number;
            error?: string;
            errorType?: string;
          };
        }
      | { status: "rejected"; reason: unknown }
    )[] = [];
    const HARD_STOP_ERRORS = new Set(["blocked", "challenge", "rate_limited"]);

    for (const page of pageNums) {
      console.info(`[scraper] step: fetching ${board} page ${page}...`);
      let pageResult:
        | {
            page: number;
            ok: boolean;
            jobs?: number;
            error?: string;
            errorType?: string;
          }
        | undefined;

      // ── Public API fast paths (bypass anti-bot HTML blocks) ──
      if (board === "offertoday") {
        const apiJobs = await scrapeOfferTodayApi(
          body.keyword,
          page,
          console.log,
        );
        if (apiJobs.length > 0) {
          for (const j of apiJobs) allJobs.push({ ...j, board });
          console.info(
            `[scraper] ${board} p${page}: ${apiJobs.length} jobs (via public API)`,
          );
          pageResult = { page, ok: true, jobs: apiJobs.length };
        } else {
          console.warn(
            `[scraper] ${board} public API empty — falling back to HTML proxy`,
          );
        }
      }

      if (!pageResult && board === "linkedin") {
        const apiJobs = await scrapeLinkedInApi(
          body.keyword,
          page,
          console.log,
        );
        if (apiJobs.length > 0) {
          for (const j of apiJobs) allJobs.push({ ...j, board });
          console.info(
            `[scraper] ${board} p${page}: ${apiJobs.length} jobs (via guest API)`,
          );
          pageResult = { page, ok: true, jobs: apiJobs.length };
        } else {
          console.warn(
            `[scraper] ${board} guest API empty — falling back to HTML proxy`,
          );
        }
      }

      if (!pageResult) {
        const result = await fetchBoardPage({
          board,
          keyword: body.keyword,
          page,
          countryCode: body.countryCode,
          log: console.log,
        });
        console.info(
          `[scraper] step: fetch ${board} p${page} returned ok=${result.ok}`,
        );

        if (!result.ok) {
          const err = `board ${board} page ${page}: ${result.error}${result.detail ? ` (${result.detail})` : ""}`;
          console.warn(`[scraper] ${err}`);
          pageResult = {
            page,
            ok: false,
            error: err,
            errorType: result.error,
          };
        } else {
          // ── Per-board state: extracting ──
          await markBoardExtracting(runId, board, page).catch(() => {});
          try {
            const jobs = extractListings(board, result.html);
            for (const j of jobs) {
              allJobs.push({ ...j, board });
            }
            console.info(`[scraper] ${board} p${page}: ${jobs.length} jobs`);
            pageResult = { page, ok: true, jobs: jobs.length };
          } catch (err) {
            console.warn(`[scraper] parse error ${board} p${page}: ${err}`);
            pageResult = { page, ok: false, error: String(err) };
          }
        }
      }

      results.push({ status: "fulfilled", value: pageResult });
      // Early-exit: a hard anti-bot failure on THIS page means remaining pages
      // will fail the same way — stop fetching them.
      if (pageResult && !pageResult.ok && pageResult.errorType) {
        if (HARD_STOP_ERRORS.has(pageResult.errorType)) {
          console.info(
            `[scraper] ${board} hit ${pageResult.errorType} on page ${page} — skipping pages ${page + 1}-${body.pages} (identical failure)`,
          );
          break;
        }
      }
    }

    // ── Collect errors from this board's pages ──
    let boardBlocked = false;
    let firstError: string | null = null;
    for (const r of results) {
      if (r.status === "rejected") {
        const msg = `board ${board}: ${String(r.reason)}`;
        boardErrors.push(msg);
        if (!firstError) firstError = msg;
      } else if (!r.value.ok) {
        const err =
          r.value.error ?? `board ${board} page ${r.value.page} failed`;
        const errType = r.value.errorType;
        boardErrors.push(err);
        if (!firstError) firstError = err;
        // Hard anti-bot → mark board blocked (retryable, not a hard fail)
        if (
          errType === "blocked" ||
          errType === "challenge" ||
          errType === "rate_limited"
        ) {
          boardBlocked = true;
          await markBoardBlocked(runId, board, err).catch(() => {});
        }
      }
    }

    // ── Per-board state: done (or failed if it errored) ──
    const boardJobs = allJobs.filter((j) => j.board === board);
    if (boardJobs.length > 0) {
      // Some pages may have failed while others succeeded → still done.
      await markBoardDone(runId, board, { jobs_found: boardJobs.length }).catch(
        () => {},
      );
    } else if (boardBlocked) {
      // Already marked blocked above — ensure last_error is set.
      await markBoardBlocked(
        runId,
        board,
        firstError ?? "anti-bot block",
      ).catch(() => {});
    } else if (firstError) {
      await markBoardFailed(runId, board, firstError).catch(() => {});
    } else {
      await markBoardFailed(runId, board, "no jobs found on this board").catch(
        () => {},
      );
    }
  };

  // ── Run boards concurrently, fanning out each board's jobs AS IT FINISHES ──
  // Fast boards (jobsdb, ctgoodjobs, offertoday, linkedin) fan out immediately
  // while the slow ScraperAPI board (indeed) is still fetching — so users see
  // results appear without waiting ~30-60s for the slowest board.
  const scrapedDate = new Date().toISOString().slice(0, 10);
  const supabase = getSupabaseClient();
  let totalEnqueued = 0;

  // Dedupe a board's jobs against existing Supabase rows (shared across boards).
  const existingUrls = new Set<string>();
  const existingTitleCompany = new Map<string, string>();
  let existingLoaded = false;
  const loadExisting = async () => {
    if (existingLoaded) return;
    existingLoaded = true;
    let from = 0;
    const PAGE_SIZE = 1000;
    try {
      for (;;) {
        let query = supabase
          .from("jobs")
          .select("url, title, company")
          .range(from, from + PAGE_SIZE - 1);
        if (body.userId) {
          query = query.eq("user_id", body.userId);
        } else {
          query = query.is("user_id", null);
        }
        const { data, error } = await query;
        if (error) {
          // Non-fatal: if dedupe data can't load, proceed with an empty set
          // (jobs may get duplicated but the run won't crash).
          console.warn(
            `[scraper] loadExisting failed (from=${from}): ${error.message}`,
          );
          break;
        }
        if (!data || data.length === 0) break;
        for (const r of data) {
          // Canonicalize stored URLs so the in-memory dedup set matches the
          // canonical URLs the fan-out now produces (and persists).
          const cu = canonicalizeUrl(r.url);
          existingUrls.add(cu);
          existingTitleCompany.set(`${r.title}|||${r.company}`, cu);
        }
        from += data.length;
        if (data.length < PAGE_SIZE) break;
      }
    } catch (err) {
      console.warn(`[scraper] loadExisting crashed: ${err}`);
    }
  };

  // Fan out ONE board's normalized jobs (pre-insert + enqueue, capped concurrency).
  const fanOutBoardJobs = async (
    boardJobs: (ScrapedJob & { board: string })[],
  ): Promise<number> => {
    if (boardJobs.length === 0) return 0;
    await loadExisting();

    // Canonicalize every URL BEFORE the dedup filter so the in-memory
    // `existingUrls.has(...)` check AND the persisted `url` are stable
    // across runs (tracking params / query order / trailing slash / host
    // case no longer silently break the match). Canonicalization is pure
    // and defensive — it never throws, and normalizeJob below re-applies it.
    for (const j of boardJobs) {
      j.url = canonicalizeUrl(j.url);
    }

    const unique = boardJobs.filter((j) => {
      if (existingUrls.has(j.url)) return false;
      if (existingTitleCompany.has(`${j.title}|||${j.company}`)) return false;
      return true;
    });
    const skipped = boardJobs.length - unique.length;
    if (skipped > 0) {
      console.info(
        `[scraper] ${boardJobs[0].board} — skipped ${skipped} already-known job(s)`,
      );
      // Board-scoped counter — writes the per-board Redis key
      // `{board}:duplicate` so the board chip's "Dup" column is correct.
      await incrementCounters(
        body.userId,
        runId,
        { duplicate: skipped },
        boardJobs[0].board,
      );
      await markBoardDone(runId, boardJobs[0].board, {
        duplicate: skipped,
      }).catch(() => {});
    }
    if (unique.length === 0) return 0;

    // ── Per-board result cap (after dedup) ──────────────────
    // Free=5, Standard=10, Pro=∞ (undefined). Because dedup already removed
    // every URL this user has seen, a REPEATED search with the same keyword
    // returns the NEXT `maxResultsPerBoard` new URLs per board — i.e. each
    // repeat search advances the user through the board's results.
    if (
      typeof body.maxResultsPerBoard === "number" &&
      body.maxResultsPerBoard > 0
    ) {
      const cap = body.maxResultsPerBoard;
      if (unique.length > cap) {
        const dropped = unique.length - cap;
        unique.splice(cap); // keep the first `cap`, drop the rest
        console.info(
          `[scraper] ${boardJobs[0].board} — capped results to ${cap} (dropped ${dropped} beyond plan limit)`,
        );
      }
    }

    // Report the CAPPED count to the socket — this is what's actually saved,
    // so the UI headline never claims more than the plan allows. `scraped` =
    // total kept, `unique` = new jobs enqueued (both equal after the cap).
    if (unique.length > 0) {
      await incrementCounters(
        body.userId,
        runId,
        { scraped: unique.length, unique: unique.length },
        boardJobs[0].board,
      );
    }

    // Register these as seen so a later board doesn't re-fan them
    for (const j of unique) {
      existingUrls.add(j.url);
      existingTitleCompany.set(`${j.title}|||${j.company}`, j.url);
    }

    // Batch-fetch Indeed descriptions (RPC via proxy → ScraperAPI fallback)
    const indeedJobs = unique.filter((j) =>
      j.url.includes("indeed.com/viewjob"),
    );
    if (indeedJobs.length > 0) {
      console.info(
        `[scraper] ⚡ Batch-fetching ${indeedJobs.length} Indeed description(s)...`,
      );
      const jobkeyMap = new Map<string, ScrapedJob>();
      for (const j of indeedJobs) {
        const match = j.url.match(/jk=([a-f0-9]{16})/);
        if (match) jobkeyMap.set(match[1], j);
      }
      try {
        const descriptions = await fetchIndeedBatchDescriptionsApi(
          [...jobkeyMap.keys()],
          console.log,
        );
        let attached = 0;
        for (const [key, html] of Object.entries(descriptions)) {
          const job = jobkeyMap.get(key);
          if (job && html) {
            job.rawDetailHtml = html;
            attached++;
          }
        }
        console.info(
          `[scraper] ✅ Pre-fetched ${attached}/${indeedJobs.length} Indeed description(s).`,
        );
      } catch (err) {
        console.warn(`[scraper] ⚠ Indeed batch fetch failed: ${err}`);
      }
    }

    // Normalize to the frontend-facing shape
    const normalized = normalizeJobs(unique, { defaultLocation: "Hong Kong" });
    if (normalized.length === 0) return 0;

    // ── WRITE-BATCHING: per-board synchronous pre-insert ──────
    // Build ALL of this board's normalized rows, then do ONE
    // `jobs.upsert(rows[])` for the whole board (instead of N per-job
    // upserts). This is done BEFORE enqueueing the Service Bus messages
    // so the job processor + finalizeRunIfDone always see the committed
    // pre-insert rows — no ordering race.
    const preinsertRows = normalized.map((job) => ({
      title: job.title,
      company: job.company,
      location: job.location ?? null,
      salary: job.salaryDisplay ?? null,
      posted_date: job.postedDate ?? null,
      url: job.url,
      short_description: job.description ?? null,
      keyword: body.keyword,
      search_key: body.keyword.toLowerCase().replace(/\s+/g, "_"),
      scraped_date: scrapedDate,
      last_seen_at: new Date().toISOString(),
      status: "queued",
      board: job.board,
      pipeline_run_id: runId,
      user_id: body.userId || null,
    }));
    try {
      const { error } = await supabase
        .from("jobs")
        .upsert(preinsertRows, {
          onConflict: "url,user_id",
          // Keep first-seen semantics: on conflict, DON'T overwrite
          // scraped_date (first-seen folder name) — just refresh
          // last_seen_at + status so cross-day re-searches dedupe.
          ignoreDuplicates: false,
        })
        .select("id");
      if (error) {
        console.warn(
          `[scraper] board ${boardJobs[0].board} pre-insert batch (${preinsertRows.length}) failed: ${error.message}`,
        );
      } else {
        console.info(
          `[scraper] board ${boardJobs[0].board} — pre-inserted ${preinsertRows.length} row(s) in ONE upsert`,
        );
      }
    } catch (err) {
      console.warn(
        `[scraper] board ${boardJobs[0].board} pre-insert batch threw: ${err}`,
      );
    }

    // Fan out with concurrency cap (enqueue only — rows already in DB).
    const CONCURRENCY = 10;
    let cursor = 0;
    const fanOutOne = async (job: (typeof normalized)[number]) => {
      const jobId = crypto.randomUUID();
      const transportJob = applyNormalized(
        {
          title: job.title,
          company: job.company,
          location: job.location,
          salary: job.salaryDisplay ?? undefined,
          postedDate: job.postedDate ?? undefined,
          url: job.url,
          description: job.description ?? undefined,
          rawDetailHtml: job.rawDetailHtml,
          source: job.board,
        },
        job,
      );
      const msg: JobMessage = {
        type: "process-job",
        jobId,
        runId,
        userId: body.userId,
        board: job.board,
        scrapedJob: transportJob,
        keyword: body.keyword,
        scrapedDate,
      };
      await enqueue("jobs", msg, {
        messageId: `job-${jobId}`,
        ttlSeconds: 7200,
      });
    };

    const fanWorkers = Array.from({ length: CONCURRENCY }, async () => {
      while (cursor < normalized.length) {
        const job = normalized[cursor++];
        try {
          await fanOutOne(job);
        } catch (err) {
          console.warn(`[scraper] fan-out job failed: ${err}`);
        }
      }
    });
    await Promise.all(fanWorkers);
    return normalized.length;
  };

  // Fetch each board and fan out its jobs as soon as it completes.
  const boardQueue = [...body.boards];
  const boardWorkers = Array.from(
    { length: Math.min(BOARDS_IN_PARALLEL, boardQueue.length) },
    async () => {
      while (boardQueue.length > 0) {
        const board = boardQueue.shift()!;
        // Capture the board's own jobs snapshot (safely, since allJobs is shared)
        const before = allJobs.length;
        try {
          await fetchOneBoard(board);
        } catch (err) {
          // A single board crashing must never kill the whole run — record
          // the failure, mark the board failed, and continue with the rest.
          const msg = `board ${board} crashed: ${err}`;
          console.error(`[scraper] ${msg}`);
          boardErrors.push(msg);
          await markBoardFailed(runId, board, String(err)).catch(() => {});
        }
        const boardJobs = allJobs
          .slice(before)
          .filter((j) => j.board === board);
        const n = await fanOutBoardJobs(boardJobs).catch((err) => {
          console.warn(`[scraper] fanOutBoardJobs(${board}) failed: ${err}`);
          return 0;
        });
        totalEnqueued += n;
        console.info(`[scraper] ${board} — enqueued ${n} job(s)`);
      }
    },
  );
  await Promise.all(boardWorkers);

  if (allJobs.length === 0) {
    // Distinguish "every board was blocked / failed" (retryable) from a
    // genuinely empty keyword (no matches anywhere).
    const blockedCount = boardErrors.filter((e) =>
      /blocked|challenge|rate_limited/.test(e),
    ).length;
    const reason =
      boardErrors.length > 0
        ? blockedCount > 0
          ? `Job boards were busy — ${blockedCount} of ${body.boards.length} boards couldn't be reached (anti-bot/rate-limit). Try again in a moment.`
          : `All boards failed: ${boardErrors.join("; ")}`
        : "No jobs found for this keyword.";
    console.warn(`[scraper] run ${runId} — no jobs: ${reason}`);

    // ── REFUND the search credit ─────────────────────────────
    // A NON-retry run had its search quota consumed UPFRONT at the HTTP
    // trigger. If it delivered 0 jobs (every board failed / nothing found),
    // the user got nothing for their credit — refund it so they don't lose
    // their only search to a transient outage. Retries never had an upfront
    // deduction (they only record on success), so nothing to refund there.
    if (!body.retry && body.usageId) {
      await refundUsageById(body.usageId, body.userId, "search").catch(
        () => {},
      );
      console.info(
        `[scraper] run ${runId} — refunded search credit (${body.usageId}) — 0 jobs delivered`,
      );
    }

    await markRunFailed(runId, reason);
    return;
  }

  console.info(
    `[scraper] run ${runId} — enqueued ${totalEnqueued} job(s) to process`,
  );

  // ── REFUND if nothing new was delivered ─────────────────────
  // Covers BOTH the "0 jobs found/failed" case (allJobs.length===0, handled
  // above) AND the "found but all duplicates" case (allJobs.length>0 but
  // totalEnqueued===0 — every listing already in the user's list). Either
  // way the user got 0 NEW jobs for their credit, so refund it. This prevents
  // a limited user's only search being burned on a re-search that surfaces
  // nothing new. Retries never had an upfront deduction — nothing to refund.
  if (!body.retry && body.usageId && totalEnqueued === 0) {
    await refundUsageById(body.usageId, body.userId, "search").catch(() => {});
    console.info(
      `[scraper] run ${runId} — refunded search credit (${body.usageId}) — 0 new jobs delivered`,
    );
  }

  // ── Terminal state when NOTHING was enqueued ────────────────
  // If 0 jobs were enqueued (every listing was a duplicate), there is nothing
  // for the job processor to work on — so the run would otherwise stay stuck
  // in "processing" forever and the UI would hang on "Finding jobs…". Mark it
  // COMPLETED so the frontend transitions to the "0 new jobs saved" state.
  if (totalEnqueued === 0) {
    console.info(
      `[scraper] run ${runId} — 0 new jobs enqueued (all duplicates or empty); marking completed`,
    );
    await markRunCompleted(runId, {
      total: 0,
      processed: 0,
      failed: 0,
      fit: 0,
    }).catch((err) => {
      console.warn(`[scraper] markRunCompleted failed: ${err}`);
    });
    return;
  }

  // ── Quota on SUCCESSFUL retry ─────────────────────────────
  // The scrape HTTP trigger SKIPS the search-quota deduction for retries (so
  // a failed retry never burns a limited user's search). But the user wants
  // the retry to count quota IF it actually succeeds. A retry "succeeds" when
  // at least one NEW job was enqueued (totalEnqueued > 0). Record the usage
  // row here — best-effort; the scrape trigger already validated the user.
  if (body.retry && totalEnqueued > 0) {
    try {
      await recordRetryUsage(body.userId, "search", body.keyword);
      console.info(
        `[scraper] run ${runId} — retry succeeded (${totalEnqueued} jobs), search quota counted`,
      );
    } catch (err) {
      console.warn(`[scraper] retry usage record failed: ${err}`);
    }
  }

  await markRunProcessing(runId);

  // ── EVENT-DRIVEN self-heal (NOT a timer) ─────────────────────
  // One-shot delayed check for THIS run: ~90s after the worker finishes, a
  // `run-self-heal` message becomes visible on the `self-heal` queue. When it
  // fires, recover-stuck-runs re-enqueues any jobs that were enqueued but
  // NEVER delivered (lost message / worker crash). This is event-driven —
  // ONE message per run, fires once, then gone. It never keeps the Function
  // App warm or costs money when idle (unlike a recurring timer).
  // NOTE: uses the SEPARATE `self-heal` queue, NOT `jobs` — two storage-queue
  // triggers on `jobs` would split messages and recover-stuck-runs would
  // swallow process-job messages, leaving jobs stuck at `queued`.
  try {
    const healMsg: RunSelfHealMessage = {
      type: "run-self-heal",
      runId,
      userId: body.userId,
    };
    // Delayed delivery so the job processor has time to work the queue
    // normally; the self-heal only steps in if jobs are STILL stuck.
    const delayMs = Number(process.env.SELF_HEAL_DELAY_MS ?? 90_000);
    await enqueue("selfHeal", healMsg, {
      messageId: `run-self-heal-${runId}`,
      ttlSeconds: 3600,
      scheduledEnqueueTimeUtc: new Date(Date.now() + delayMs),
    });
    console.info(
      `[scraper] run ${runId} — scheduled one-shot self-heal check (+${delayMs}ms)`,
    );
  } catch (err) {
    console.warn(`[scraper] run ${runId} self-heal enqueue failed: ${err}`);
  }
}
