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
import {
  fetchLinkedInDescriptionApi,
  fetchOfferTodayDescriptionApi,
} from "../publicApiScrapers";
import { incrementCounters } from "../redisState";
import { getSupabaseClient, updateJobStatusByUrl } from "../supabase";
import type { JobMessage } from "../types";

app.serviceBusQueue("jobs", {
  queueName: "jobs",
  connection: "ServiceBus",
  handler: async (rawBody: unknown, context: InvocationContext) => {
    const body = rawBody as JobMessage;
    const { jobId, runId, userId, board, scrapedJob, keyword, scrapedDate } =
      body;

    console.info(
      `[processor] job ${jobId} (${board}): "${scrapedJob.title}" @ ${scrapedJob.company} [run ${runId}]`,
    );

    try {
      // ── 0. Mark job as processing (Realtime streams this) ──
      // Match by URL — the message jobId is a random UUID, not the
      // DB row id. The scraper pre-inserted the row with this URL.
      await updateJobStatusByUrl(scrapedJob.url, "processing", {
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
      const row = {
        title: enriched.title,
        company: enriched.company,
        location: enriched.location ?? null,
        salary: enriched.salary ?? null,
        posted_date: enriched.postedDate ?? null,
        url: enriched.url,
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

      const supabase = getSupabaseClient();

      const { data: upserted, error } = await supabase
        .from("jobs")
        .upsert(row, { onConflict: "url,scraped_date,user_id" })
        .select("id");

      if (error) {
        console.error(
          `[processor] upsert failed for job ${jobId}: ${error.message}`,
        );
        throw error; // triggers Service Bus retry (maxDeliveryCount)
      }

      // ── 4. Update Redis counters (per-user, lightweight funnel) ──
      // Scrape-only: this job is done processing — decrement the live
      // `processing` counter. Terminal per-job state (completed/failed)
      // lives in Supabase jobs.status and streams via Realtime.
      await incrementCounters(userId, runId, { processing: -1 }, board);

      console.info(
        `[processor] ✓ job ${jobId} done — scraped & stored ("${enriched.title}" @ ${enriched.company})`,
      );
    } catch (err) {
      console.error(`[processor] job ${jobId} failed: ${err}`);
      await updateJobStatusByUrl(scrapedJob.url, "failed", {
        processing_completed_at: new Date().toISOString(),
      }).catch(() => {});
      // Redis: decrement the live processing counter on failure too
      await incrementCounters(userId, runId, { processing: -1 }, board);
      throw err; // rethrow → Service Bus delivers again (at-least-once) up to maxDeliveryCount
    }
  },
});
