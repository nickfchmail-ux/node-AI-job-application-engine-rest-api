// ============================================================
//  realtime.ts — Supabase Realtime client for the frontend
//
//  Subscribes to live changes on:
//    - pipeline_runs  (the "subscription" status the user tracks)
//    - jobs           (jobs streaming in + processing state)
//
//  Exposes:
//    subscribeToRun(runId, handlers)
//    subscribeToJobs(runId, handlers)
//    mapRunStatus(status)      → human copy
//    mapJobStatus(status)      → human copy
//
//  Auth: pass the Supabase anon client already configured with the
//  user's session (anon key is safe for client use).
// ============================================================

import { RealtimeChannel, SupabaseClient } from "@supabase/supabase-js";

// ── Run (pipeline/subscription) status → human copy ─────────────────────────
export function mapRunStatus(status: string): {
  label: string;
  tone: "neutral" | "active" | "success" | "error";
  live: boolean;
} {
  switch (status) {
    case "queued":
      return { label: "In line…", tone: "neutral", live: true };
    case "scraping":
      return { label: "Searching the job boards…", tone: "active", live: true };
    case "processing":
      return {
        label: "Matching jobs against your resume…",
        tone: "active",
        live: true,
      };
    case "completed":
      return { label: "Done ✓", tone: "success", live: false };
    case "failed":
      return {
        label: "Something went wrong — retry",
        tone: "error",
        live: false,
      };
    case "retrying":
      return { label: "Hitting a snag, retrying…", tone: "active", live: true };
    default:
      return { label: status, tone: "neutral", live: false };
  }
}

// ── Per-job status → human copy ─────────────────────────────────────────────
export function mapJobStatus(status: string): {
  label: string;
  tone: "neutral" | "active" | "success" | "error" | "muted";
} {
  switch (status) {
    case "discovered":
      return { label: "Found", tone: "neutral" };
    case "queued":
      return { label: "In line", tone: "neutral" };
    case "scraping":
      return { label: "Reading the full ad…", tone: "active" };
    case "processing":
    case "enriching":
    case "analysing":
      return { label: "Matching your resume…", tone: "active" };
    case "completed":
      return { label: "Analysed ✓", tone: "success" };
    case "failed":
      return { label: "Failed", tone: "error" };
    case "duplicate":
      return { label: "Already saved", tone: "muted" };
    default:
      return { label: status, tone: "neutral" };
  }
}

// ── Fit score → human tone + copy ───────────────────────────────────────────
export function describeFit(score: number | null): {
  badge: string;
  tone: "good" | "ok" | "low" | "none";
  copy: string;
} {
  if (score == null)
    return {
      badge: "Not analysed",
      tone: "none",
      copy: "We haven't scored this one yet.",
    };
  if (score >= 75)
    return {
      badge: "Great fit",
      tone: "good",
      copy: "Strong match with your profile.",
    };
  if (score >= 50)
    return {
      badge: "Possible fit",
      tone: "ok",
      copy: "Some overlap — worth a look.",
    };
  return {
    badge: "Low fit",
    tone: "low",
    copy: "Weak match — apply only if you're keen.",
  };
}

// ── Subscription helpers ────────────────────────────────────────────────────

export interface RunHandlers {
  onRunChange?: (run: Record<string, unknown>) => void;
  onJobUpsert?: (job: Record<string, unknown>) => void;
  onError?: (err: Error) => void;
}

/**
 * Subscribe to a pipeline run's live status + its jobs.
 * Returns an unsubscribe function.
 */
export function subscribeToRun(
  supabase: SupabaseClient,
  runId: string,
  handlers: RunHandlers,
): () => void {
  const channels: RealtimeChannel[] = [];

  // 1. pipeline_runs — the run's own status
  const runChannel = supabase
    .channel(`run-${runId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "pipeline_runs",
        filter: `id=eq.${runId}`,
      },
      (payload) =>
        handlers.onRunChange?.(payload.new as Record<string, unknown>),
    )
    .subscribe((status, err) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        handlers.onError?.(
          err ?? new Error(`Realtime ${status} on pipeline_runs`),
        );
      }
    });
  channels.push(runChannel);

  // 2. jobs — new/updated jobs for this run stream in live
  const jobChannel = supabase
    .channel(`jobs-${runId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "jobs",
        filter: `pipeline_run_id=eq.${runId}`,
      },
      (payload) =>
        handlers.onJobUpsert?.(payload.new as Record<string, unknown>),
    )
    .subscribe((status, err) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        handlers.onError?.(err ?? new Error(`Realtime ${status} on jobs`));
      }
    });
  channels.push(jobChannel);

  return () => {
    for (const ch of channels) supabase.removeChannel(ch);
  };
}

/**
 * Subscribe to ALL of a user's runs (dashboard view).
 * Returns an unsubscribe function.
 */
export function subscribeToAllRuns(
  supabase: SupabaseClient,
  userId: string,
  handlers: {
    onRunChange?: (run: Record<string, unknown>) => void;
    onError?: (err: Error) => void;
  },
): () => void {
  const channel = supabase
    .channel(`runs-${userId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "pipeline_runs",
        filter: `user_id=eq.${userId}`,
      },
      (payload) =>
        handlers.onRunChange?.(payload.new as Record<string, unknown>),
    )
    .subscribe((status, err) => {
      if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
        handlers.onError?.(
          err ?? new Error(`Realtime ${status} on pipeline_runs`),
        );
      }
    });

  return () => {
    supabase.removeChannel(channel);
  };
}
