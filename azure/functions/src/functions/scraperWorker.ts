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
import { enqueue } from "../serviceBus";
import {
  getSupabaseClient,
  markRunCompleted,
  markRunFailed,
  markRunProcessing,
  markRunScraping,
} from "../supabase";
import type { JobMessage, ScrapedJob, ScrapeRequestMessage } from "../types";
import { recordRetryUsage, refundUsageById } from "../usage";

app.serviceBusQueue("scrape-requests", {
  queueName: "scrape-requests",
  connection: "ServiceBus",
  handler: async (rawBody: unknown, context: InvocationContext) => {
    const body = rawBody as ScrapeRequestMessage;
    const runId = body.runId;

    console.info(
      `[scraper] run ${runId}: "${body.keyword}" boards=${body.boards.join(",")} pages=${body.pages}`,
    );

    // ── Redis: create run meta + mark active (user-keyed) ──
    try {
      await setRunMeta(body.userId, runId, {
        runId,
        userId: body.userId,
        keyword: body.keyword,
        pages: body.pages,
        boards: body.boards,
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
      await runScraper(body, context);
    } catch (err) {
      const e = err as Error;
      const detail = `${e.message}\n${e.stack ?? ""}`.slice(0, 2000);
      console.error(`[scraper] run ${runId} CRASHED: ${detail}`);
      await markRunFailed(runId, detail).catch(() => {});
      throw err; // rethrow → Service Bus retry (up to maxDeliveryCount)
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

    // Fetch all pages for this board concurrently
    const pageNums = Array.from({ length: body.pages }, (_, i) => i + 1);
    const results = await Promise.allSettled(
      pageNums.map(async (page) => {
        console.info(`[scraper] step: fetching ${board} page ${page}...`);

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
            return { page, ok: true as const, jobs: apiJobs.length };
          }
          console.warn(
            `[scraper] ${board} public API empty — falling back to HTML proxy`,
          );
        }

        if (board === "linkedin") {
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
            return { page, ok: true as const, jobs: apiJobs.length };
          }
          console.warn(
            `[scraper] ${board} guest API empty — falling back to HTML proxy`,
          );
        }

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
          return {
            page,
            ok: false as const,
            error: err,
            errorType: result.error,
          };
        }

        // ── Per-board state: extracting ──
        await markBoardExtracting(runId, board, page).catch(() => {});

        try {
          const jobs = extractListings(board, result.html);
          for (const j of jobs) {
            allJobs.push({ ...j, board });
          }
          console.info(`[scraper] ${board} p${page}: ${jobs.length} jobs`);
          return { page, ok: true as const, jobs: jobs.length };
        } catch (err) {
          console.warn(`[scraper] parse error ${board} p${page}: ${err}`);
          return { page, ok: false as const, error: String(err) };
        }
      }),
    );

    // ── Collect errors from this board's pages ──
    let boardBlocked = false;
    let firstError: string | null = null;
    for (const r of results) {
      if (r.status === "rejected") {
        const msg = `board ${board}: ${String(r.reason)}`;
        boardErrors.push(msg);
        if (!firstError) firstError = msg;
      } else if (!r.value.ok) {
        boardErrors.push(r.value.error);
        if (!firstError) firstError = r.value.error;
        // Hard anti-bot → mark board blocked (retryable, not a hard fail)
        if (
          r.value.errorType === "blocked" ||
          r.value.errorType === "challenge" ||
          r.value.errorType === "rate_limited"
        ) {
          boardBlocked = true;
          await markBoardBlocked(runId, board, r.value.error).catch(() => {});
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

    // Fan out with concurrency cap
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
      await supabase
        .from("jobs")
        .upsert(
          {
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
          },
          {
            onConflict: "url,user_id",
            // Keep first-seen semantics: on conflict, DON'T overwrite
            // scraped_date (first-seen folder name) — just refresh
            // last_seen_at + status so cross-day re-searches dedupe.
            ignoreDuplicates: false,
          },
        )
        .then(({ error }) => {
          if (error)
            console.warn(`[scraper] pre-insert job failed: ${error.message}`);
        });
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
}
