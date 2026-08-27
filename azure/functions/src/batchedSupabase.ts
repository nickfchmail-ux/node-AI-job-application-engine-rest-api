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
//
//  ROBUSTNESS:
//    - Chunks every upsert so a single run's rows NEVER exceed the
//      Postgres / PostgREST row limit (large runs are split into
//      multiple `jobs.upsert` calls of ≤ 1000 rows each).
//    - Caps URL length (Postgres btree index limit) and silently
//      drops the rare over-long row (with a log) so one bad row
//      can't fail an entire batch.
//    - Returns a `failures` array so callers can RE-RETRY the
//      failed events (at-least-once without silent data loss).
// ============================================================

import { getSupabaseClient } from "./supabase";

/** PostgREST upsert row limit — keep well under it (1000 is safe). */
const MAX_UPSERT_ROWS = 1000;
/** Postgres btree index max ~2704 bytes; URLs longer than this are invalid. */
const MAX_URL_LENGTH = 2000;

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

/**
 * Apply a coalesced batch to Supabase. Best-effort per group, chunked so
 * no single request exceeds Supabase limits. NEVER throws — returns a
 * `failures` array of the events that failed to persist so the caller can
 * retry them (at-least-once without silent data loss).
 */
export async function flushToSupabase(
  events: PipelineWriteEvent[],
): Promise<{ jobs: number; boards: number; counts: number; failures: PipelineWriteEvent[] }> {
  const { jobs, boards, counts } = coalesceEvents(events);
  const supabase = getSupabaseClient();
  const failures: PipelineWriteEvent[] = [];
  let jobsWritten = 0;
  let boardsWritten = 0;
  let countsWritten = 0;

  // ── 1. Jobs: upsert per run, CHUNKED (≤1000 rows per call) ──
  for (const [runId, group] of jobs) {
    // Cap over-long URLs: a single bad URL (btree index limit) must not
    // fail the whole run's batch. Filter defensively + log.
    const validRows: Record<string, unknown>[] = [];
    for (const row of group.rows) {
      const url = typeof row.url === "string" ? row.url : "";
      if (url && url.length > MAX_URL_LENGTH) {
        console.warn(
          `[batchedSupabase] dropping job row with URL > ${MAX_URL_LENGTH} chars (run ${runId})`,
        );
        continue;
      }
      validRows.push(row);
    }

    for (let i = 0; i < validRows.length; i += MAX_UPSERT_ROWS) {
      const chunk = validRows.slice(i, i + MAX_UPSERT_ROWS);
      try {
        const { error } = await supabase
          .from("jobs")
          .upsert(chunk, { onConflict: "url,user_id", ignoreDuplicates: false })
          .select("id");
        if (error) {
          console.error(
            `[batchedSupabase] jobs upsert(${runId}) chunk ${i / MAX_UPSERT_ROWS} failed: ${error.message}`,
          );
          // Fail the whole group's events so the consumer retries them.
          failures.push(
            ...events.filter(
              (ev) => ev.op === "job" && ev.runId === runId,
            ),
          );
          continue;
        }
        jobsWritten += chunk.length;
      } catch (err) {
        console.error(`[batchedSupabase] jobs upsert(${runId}) threw: ${err}`);
        failures.push(
          ...events.filter((ev) => ev.op === "job" && ev.runId === runId),
        );
      }
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
        failures.push(
          ...events.filter(
            (ev) =>
              ev.op === "board-patch" &&
              `${ev.runId}:${ev.board}` === key,
          ),
        );
        continue;
      }
      boardsWritten++;
    } catch (err) {
      console.error(`[batchedSupabase] run_boards upsert(${key}) threw: ${err}`);
      failures.push(
        ...events.filter(
          (ev) =>
            ev.op === "board-patch" &&
            `${ev.runId}:${ev.board}` === key,
        ),
      );
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
        failures.push(
          ...events.filter(
            (ev) =>
              ev.op === "board-count" &&
              `${ev.runId}:${ev.board}` === key,
          ),
        );
        continue;
      }
      countsWritten++;
    } catch (err) {
      console.error(`[batchedSupabase] increment_run_board(${key}) threw: ${err}`);
      failures.push(
        ...events.filter(
          (ev) =>
            ev.op === "board-count" &&
            `${ev.runId}:${ev.board}` === key,
        ),
      );
    }
  }

  return { jobs: jobsWritten, boards: boardsWritten, counts: countsWritten, failures };
}
