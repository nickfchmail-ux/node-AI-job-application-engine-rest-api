// ============================================================
//  recover-stuck-runs — Service Bus queue trigger (Function 6)
//
//  EVENT-DRIVEN self-heal for runs that get stuck in a
//  non-terminal state (queued / scraping / processing / retrying)
//  because one or more jobs never reached a terminal state
//  (completed / failed / duplicate / analysed).
//
//  WHY THIS EXISTS:
//    A run can be left "processing" forever when a Service Bus
//    `jobs` message is lost (worker crash, poison message, TTL
//    expiry, transient egress outage) — the job stays `queued`,
//    and `finalizeRunIfDone` refuses to complete the run because
//    that job is non-terminal. The dashboard then shows the run
//    as "Searching… / In line…" forever (e.g. "13h ago" with no
//    change).
//
//  WHY A QUEUE TRIGGER (NOT A TIMER):
//    The scraper worker enqueues ONE `run-self-heal` message per
//    run, with a ~90s scheduled delay. When it becomes visible,
//    THIS function runs once for that run. There is no recurring
//    timer, so the Function App stays cold and costs nothing when
//    idle — the self-heal only costs when a run actually happened.
//
//  WHAT IT DOES (per self-heal message, idempotent):
//    1. Loads the run. If it's already terminal, no-op.
//    2. Lists the run's jobs that are still `queued`/`processing`
//       (orphaned — never delivered).
//    3. Re-enqueues those orphaned jobs to the Service Bus
//       `jobs` queue (duplicate-detection prevents double work;
//       the processor is idempotent by url).
//    4. If the run's jobs are ALL terminal but the run is still
//       non-terminal, finalize it to `completed` (or `failed`
//       if every job failed).
//    5. Marks the run `retrying` so the UI shows a live
//       "Retrying…" state instead of a frozen "In line…".
//
//  SAFETY:
//    - Only acts on the run named in the message (never a live
//      unrelated run).
//    - Uses Service Bus duplicate detection (messageId) so a
//      re-enqueued job can't be processed twice.
//    - Best-effort: every failure is logged and swallowed.
// ============================================================

import { app, InvocationContext } from "@azure/functions";
import { enqueue } from "../serviceBus";
import { getSupabaseClient } from "../supabase";
import type { JobMessage, RunSelfHealMessage } from "../types";

/** Max orphaned jobs to re-enqueue per run. */
const MAX_JOBS_PER_RUN = Number(process.env.STALE_RUN_MAX_JOBS ?? 50);
/** Max times the self-heal re-schedules itself while a run is still stuck. */
const MAX_SELF_HEAL_ROUNDS = Number(process.env.SELF_HEAL_MAX_ROUNDS ?? 5);
/** Delay between self-heal rounds (ms). */
const SELF_HEAL_RETRY_MS = Number(process.env.SELF_HEAL_RETRY_MS ?? 90_000);

/** The non-terminal run statuses the recovery can rescue. */
const NON_TERMINAL = ["queued", "scraping", "processing", "retrying"] as const;
/**
 * Job states that count as "finished" — a job in any of these will NOT be
 * re-enqueued. Includes `analysed` (scraped + AI-scored by the evaluator) in
 * addition to the scrape-only terminal states used by finalizeRunIfDone.
 */
const JOB_TERMINAL = ["completed", "failed", "duplicate", "analysed"];

/** A minimal run row we need to drive recovery. */
interface StaleRun {
  id: string;
  user_id: string | null;
  keyword: string | null;
  status: string;
  updated_at: string | null;
  created_at: string | null;
}

app.serviceBusQueue("recover-stuck-runs", {
  queueName: "jobs",
  connection: "ServiceBus",
  handler: async (rawBody: unknown, context: InvocationContext) => {
    const msg = rawBody as Partial<RunSelfHealMessage>;

    // Only handle self-heal messages — ignore process-job messages that
    // share the same `jobs` queue (the job processor handles those).
    if (msg?.type !== "run-self-heal" || !msg.runId) {
      return;
    }

    const runId = msg.runId;
    const round = msg.round ?? 0;
    context.log(`[recover] self-heal check for run ${runId} (round ${round})`);

    try {
      const supabase = getSupabaseClient();

      // ── Load the run. Already terminal → nothing to do. ──────
      const { data: run, error: runErr } = await supabase
        .from("pipeline_runs")
        .select("id, user_id, keyword, status, updated_at, created_at")
        .eq("id", runId)
        .maybeSingle();

      if (runErr) {
        context.log(`[recover] run ${runId} load failed: ${runErr.message}`);
        return;
      }
      if (!run) {
        context.log(`[recover] run ${runId} not found — no-op`);
        return;
      }
      if (!NON_TERMINAL.includes(run.status as (typeof NON_TERMINAL)[number])) {
        context.log(`[recover] run ${runId} already ${run.status} — no-op`);
        return;
      }

      const reEnqueued = await recoverOneRun(run as StaleRun, context);

      // ── Still stuck → re-schedule ONE more self-heal (bounded) ──
      // The first self-heal re-enqueues orphaned jobs; the processor then
      // needs time to work them. Without re-scheduling, the run would stay
      // in `retrying` forever (no further message would finalize it once the
      // jobs complete). Re-schedule up to MAX_SELF_HEAL_ROUNDS times until
      // the run reaches a terminal state.
      if (reEnqueued && round < MAX_SELF_HEAL_ROUNDS - 1) {
        const nextRound = round + 1;
        context.log(
          `[recover] run ${runId} still recovering — re-scheduling self-heal (round ${nextRound}/${MAX_SELF_HEAL_ROUNDS})`,
        );
        try {
          await enqueue(
            "jobs",
            {
              type: "run-self-heal",
              runId,
              userId: run.user_id ?? "",
              round: nextRound,
            },
            {
              messageId: `run-self-heal-${runId}-r${nextRound}`,
              ttlSeconds: 3600,
              scheduledEnqueueTimeUtc: new Date(
                Date.now() + SELF_HEAL_RETRY_MS,
              ),
            },
          );
        } catch (err) {
          context.log(`[recover] run ${runId} re-schedule failed: ${err}`);
        }
      }
    } catch (err) {
      context.log(`[recover] run ${runId} handler crashed: ${err}`);
    }
  },
});

/** Recover a single stale run (idempotent, best-effort).
 *  Returns TRUE if orphaned jobs were re-enqueued (run still recovering) —
 *  the caller re-schedules another self-heal in that case. Returns FALSE if
 *  the run was finalized / no-op / nothing re-enqueued. */
async function recoverOneRun(
  run: StaleRun,
  context: InvocationContext,
): Promise<boolean> {
  const supabase = getSupabaseClient();

  // ── 2. Load this run's jobs + statuses ──────────────────────
  const { data: jobs, error: jobsErr } = await supabase
    .from("jobs")
    .select(
      "id, url, status, title, company, keyword, scraped_date, user_id, board",
    )
    .eq("pipeline_run_id", run.id);

  if (jobsErr) {
    context.log(
      `[recover] run ${run.id} jobs query failed: ${jobsErr.message}`,
    );
    return false;
  }

  const allJobs = (jobs ?? []) as {
    id: string;
    url: string;
    status: string;
    title: string | null;
    company: string | null;
    keyword: string | null;
    scraped_date: string | null;
    user_id: string | null;
    board: string | null;
  }[];

  // No jobs at all → nothing to wait on; finalize as failed (nothing found).
  if (allJobs.length === 0) {
    context.log(`[recover] run ${run.id} has 0 jobs — marking failed`);
    await supabase
      .from("pipeline_runs")
      .update({
        status: "failed",
        last_error:
          "This search stalled and produced no jobs. Please try again.",
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    return false;
  }

  const orphaned = allJobs.filter((j) => !JOB_TERMINAL.includes(j.status));
  const allTerminal = orphaned.length === 0;

  // ── 3. All terminal → finalize the run ─────────────────────
  if (allTerminal) {
    context.log(
      `[recover] run ${run.id} — all ${allJobs.length} jobs terminal; finalizing`,
    );
    // Count completed + analysed as "processed" (both are finished states).
    const processed = allJobs.filter(
      (j) => j.status === "completed" || j.status === "analysed",
    ).length;
    const failed = allJobs.filter((j) => j.status === "failed").length;
    const status =
      processed > 0 || failed < allJobs.length ? "completed" : "failed";
    await supabase
      .from("pipeline_runs")
      .update({
        status,
        total_jobs: allJobs.length,
        processed_jobs: processed,
        failed_jobs: failed,
        ...(status === "failed"
          ? {
              last_error:
                "This search stalled and every job failed. Please try again.",
            }
          : {}),
        completed_at: new Date().toISOString(),
      })
      .eq("id", run.id);
    return false;
  }

  // ── 4. Re-enqueue orphaned (queued/processing) jobs ─────────
  context.log(
    `[recover] run ${run.id} — ${orphaned.length} orphaned job(s) (statuses: ${[...new Set(orphaned.map((j) => j.status))].join(",")}); re-enqueuing`,
  );

  // Mark the run as retrying so the UI shows a live state (not frozen).
  await supabase
    .from("pipeline_runs")
    .update({ status: "retrying", last_error: null })
    .eq("id", run.id);

  const toRequeue = orphaned.slice(0, MAX_JOBS_PER_RUN);
  for (const job of toRequeue) {
    // Use the job's REAL board (from the DB row) — NEVER "manual". The job
    // processor routes detail fetches by board; "manual" isn't a valid board
    // and makes the proxy return 404 → the job gets dead-lettered. Fall back
    // to "jobsdb" only if the row truly has no board (defensive).
    const board = job.board ?? "jobsdb";
    const msg: JobMessage = {
      type: "process-job",
      jobId: job.id,
      runId: run.id,
      userId: job.user_id ?? run.user_id ?? "",
      board,
      scrapedJob: {
        title: job.title ?? "Unknown",
        company: job.company ?? "N/A",
        location: "Hong Kong",
        url: job.url,
        board,
      },
      keyword: job.keyword ?? run.keyword ?? "",
      scrapedDate: job.scraped_date ?? new Date().toISOString().slice(0, 10),
    };
    try {
      // Duplicate detection: stable messageId per job → a job re-enqueued
      // twice in overlapping sweeps is delivered once. The processor is
      // idempotent anyway (upsert on url,user_id).
      await enqueue("jobs", msg, {
        messageId: `job-${job.id}-recover`,
        ttlSeconds: 3600,
      });
    } catch (err) {
      context.log(
        `[recover] run ${run.id} enqueue job ${job.id} failed: ${err}`,
      );
    }
  }

  context.log(
    `[recover] run ${run.id} re-enqueued ${toRequeue.length}/${orphaned.length} orphaned job(s)`,
  );

  // Return TRUE when we actually re-enqueued something — the caller
  // re-schedules another self-heal so the run keeps being watched until it
  // resolves (otherwise it would sit in `retrying` forever once the
  // re-enqueued jobs complete but no further message finalizes it).
  return toRequeue.length > 0;
}
