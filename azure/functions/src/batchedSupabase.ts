// ============================================================
//  batchedSupabase.ts — coalesce many pipeline "intent" events
//  into a few Supabase writes.
//
//  THE core of the write-batching layer. Instead of N individual
//  `jobs.upsert` + `run_boards.upsert` + `increment_run_board` RPC
//  calls (one per job POST), we accumulate intents and flush them
//  as ONE batched write per run.
//
//  Used by BOTH:
//    - eventHubConsumer.ts (Event Hub trigger → receives a batch)
//    - eventHubSink.ts     (in-process coalescing fallback)
//
//  Idempotent by design (at-least-once Event Hubs delivery):
//    - jobs: upsert on (url, user_id) — same row, deduped
//    - run_boards: upsert on (run_id, board_key)
//    - counts: additive RPC `increment_run_board`
// ============================================================

import { getSupabaseClient } from "./supabase";

export type JobEventType = "preinsert" | "upsert";

export interface JobWriteEvent {
  op: "job";
  type: JobEventType;
  runId: string;
  userId: string | null;
  board: string;
  keyword: string;
  row: Record<string, unknown>;
  url: string;
}

export interface BoardPatchEvent {
  op: "board-patch";
  runId: string;
  board: string;
  userId?: string | null;
  patch: Record<string, unknown>;
}

export interface BoardCountEvent {
  op: "board-count";
  runId: string;
  board: string;
  userId?: string | null;
  delta: {
    jobs_found?: number;
    jobs_processed?: number;
    jobs_failed?: number;
    duplicate?: number;
  };
}

export type PipelineWriteEvent = JobWriteEvent | BoardPatchEvent | BoardCountEvent;

/** Group raw events from a batch into per-run/per-board coalesced writes. */
export function coalesceEvents(events: PipelineWriteEvent[]): {
  jobs: Map<string, { userId: string | null; rows: Record<string, unknown>[] }>;
  boards: Map<string, Record<string, unknown>>;
  counts: Map<string, { board: string; delta: Record<string, number> }>;
} {
  // jobs: group by runId (all rows for a run upserted in ONE call)
  const jobs = new Map<
    string,
    { userId: string | null; rows: Record<string, unknown>[] }
  >();
  // boards: key = `${runId}:${board}` → upsert one row per board per run
  const boards = new Map<string, Record<string, unknown>>();
  // counts: key = `${runId}:${board}` → sum deltas into one RPC call
  const counts = new Map<string, { board: string; delta: Record<string, number> }>();

  for (const ev of events) {
    if (ev.op === "job") {
      let group = jobs.get(ev.runId);
      if (!group) {
        group = { userId: ev.userId, rows: [] };
        jobs.set(ev.runId, group);
      }
      // A later `upsert` (enriched/completed) OVERRIDES the earlier
      // `preinsert` for the same URL — only keep the richest row.
      const existingIdx = group.rows.findIndex((r) => r.url === ev.row.url);
      if (existingIdx >= 0) {
        if (ev.type === "upsert") group.rows[existingIdx] = ev.row;
      } else {
        group.rows.push(ev.row);
      }
    } else if (ev.op === "board-patch") {
      const key = `${ev.runId}:${ev.board}`;
      const existing = boards.get(key) ?? { run_id: ev.runId, board_key: ev.board };
      boards.set(key, { ...existing, ...ev.patch });
    } else if (ev.op === "board-count") {
      const key = `${ev.runId}:${ev.board}`;
      const existing = counts.get(key) ?? { board: ev.board, delta: {} };
      for (const [k, v] of Object.entries(ev.delta)) {
        existing.delta[k] = (existing.delta[k] ?? 0) + v;
      }
      counts.set(key, existing);
    }
  }
  return { jobs, boards, counts };
}

/** Apply a coalesced batch to Supabase. Best-effort per group (never throws). */
export async function flushToSupabase(
  events: PipelineWriteEvent[],
): Promise<{ jobs: number; boards: number; counts: number }> {
  const { jobs, boards, counts } = coalesceEvents(events);
  const supabase = getSupabaseClient();
  let jobsWritten = 0;
  let boardsWritten = 0;
  let countsWritten = 0;

  // ── 1. Jobs: ONE upsert per run (batch of rows) ─────────────
  for (const [runId, group] of jobs) {
    try {
      const { error } = await supabase
        .from("jobs")
        .upsert(group.rows, { onConflict: "url,user_id", ignoreDuplicates: false })
        .select("id");
      if (error) {
        console.error(`[batchedSupabase] jobs upsert(${runId}) failed: ${error.message}`);
        continue;
      }
      jobsWritten += group.rows.length;
    } catch (err) {
      console.error(`[batchedSupabase] jobs upsert(${runId}) threw: ${err}`);
    }
  }

  // ── 2. Boards: ONE upsert per (runId, board) ────────────────
  for (const [key, row] of boards) {
    try {
      const { error } = await supabase
        .from("run_boards")
        .upsert(row, { onConflict: "run_id,board_key" });
      if (error) {
        console.error(`[batchedSupabase] run_boards upsert(${key}) failed: ${error.message}`);
        continue;
      }
      boardsWritten++;
    } catch (err) {
      console.error(`[batchedSupabase] run_boards upsert(${key}) threw: ${err}`);
    }
  }

  // ── 3. Counts: ONE additive RPC per (runId, board) ──────────
  for (const [key, c] of counts) {
    try {
      const { error } = await supabase.rpc("increment_run_board", {
        p_run_id: key.split(":")[0],
        p_board: c.board,
        p_jobs_found: c.delta.jobs_found ?? 0,
        p_jobs_processed: c.delta.jobs_processed ?? 0,
        p_jobs_failed: c.delta.jobs_failed ?? 0,
        p_duplicate: c.delta.duplicate ?? 0,
      });
      if (error) {
        console.error(`[batchedSupabase] increment_run_board(${key}) failed: ${error.message}`);
        continue;
      }
      countsWritten++;
    } catch (err) {
      console.error(`[batchedSupabase] increment_run_board(${key}) threw: ${err}`);
    }
  }

  return { jobs: jobsWritten, boards: boardsWritten, counts: countsWritten };
}
