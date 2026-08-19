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
import { fetchBoardPage } from "../cloudflareProxy";
import { scrapeLinkedInApi, scrapeOfferTodayApi } from "../publicApiScrapers";
import { incrementCounters, setRunMeta } from "../redisState";
import { enqueue } from "../serviceBus";
import {
  getSupabaseClient,
  markRunFailed,
  markRunProcessing,
  markRunScraping,
} from "../supabase";
import type { JobMessage, ScrapedJob, ScrapeRequestMessage } from "../types";

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

  for (const board of body.boards) {
    for (let page = 1; page <= body.pages; page++) {
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
          // Redis: record scraped listings per board
          await incrementCounters(
            body.userId,
            runId,
            { scraped: apiJobs.length },
            board,
          );
          continue;
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
          // Redis: record scraped listings per board
          await incrementCounters(
            body.userId,
            runId,
            { scraped: apiJobs.length },
            board,
          );
          continue;
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
        boardErrors.push(err);
        continue; // skip this board/page, continue others
      }

      try {
        const jobs = extractListings(board, result.html);
        for (const j of jobs) {
          allJobs.push({ ...j, board });
        }
        console.info(`[scraper] ${board} p${page}: ${jobs.length} jobs`);
        // Redis: record scraped listings per board
        await incrementCounters(
          body.userId,
          runId,
          { scraped: jobs.length },
          board,
        );
      } catch (err) {
        console.warn(`[scraper] parse error ${board} p${page}: ${err}`);
      }
    }
  }

  if (allJobs.length === 0) {
    const reason =
      boardErrors.length > 0
        ? `All boards failed: ${boardErrors.join("; ")}`
        : "No jobs found for this keyword.";
    console.warn(`[scraper] run ${runId} — no jobs: ${reason}`);
    await markRunFailed(runId, reason);
    return;
  }

  // ── Dedupe against existing Supabase jobs (by URL + title|company) ───────
  // Fetch ALL existing rows for this user into a Set (url) + Map (title|company)
  // so we can filter new jobs in O(1) instead of N lookups.
  const supabase = getSupabaseClient();
  const existingUrls = new Set<string>();
  const existingTitleCompany = new Map<string, string>(); // key -> url

  let from = 0;
  const PAGE_SIZE = 1000;
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
    const { data } = await query;
    if (!data || data.length === 0) break;
    for (const r of data) {
      existingUrls.add(r.url);
      existingTitleCompany.set(`${r.title}|||${r.company}`, r.url);
    }
    from += data.length;
    if (data.length < PAGE_SIZE) break;
  }

  // Filter: keep jobs whose URL is new AND whose title|company is new
  const unique = allJobs.filter((j) => {
    if (existingUrls.has(j.url)) return false;
    if (existingTitleCompany.has(`${j.title}|||${j.company}`)) return false;
    return true;
  });
  const skipped = allJobs.length - unique.length;
  if (skipped > 0) {
    console.info(
      `[scraper] run ${runId} — skipped ${skipped} already-known job(s)`,
    );
    // Redis: count duplicates (already-exist) so the frontend shows the funnel
    await incrementCounters(body.userId, runId, { duplicate: skipped });
  }

  if (unique.length === 0) {
    await markRunFailed(runId, "All scraped jobs already exist in database.");
    return;
  }

  const scrapedDate = new Date().toISOString().slice(0, 10);

  // ── Fan out one message per job (PARALLEL with concurrency cap) ──
  // Pre-inserts "queued" rows + enqueues Service Bus messages concurrently
  // so the scraper worker isn't blocked on each job sequentially.
  const CONCURRENCY = 10;
  let cursor = 0;
  const jobsToFanOut = unique;

  async function fanOutOne(job: (typeof jobsToFanOut)[number]): Promise<void> {
    const jobId = crypto.randomUUID();
    const msg: JobMessage = {
      type: "process-job",
      jobId,
      runId,
      userId: body.userId,
      board: job.board,
      scrapedJob: {
        title: job.title,
        company: job.company,
        location: job.location,
        salary: job.salary,
        postedDate: job.postedDate,
        url: job.url,
        description: job.description,
        rawDetailHtml: job.rawDetailHtml,
        source: job.board,
      },
      keyword: body.keyword,
      scrapedDate,
    };

    // Pre-insert a "queued" row so the frontend sees jobs stream in via Realtime
    await supabase
      .from("jobs")
      .upsert(
        {
          title: job.title,
          company: job.company,
          location: job.location ?? null,
          salary: job.salary ?? null,
          posted_date: job.postedDate ?? null,
          url: job.url,
          short_description: job.description ?? null,
          keyword: body.keyword,
          search_key: body.keyword.toLowerCase().replace(/\s+/g, "_"),
          scraped_date: scrapedDate,
          status: "queued",
          board: job.board,
          pipeline_run_id: runId,
          user_id: body.userId || null,
        },
        { onConflict: "url,scraped_date,user_id" },
      )
      .then(({ error }) => {
        if (error)
          console.warn(`[scraper] pre-insert job failed: ${error.message}`);
      });

    await enqueue("jobs", msg, {
      messageId: `job-${jobId}`,
      ttlSeconds: 7200,
    });
    // NOTE: `processing` is NOT stored in Redis — it is derived on read
    // as (unique - analysed - failed), clamped ≥ 0, so it cannot drift.
  }

  // Run up to CONCURRENCY fan-outs at a time
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (cursor < jobsToFanOut.length) {
      const job = jobsToFanOut[cursor++];
      try {
        await fanOutOne(job);
      } catch (err) {
        console.warn(`[scraper] fan-out job failed: ${err}`);
      }
    }
  });
  await Promise.all(workers);

  console.info(
    `[scraper] run ${runId} — enqueued ${unique.length} job(s) to process`,
  );
  await markRunProcessing(runId);
}
