// ============================================================
//  runBoardState.ts — per-board progress helpers for Azure
//  Functions. Writes run_boards rows (one per board per run)
//  so the frontend can show each board's stage on the live
//  dashboard via Supabase Realtime.
//
//  Stages: pending → fetching → extracting → done | blocked | failed
// ============================================================

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

/** Ensure a run_boards row exists for (runId, board) — idempotent. */
export async function ensureRunBoard(
  runId: string,
  board: string,
): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase.from("run_boards").upsert(
    {
      run_id: runId,
      board_key: board,
      stage: "pending",
    },
    { onConflict: "run_id,board_key", ignoreDuplicates: true },
  );
  if (error) {
    console.warn(
      `[runBoardState] ensureRunBoard(${board}) failed: ${error.message}`,
    );
  }
}

/** Upsert a run_boards row with a partial patch. */
export async function updateRunBoard(
  runId: string,
  board: string,
  patch: RunBoardPatch,
): Promise<void> {
  const supabase = getSupabaseClient();
  const { error } = await supabase
    .from("run_boards")
    .upsert(
      { run_id: runId, board_key: board, ...patch },
      { onConflict: "run_id,board_key" },
    );
  if (error) {
    console.warn(
      `[runBoardState] updateRunBoard(${board}) failed: ${error.message}`,
    );
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
 * Increment per-board progress counters (jobs_found etc.).
 * Uses the atomic Postgres RPC `increment_run_board` so CONCURRENT
 * job-processor invocations ACCUMULATE correctly (a plain upsert-SET
 * would overwrite, losing all but the last write under 16-way parallelism).
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
  const supabase = getSupabaseClient();
  const { error } = await supabase.rpc("increment_run_board", {
    p_run_id: runId,
    p_board: board,
    p_jobs_found: delta.jobs_found ?? 0,
    p_jobs_processed: delta.jobs_processed ?? 0,
    p_jobs_failed: delta.jobs_failed ?? 0,
    p_duplicate: delta.duplicate ?? 0,
  });
  if (error) {
    console.warn(
      `[runBoardState] increment_run_board(${board}) failed: ${error.message}`,
    );
  }
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
