// ============================================================
//  runBoardState.ts — per-board progress helpers for Azure
//  Functions. Writes run_boards rows (one per board per run)
//  so the frontend can show each board's stage on the live
//  dashboard via Supabase Realtime.
//
//  Stages: pending → fetching → extracting → done | blocked | failed
//
//  WRITE-BATCHING: all writes are BUFFERED through the Event Hub
//  sink (eventHubSink.ts) and flushed to Supabase in batches by
//  the consumer — NOT one Supabase call per stage bump.
// ============================================================

import type { BoardPatchEvent } from "./batchedSupabase";
import { bufferWrite } from "./eventHubSink";
import { notifyStateChange } from "./redisState";
import { getSupabaseClient } from "./supabase";

export type RunBoardStage =
  | "pending"
  | "fetching"
  | "extracting"
  | "blocked"
  | "done"
  | "failed";

export interface RunBoardPatch {
  stage?: RunBoardStage;
  pages_fetched?: number;
  pages_total?: number;
  jobs_found?: number;
  jobs_processed?: number;
  jobs_failed?: number;
  duplicate?: number;
  last_error?: string | null;
  retry_count?: number;
  started_at?: string;
  completed_at?: string;
}

/** Cache runId → userId lookups to avoid hammering Postgres per stage bump. */
const userIdCache = new Map<string, string>();

/** Resolve the owning user of a run (from pipeline_runs.user_id). */
async function getRunUserId(runId: string): Promise<string | null> {
  if (userIdCache.has(runId)) return userIdCache.get(runId) ?? null;
  try {
    const supabase = getSupabaseClient();
    const { data, error } = await supabase
      .from("pipeline_runs")
      .select("user_id")
      .eq("id", runId)
      .maybeSingle();
    if (error) {
      console.warn(
        `[runBoardState] user lookup(${runId}) failed: ${error.message}`,
      );
      return null;
    }
    const uid = data?.user_id ? String(data.user_id) : null;
    if (uid) userIdCache.set(runId, uid);
    return uid;
  } catch (err) {
    console.warn(`[runBoardState] user lookup(${runId}) failed: ${err}`);
    return null;
  }
}

/** Ensure a run_boards row exists for (runId, board) — idempotent. */
export async function ensureRunBoard(
  runId: string,
  board: string,
): Promise<void> {
  // Buffer the ensure as a pending stage patch — the consumer upserts it.
  bufferWrite({
    op: "board-patch",
    runId,
    board,
    userId: userIdCache.get(runId) ?? null,
    patch: { stage: "pending" },
  } satisfies BoardPatchEvent);
}

/** Upsert a run_boards row with a partial patch (buffered → Event Hub). */
export async function updateRunBoard(
  runId: string,
  board: string,
  patch: RunBoardPatch,
): Promise<void> {
  // Buffer the patch; the Event Hub consumer coalesces + writes it.
  bufferWrite({
    op: "board-patch",
    runId,
    board,
    userId: userIdCache.get(runId) ?? null,
    patch: { ...patch },
  } satisfies BoardPatchEvent);

  // Fire-and-forget: tell the Express server to push the latest
  // per-board state (stage + counters) to this run's user over the
  // WebSocket. This is what makes a board's stage change from
  // "Waiting for status…" → "Searching…" → "✓ Done" LIVE.
  if (patch.stage) {
    getRunUserId(runId)
      .then((uid) => {
        if (uid) return notifyStateChange(uid, runId);
      })
      .catch(() => {});
  }
}

/** Convenience stage setters. */
export async function markBoardFetching(
  runId: string,
  board: string,
  pagesTotal: number,
): Promise<void> {
  await ensureRunBoard(runId, board);
  await updateRunBoard(runId, board, {
    stage: "fetching",
    pages_total: pagesTotal,
    started_at: new Date().toISOString(),
  });
}

export async function markBoardExtracting(
  runId: string,
  board: string,
  pagesFetched: number,
): Promise<void> {
  await updateRunBoard(runId, board, {
    stage: "extracting",
    pages_fetched: pagesFetched,
  });
}

export async function markBoardDone(
  runId: string,
  board: string,
  patch: Partial<
    Pick<RunBoardPatch, "jobs_found" | "duplicate" | "pages_fetched">
  > = {},
): Promise<void> {
  await updateRunBoard(runId, board, {
    stage: "done",
    completed_at: new Date().toISOString(),
    ...patch,
  });
}

export async function markBoardBlocked(
  runId: string,
  board: string,
  error: string,
): Promise<void> {
  await updateRunBoard(runId, board, {
    stage: "blocked",
    last_error: String(error).slice(0, 500),
    completed_at: new Date().toISOString(),
  });
}

export async function markBoardFailed(
  runId: string,
  board: string,
  error: string,
): Promise<void> {
  await updateRunBoard(runId, board, {
    stage: "failed",
    last_error: String(error).slice(0, 500),
    completed_at: new Date().toISOString(),
  });
}

/**
 * Increment per-board progress counters (jobs_found etc.) — BUFFERED
 * through the Event Hub sink, coalesced by the consumer into ONE additive
 * RPC per (runId, board). The RPC `increment_run_board` accumulates
 * correctly under concurrency (a plain upsert-SET would overwrite).
 */
export async function bumpRunBoardCounts(
  runId: string,
  board: string,
  delta: {
    jobs_found?: number;
    jobs_processed?: number;
    jobs_failed?: number;
    duplicate?: number;
  },
): Promise<void> {
  bufferWrite({
    op: "board-count",
    runId,
    board,
    userId: userIdCache.get(runId) ?? null,
    delta,
  });
}

/**
 * Read all run_boards rows for a run (for the GET /api/runs/{runId} detail).
 */
export async function getRunBoards(
  runId: string,
): Promise<Record<string, unknown>[]> {
  const supabase = getSupabaseClient();
  const { data, error } = await supabase
    .from("run_boards")
    .select("*")
    .eq("run_id", runId)
    .order("board_key");
  if (error) {
    console.warn(
      `[runBoardState] getRunBoards(${runId}) failed: ${error.message}`,
    );
    return [];
  }
  return (data ?? []) as Record<string, unknown>[];
}
