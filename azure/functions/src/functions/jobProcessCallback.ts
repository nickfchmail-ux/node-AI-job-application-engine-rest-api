// ============================================================
//  POST /api/jobs/{id}/process — HTTP trigger (Function 4)
//
//  Called by the Supabase Edge Function (on-job-changed) via a
//  database webhook when a job is INSERTed or UPDATEed in
//  Supabase. Authenticated with a shared secret header.
//
//  Purpose: trigger downstream steps that happen AFTER a job
//  exists — e.g. cover-letter regeneration, fit re-scoring,
//  notifications, or enqueueing a re-process on the `jobs` queue.
// ============================================================

import {
  app,
  HttpRequest,
  HttpResponseInit,
  InvocationContext,
} from "@azure/functions";
import { enqueue } from "../serviceBus";
import { getSupabaseClient } from "../supabase";
import type { JobMessage } from "../types";

app.http("job-process", {
  methods: ["POST"],
  authLevel: "anonymous", // auth handled by shared secret header (webhook from Supabase)
  route: "jobs/{id}/process",
  handler: async (
    req: HttpRequest,
    context: InvocationContext,
  ): Promise<HttpResponseInit> => {
    const log = console.log;

    // ── Auth: shared secret (same as Supabase Edge Function) ──
    const expected = process.env.AZURE_FUNCTION_WEBHOOK_SECRET;
    const provided = req.headers.get("x-webhook-secret");
    if (!expected || !provided || provided !== expected) {
      console.warn("[job-process] ⛔ Unauthorized webhook call");
      return { status: 401, jsonBody: { error: "unauthorized" } };
    }

    const jobId = req.params.id;
    if (!jobId) {
      return { status: 400, jsonBody: { error: "missing job id" } };
    }

    try {
      // ── Load the job from Supabase ──
      const supabase = getSupabaseClient();
      const { data: job, error } = await supabase
        .from("jobs")
        .select(
          "id, title, company, url, status, pipeline_run_id, user_id, scraped_date, keyword",
        )
        .eq("id", jobId)
        .maybeSingle();

      if (error) {
        console.error(`[job-process] query failed: ${error.message}`);
        return { status: 500, jsonBody: { error: "query failed" } };
      }
      if (!job) {
        return { status: 404, jsonBody: { error: "job not found" } };
      }

      console.info(
        `[job-process] job ${jobId} "${job.title}" status=${job.status} — triggering downstream step`,
      );

      // ── Decide downstream action based on current state ──
      switch (job.status) {
        case "completed":
          // Job already fully processed. Here we could regenerate a
          // cover letter, notify the user, etc. For now: acknowledge.
          console.info(
            `[job-process] job ${jobId} already completed — no-op (or notify here)`,
          );
          break;

        case "failed":
        case "processing":
        case "queued":
        default:
          // Re-enqueue for processing (idempotent — upsert dedupes).
          // This is the "kick Azure whenever a job is listed" path.
          const msg: JobMessage = {
            type: "process-job",
            jobId,
            runId: job.pipeline_run_id ?? "manual",
            userId: job.user_id ?? "",
            board: "manual",
            scrapedJob: {
              title: job.title,
              company: job.company ?? "N/A",
              location: "Hong Kong",
              url: job.url,
            },
            keyword: job.keyword ?? "",
            scrapedDate:
              job.scraped_date ?? new Date().toISOString().slice(0, 10),
          };
          await enqueue("jobs", msg, {
            messageId: `job-${jobId}-reprocess`,
            ttlSeconds: 7200,
          });
          console.info(`[job-process] job ${jobId} re-enqueued for processing`);
          break;
      }

      return { status: 200, jsonBody: { ok: true, jobId } };
    } catch (err) {
      console.error(`[job-process] error: ${err}`);
      return { status: 500, jsonBody: { error: "internal error" } };
    }
  },
});
