// ============================================================
//  eventHubSink.ts — producer-side in-memory write buffer.
//
//  The pipeline functions call `bufferJobUpsert` / `bufferBoard*`
//  instead of writing straight to Supabase. This module ACCUMULATES
//  those intents and flushes them to the Event Hub in bounded
//  batches:
//     - flush when buffer reaches `MAX_PENDING` (e.g. 50 events), OR
//     - flush on a timer every `FLUSH_MS` (e.g. 2000ms), whichever
//       comes first.
//
//  That turns a burst of N per-job POSTs into ceil(N/50) Event Hub
//  sends, which the consumer then coalesces into ~1 Supabase write
//  per run. Hundreds of users → the per-user Supabase write rate is
//  independent of POST volume.
//
//  The Event Hub consumer (`eventHubConsumer.ts`) is the durable,
//  at-least-once path. If Event Hubs is not configured, this module
//  falls back to writing directly via `flushToSupabase` so the app
//  still works during local dev / misconfiguration.
// ============================================================

import { sendEvents } from "./eventHub";
import { flushToSupabase, type PipelineWriteEvent } from "./batchedSupabase";
import { finalizeRunIfDone } from "./supabase";
import { notifyStateChange } from "./redisState";

const MAX_PENDING = 50; // flush when 50 intents accumulated
const FLUSH_MS = 2000; // or every 2s, whichever first
const MAX_BUFFER_MS = 60_000; // hard cap so a cold sink can't sit forever

let _buffer: PipelineWriteEvent[] = [];
let _lastFlush = Date.now();
let _timer: NodeJS.Timeout | null = null;

/** Whether Event Hubs is configured (determines flush target). */
function isEventHubConfigured(): boolean {
  return Boolean(
    process.env.EventHub__connectionString ||
      process.env.EventHub__fullyQualifiedNamespace,
  );
}

/** Push intents into the buffer and maybe flush. */
export function bufferWrite(...events: PipelineWriteEvent[]): void {
  _buffer.push(...events);
  if (_buffer.length >= MAX_PENDING || Date.now() - _lastFlush >= MAX_BUFFER_MS) {
    void flushNow();
    return;
  }
  if (!_timer) {
    _timer = setTimeout(() => {
      _timer = null;
      void flushNow();
    }, FLUSH_MS);
  }
}

/** Flush the buffer now (idempotent, concurrent-safe). */
export async function flushNow(): Promise<void> {
  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }
  const pending = _buffer;
  _buffer = [];
  _lastFlush = Date.now();
  if (pending.length === 0) return;

  let directWrites: PipelineWriteEvent[] | null = null;

  try {
    if (isEventHubConfigured()) {
      const events = pending.map((ev) => ({
        key: ev.runId ?? "global",
        body: ev,
      }));
      const sent = await sendEvents(events);
      console.info(
        `[eventHubSink] sent ${sent}/${pending.length} events to Event Hub (run batch)`,
      );
      // If some events didn't fit in the batch, we must NOT lose them —
      // the durable consumer is the fast path, but a failed/dropped send
      // must degrade to a direct (still batched) Supabase write.
      if (sent < pending.length) {
        directWrites = pending.slice(sent);
      }
    } else {
      // Fallback: direct batched Supabase write (dev / misconfig).
      directWrites = pending;
    }
  } catch (err) {
    console.error(`[eventHubSink] flush failed: ${err}`);
    // Event Hub is down — never lose the batch. Fall back to a direct
    // (still batched) Supabase write.
    directWrites = pending;
  }

  // ── Direct-write fallback: write + finalize (no consumer in this path) ──
  if (directWrites) {
    try {
      const res = await flushToSupabase(directWrites);
      console.info(
        `[eventHubSink] direct write: ${res.jobs} jobs, ${res.boards} boards, ${res.counts} counts`,
      );
      // Finalize affected runs + nudge sockets, matching the consumer.
      const runIds = new Set(directWrites.map((ev) => ev.runId).filter(Boolean));
      const userIds = new Set(
        directWrites
          .filter((ev) => ev.op === "job" && ev.userId)
          .map((ev) => (ev as { userId: string }).userId),
      );
      for (const runId of runIds) {
        await finalizeRunIfDone(runId).catch((err) =>
          console.warn(`[eventHubSink] finalizeRunIfDone(${runId}) failed: ${err}`),
        );
      }
      for (const uid of userIds) {
        await notifyStateChange(uid, [...runIds][0] ?? "").catch(() => {});
      }
    } catch (fallbackErr) {
      console.error(`[eventHubSink] direct fallback also failed: ${fallbackErr}`);
    }
  }
}
