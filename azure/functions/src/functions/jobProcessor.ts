// ============================================================
//  Job processor — Service Bus queue trigger on `jobs` (Function 3)
//
//  SCRAPE-ONLY pipeline (no AI / DeepSeek).
//
//  For each job listing message:
//    1. marks job → processing
//    2. fetches the full job description (via Cloudflare proxy)
//    3. enriches (parses description into structured details)
//    4. upserts the scraped row to Supabase `jobs`
//    5. updates job status → completed
//
//  IDEMPOTENT: Service Bus is at-least-once. We dedupe by
//  upserting on (url, scraped_date, user_id) — the unique key.
// ============================================================

import { app, InvocationContext } from "@azure/functions";
import { fetchJobDetail } from "../cloudflareProxy";
import { enrichOneJob } from "../enrich";
import { canonicalizeUrl } from "../normalize";
import {
  fetchIndeedBatchDescriptionsApi,
  fetchLinkedInDescriptionApi,
  fetchOfferTodayDescriptionApi,
} from "../publicApiScrapers";
import { incrementCounters } from "../redisState";
import { bumpRunBoardCounts } from "../runBoardState";
import {
  finalizeRunIfDone,
  getSupabaseClient,
  updateJobStatusByUrl,
} from "../supabase";
import type { JobMessage } from "../types";
import { bufferWrite } from "../eventHubSink";

/**
 * Classify an error as TRANSIENT (upstream / network / anti-bot — retryable
 * via Service Bus redelivery) vs FATAL (bad data on our side — fail fast).
 * This is what keeps the run from being prematurely marked completed/failed
 * when a board or proxy has a hiccup.
 */
function isTransientError(err: unknown): boolean {
  const msg = String((err as Error)?.message ?? err).toLowerCase();
  const transient = [
    "timeout",
    "abort",
    "econnreset",
    "econnrefused",
    "eai_again",
    "socket hang up",
    "fetch failed",
    "upstream",
    "rate_limit",
    "blocked",
    "challenge",
    "dead-letter",
    "etimedout",
    "enotfound",
    "unexpected token", // a proxy returned HTML where we expected JSON
  ];
  return transient.some((t) => msg.includes(t));
}

app.serviceBusQueue("jobs", {
  queueName: "jobs",
  connection: "ServiceBus",
  handler: async (rawBody: unknown, context: InvocationContext) => {
    const body = rawBody as JobMessage;
    const { jobId, runId, userId, board, scrapedJob, keyword, scrapedDate } =
      body;

    // Canonicalize the job URL ONCE for the whole handler so every side
    // effect (status-by-url, the upsert row, the retrying/failed updates)
    // uses a stable URL. Defensive: the manual re-process path rebuilds
    // scrapedJob from the DB, and the scraper path is already canonical.
    const url = canonicalizeUrl(scrapedJob.url);

    console.info(
      `[processor] job ${jobId} (${board}): "${scrapedJob.title}" @ ${scrapedJob.company} [run ${runId}]`,
    );

    try {
      // ── 0. Mark job as processing (Realtime streams this) ──
      // Match by URL — the message jobId is a random UUID, not the
      // DB row id. The scraper pre-inserted the row with this URL.
      await updateJobStatusByUrl(url, "processing", {
        processing_started_at: new Date().toISOString(),
      });
      // Redis: track processing as a LIVE counter (incremented here,
      // decremented when the job is stored or fails).
      await incrementCounters(userId, runId, { processing: 1 }, board);
    } catch {
      // non-fatal
    }

    try {
      // ── 1. Fetch full job content ──
      // The search listing only has a short snippet. For each job
      // POST we scrape its DETAIL page to get the full description.
      let rawDetailHtml: string | undefined = scrapedJob.rawDetailHtml;

      if (!rawDetailHtml) {
        // LinkedIn + OfferToday have public guest/detail APIs that
        // bypass anti-bot blocks — use those first.
        if (board === "linkedin") {
          const jobIdMatch = scrapedJob.url.match(/\/view\/(\d+)/);
          if (jobIdMatch) {
            const desc = await fetchLinkedInDescriptionApi(
              jobIdMatch[1],
              console.log,
            );
            if (desc) rawDetailHtml = desc;
          }
        } else if (board === "offertoday") {
          const jobIdMatch = scrapedJob.url.match(/\/job\/([^/]+)/);
          if (jobIdMatch) {
            const desc = await fetchOfferTodayDescriptionApi(
              jobIdMatch[1],
              console.log,
            );
            if (desc) rawDetailHtml = desc;
          }
        } else if (board === "indeed") {
          // Indeed: batch-fetch via the RPC endpoint routed through the
          // Cloudflare proxy (single call for many jobs instead of N detail
          // fetches). The scraper worker pre-fetches these before fan-out;
          // this is a lazy fallback if a job somehow lacks rawDetailHtml.
          const jobkey = scrapedJob.url.match(/jk=([a-f0-9]{16})/)?.[1];
          if (jobkey) {
            const descs = await fetchIndeedBatchDescriptionsApi(
              [jobkey],
              console.log,
            );
            if (descs[jobkey]) rawDetailHtml = descs[jobkey];
          }
        }

        // Fallback: Cloudflare proxy / residential proxy detail fetch
        if (!rawDetailHtml) {
          const detailResult = await fetchJobDetail({
            board,
            url: scrapedJob.url,
            log: console.log,
          });
          if (detailResult.ok) rawDetailHtml = detailResult.html;
        }
      }

      // ── 2. Enrich — parse description into structured detail ──
      const enriched = enrichOneJob({
        ...scrapedJob,
        rawDetailHtml,
      });

      // ── 3. Store the scraped job (no AI analysis — scrape-only) ──
      // No DeepSeek fit analysis, cover letter, or resume generation.
      // fit / fit_score / cover_letter stay NULL so the frontend shows
      // "Not analysed" and the pipeline costs zero AI tokens.
      //
      // The normalized quality contract (structured salary + dataQuality)
      // arrives on scrapedJob._norm* (stamped by the scraper worker via
      // applyNormalized) and is persisted so every board's job has the SAME
      // enriched shape for the frontend.
      const row = {
        title: enriched.title,
        company: enriched.company,
        location: enriched.location ?? null,
        salary: enriched.salary ?? null,
        salary_min: enriched._normSalary?.min ?? null,
        salary_max: enriched._normSalary?.max ?? null,
        salary_period: enriched._normSalary?.period ?? null,
        salary_currency: enriched._normSalary?.currency ?? null,
        salary_confidence: enriched._normSalary?.confidence ?? null,
        posted_date: enriched._normPostedDate ?? enriched.postedDate ?? null,
        url,
        short_description: enriched.description ?? null,
        keyword,
        search_key: keyword.toLowerCase().replace(/\s+/g, "_"),
        scraped_date: scrapedDate,
        responsibilities: enriched.jobDetail.responsibilities,
        requirements: enriched.jobDetail.requirements,
        benefits: enriched.jobDetail.benefits,
        skills: enriched.jobDetail.skills,
        employment_type: enriched.jobDetail.employmentType ?? null,
        experience_level: enriched.jobDetail.experienceLevel ?? null,
        about_company: enriched.jobDetail.aboutCompany ?? null,
        raw_description: enriched.jobDetail.rawDescription ?? null,
        // Data-quality signals (0–100 completeness + presence flags)
        data_quality: enriched._normDataQuality
          ? {
              completeness: enriched._normDataQuality.completeness,
              has_salary: enriched._normDataQuality.hasSalary,
              has_description: enriched._normDataQuality.hasDescription,
              has_posted_date: enriched._normDataQuality.hasPostedDate,
              has_location: enriched._normDataQuality.hasLocation,
            }
          : null,
        // AI analysis fields — intentionally left null (scrape-only)
        fit: null,
        fit_score: null,
        fit_reasons: [],
        cover_letter: null,
        expected_salary: null,
        status: "completed",
        board,
        pipeline_run_id: runId,
        processing_completed_at: new Date().toISOString(),
        user_id: userId || null,
      };

      // ── WRITE-BATCHING ──
      // Instead of a direct `jobs.upsert` per job, buffer the completed
      // row. The Event Hub consumer coalesces a run's rows into ONE
      // `jobs.upsert`. Idempotent: upsert on (url, user_id) — a retry
      // re-writes the same row.
      bufferWrite({
        op: "job",
        type: "upsert",
        runId,
        userId: userId || null,
        board,
        keyword,
        url,
        row: { ...row, last_seen_at: new Date().toISOString() },
      });

      // ── 4. Update Redis counters (per-user, lightweight funnel) ──
      // Scrape-only: this job is done processing — decrement the live
      // `processing` counter. Terminal per-job state (completed/failed)
      // lives in Supabase jobs.status and streams via Realtime.
      await incrementCounters(userId, runId, { processing: -1 }, board);
      // Per-board: count the stored job so the board chip shows progress
      await bumpRunBoardCounts(runId, board, { jobs_processed: 1 }).catch(
        () => {},
      );
      // Run finalization now happens in the Event Hub consumer AFTER the
      // buffered upsert batch lands, so a run is never marked completed
      // before all its rows are committed. (No per-job finalize here.)

      console.info(
        `[processor] ✓ job ${jobId} done — buffered & stored ("${enriched.title}" @ ${enriched.company})`,
      );
    } catch (err) {
      const transient = isTransientError(err);
      console.error(
        `[processor] job ${jobId} failed (${transient ? "transient — will retry" : "fatal"}): ${err}`,
      );
      // Redis: decrement the live processing counter on failure too.
      await incrementCounters(userId, runId, { processing: -1 }, board);
      // Per-board: count the failed job.
      await bumpRunBoardCounts(runId, board, { jobs_failed: 1 }).catch(
        () => {},
      );

      if (transient) {
        // ── Transient upstream error: mark job RETRYING (NOT failed) so the
        // run isn't prematurely completed, and rethrow so Service Bus
        // redelivers (at-least-once, up to maxDeliveryCount). If a later
        // delivery succeeds, the upsert flips the row to completed.
        await updateJobStatusByUrl(url, "retrying", {
          last_error: String(err).slice(0, 500),
          processing_completed_at: new Date().toISOString(),
        }).catch(() => {});
        throw err;
      }

      // ── Fatal error (bad data on our side): fail fast — mark failed and
      // complete the message so we don't burn the remaining deliveries.
      await updateJobStatusByUrl(url, "failed", {
        last_error: String(err).slice(0, 500),
        processing_completed_at: new Date().toISOString(),
      }).catch(() => {});
      // Finalization is deferred to the Event Hub consumer (after flush).
    }
  },
});
