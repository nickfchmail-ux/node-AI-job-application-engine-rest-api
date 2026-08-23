// ============================================================
//  Supabase client + run-status helpers for Azure Functions.
//  Uses the service-role key (server-side only) so Functions can
//  update pipeline_runs and jobs status on behalf of users.
// ============================================================

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let _client: SupabaseClient | null = null;

export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    throw new Error(
      "SUPABASE_URL / SUPABASE_SERVICE_KEY not set (see local.settings.json / App Settings)",
    );
  }
  _client = createClient(url, key, { auth: { persistSession: false } });
  return _client;
}

// ── pipeline_runs status transitions ────────────────────────────────────────

export type RunStatus =
  | "queued"
  | "scraping"
  | "processing"
  | "completed"
  | "failed"
  | "retrying";

/** Statuses that a run can never leave once reached. */
const TERMINAL_STATUSES: ReadonlySet<RunStatus> = new Set<RunStatus>([
  "completed",
  "failed",
]);
/** Statuses a non-terminal transition is allowed to move FROM. */
const NON_TERMINAL_STATUSES: RunStatus[] = [
  "queued",
  "scraping",
  "processing",
  "retrying",
];

/**
 * Update a pipeline_run row. Only non-undefined fields are patched.
 * Returns false on error (caller logs).
 *
 * RACE-SAFE / ATOMIC: when the patch changes `status` to a NON-terminal
 * value (queued/scraping/processing/retrying), the UPDATE is issued as a
 * single conditional statement that only matches rows currently in a
 * non-terminal status. A run that already reached a TERMINAL status
 * (completed/failed) can never be regressed — even under concurrency,
 * because Postgres evaluates the WHERE clause atomically per statement.
 *
 * Why: the scraper worker marks the run "processing" once ALL boards are
 * enqueued, but fast boards (offertoday/linkedin public APIs) let the job
 * processor finish — and call finalizeRunIfDone → markRunCompleted — BEFORE
 * the scraper worker reaches that line. Without this guard the scraper's
 * late "processing" write would clobber a run that already reached
 * "completed", leaving the dashboard stuck on "processing" forever.
 *
 * Terminal patches (completed/failed) always apply — they can only move the
 * run forward, never backward.
 */
export async function updateRun(
  runId: string,
  patch: Partial<PipelineRunPatch>,
): Promise<boolean> {
  const supabase = getSupabaseClient();

  let query = supabase.from("pipeline_runs").update(patch).eq("id", runId);

  // For a non-terminal status transition, only allow it when the row is
  // currently non-terminal (atomic guard against regressing a terminal run).
  if (patch.status && !TERMINAL_STATUSES.has(patch.status as RunStatus)) {
    query = query.in("status", NON_TERMINAL_STATUSES);
  }

  const { error } = await query;
  if (error) {
    console.error(`[supabase] updateRun(${runId}) failed: ${error.message}`);
    return false;
  }
  return true;
}

interface PipelineRunPatch {
  status: RunStatus;
  total_jobs: number;
  processed_jobs: number;
  failed_jobs: number;
  fit_jobs: number;
  azure_run_id: string;
  last_error: string;
  retry_count: number;
  started_at: string;
  completed_at: string;
}

/** Mark a run as queued (initial state). */
export async function markRunQueued(
  runId: string,
  azureRunId: string,
): Promise<void> {
  await updateRun(runId, { status: "queued", azure_run_id: azureRunId });
}

/** Mark a run as scraping (scraper worker started). */
export async function markRunScraping(runId: string): Promise<void> {
  await updateRun(runId, {
    status: "scraping",
    started_at: new Date().toISOString(),
  });
}

/** Mark a run as processing (jobs fanning out). */
export async function markRunProcessing(runId: string): Promise<void> {
  await updateRun(runId, { status: "processing" });
}

/** Mark a run completed (all jobs done). */
export async function markRunCompleted(
  runId: string,
  totals: { total: number; processed: number; failed: number; fit: number },
): Promise<void> {
  await updateRun(runId, {
    status: "completed",
    total_jobs: totals.total,
    processed_jobs: totals.processed,
    failed_jobs: totals.failed,
    fit_jobs: totals.fit,
    completed_at: new Date().toISOString(),
  });
}

/**
 * Check whether every job belonging to a run is in a terminal state
 * (completed/failed/duplicate). If so, mark the run completed with the
 * aggregated counters. Idempotent — safe to call after every job finishes.
 * Returns true when the run was finalized.
 */
export async function finalizeRunIfDone(
  runId: string,
  log: (msg: string) => void = console.log,
): Promise<boolean> {
  const supabase = getSupabaseClient();

  // Count jobs for this run by status
  const { data, error } = await supabase
    .from("jobs")
    .select("status")
    .eq("pipeline_run_id", runId);

  if (error) {
    log(
      `[supabase] finalizeRunIfDone(${runId}) count failed: ${error.message}`,
    );
    return false;
  }
  if (!data || data.length === 0) return false;

  const terminal = new Set(["completed", "failed", "duplicate"]);
  const processed = data.filter((r) => r.status === "completed").length;
  const failed = data.filter((r) => r.status === "failed").length;
  const duplicate = data.filter((r) => r.status === "duplicate").length;
  const retrying = data.filter((r) => r.status === "retrying").length;

  // A job stuck in `retrying` is NOT terminal — Service Bus will redeliver
  // and eventually flip it to completed/failed. Don't finalize the run early.
  const allDone =
    data.length > 0 && data.every((r) => terminal.has(r.status));
  if (!allDone) return false;

  log(
    `[supabase] finalizeRunIfDone(${runId}) — all ${data.length} jobs terminal (processed=${processed}, failed=${failed}, duplicate=${duplicate}, retrying=${retrying})`,
  );
  await markRunCompleted(runId, {
    total: data.length,
    processed,
    failed,
    fit: 0, // scrape-only: no fit analysis
  });
  return true;
}

/** Mark a run failed with an error message. */
export async function markRunFailed(
  runId: string,
  error: string,
): Promise<void> {
  await updateRun(runId, {
    status: "failed",
    last_error: String(error).slice(0, 2000),
    completed_at: new Date().toISOString(),
  });
}

/** Increment retry_count and set status retrying. */
export async function markRunRetrying(
  runId: string,
  error: string,
): Promise<void> {
  const supabase = getSupabaseClient();
  // Read current retry_count then increment (simplified; fine for our throughput)
  const { data } = await supabase
    .from("pipeline_runs")
    .select("retry_count")
    .eq("id", runId)
    .maybeSingle();
  const count = (data?.retry_count ?? 0) + 1;
  await updateRun(runId, {
    status: "retrying",
    retry_count: count,
    last_error: String(error).slice(0, 2000),
  });
}

// ── per-job status helpers ──────────────────────────────────────────────────

export async function upsertJob(
  row: Record<string, unknown>,
): Promise<boolean> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("jobs").upsert(
    { ...row, last_seen_at: new Date().toISOString() },
    {
      onConflict: "url,user_id",
      // Date-independent dedup (migration 0016): same URL + user = ONE
      // row. last_seen_at is refreshed on conflict; scraped_date stays
      // the first-seen date.
      ignoreDuplicates: false,
    },
  );
  if (error) {
    console.error(`[supabase] upsertJob failed: ${error.message}`);
    return false;
  }
  return true;
}

export async function updateJobStatus(
  jobId: string,
  status: string,
  patch: Record<string, unknown> = {},
): Promise<boolean> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("jobs")
    .update({ status, ...patch })
    .eq("id", jobId);
  if (error) {
    console.error(
      `[supabase] updateJobStatus(${jobId}) failed: ${error.message}`,
    );
    return false;
  }
  return true;
}

/**
 * Update a job's status by its unique URL (safer than id — the
 * Service Bus message carries a random jobId, NOT the DB row id,
 * which is generated by Supabase). The scraper worker pre-inserts
 * the row using the same (url, scraped_date, user_id) unique key,
 * so matching by URL is reliable. Returns the matched DB row id,
 * or null when no row matched yet.
 */
export async function updateJobStatusByUrl(
  url: string,
  status: string,
  patch: Record<string, unknown> = {},
): Promise<string | null> {
  const supabase = getSupabaseClient();

  // 1. Find the actual row (created by the scraper's pre-insert)
  const { data: row, error: findErr } = await supabase
    .from("jobs")
    .select("id")
    .eq("url", url)
    .maybeSingle();

  if (findErr) {
    console.error(`[supabase] findJobByUrl(${url}) failed: ${findErr.message}`);
    return null;
  }
  if (!row) return null; // no pre-inserted row yet — upsert will create it

  // 2. Update status on the real row id
  const { error } = await supabase
    .from("jobs")
    .update({ status, ...patch })
    .eq("id", row.id);
  if (error) {
    console.error(
      `[supabase] updateJobStatusByUrl(${url}) failed: ${error.message}`,
    );
    return null;
  }
  return row.id as string;
}

/**
 * Set jobs.resume_status (none | ready_to_build | building | completed | failed)
 * plus optional patch (resume_url, resume_error, timestamps).
 * Returns the job's DB row id, or null when no row matched.
 */
export async function updateJobResumeStatus(
  jobId: string,
  resumeStatus: string,
  patch: Record<string, unknown> = {},
): Promise<boolean> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("jobs")
    .update({ resume_status: resumeStatus, ...patch })
    .eq("id", jobId);
  if (error) {
    console.error(
      `[supabase] updateJobResumeStatus(${jobId}) failed: ${error.message}`,
    );
    return false;
  }
  return true;
}
