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

import { flushToSupabase, type PipelineWriteEvent } from "./batchedSupabase";
import { sendEvents } from "./eventHub";
import { notifyStateChange } from "./redisState";
import { finalizeActiveRunsForUsers } from "./supabase";

const MAX_PENDING = 50; // flush when 50 intents accumulated
const FLUSH_MS = 2000; // or every 2s, whichever first
const MAX_BUFFER_MS = 60_000; // hard cap so a cold sink can't sit forever

let _buffer: PipelineWriteEvent[] = [];
let _lastFlush = Date.now();
let _timer: NodeJS.Timeout | null = null;
// A flush in-flight. Concurrent bufferWrite → flushNow calls await this so
// no two flushes run at once and events buffered mid-flush aren't lost.
let _flushPromise: Promise<void> | null = null;

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
  if (
    _buffer.length >= MAX_PENDING ||
    Date.now() - _lastFlush >= MAX_BUFFER_MS
  ) {
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
export function flushNow(): Promise<void> {
  // If a flush is already running, queue this as the NEXT flush so events
  // buffered during the in-flight flush aren't lost. (The running flush
  // re-checks the buffer when it finishes.)
  if (_flushPromise) {
    return _flushPromise.then(() => flushNow());
  }

  if (_timer) {
    clearTimeout(_timer);
    _timer = null;
  }

  const pending = _buffer;
  _buffer = [];
  _lastFlush = Date.now();

  if (pending.length === 0) return Promise.resolve();

  _flushPromise = (async () => {
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
    if (directWrites && directWrites.length > 0) {
      try {
        const res = await flushToSupabase(directWrites);
        console.info(
          `[eventHubSink] direct write: ${res.jobs} jobs, ${res.boards} boards, ${res.counts} counts (${res.failures.length} failures)`,
        );
        // Finalize affected users' active runs + nudge sockets, matching
        // the consumer (robust across parallel-board runs).
        const userIds = new Set(
          directWrites
            .filter((ev) => ev.op === "job" && ev.userId)
            .map((ev) => (ev as { userId: string }).userId),
        );
        await finalizeActiveRunsForUsers(userIds);
        for (const uid of userIds) {
          const runId =
            directWrites.find((ev) => ev.op === "job" && ev.userId === uid)
              ?.runId ?? "";
          await notifyStateChange(uid, runId).catch(() => {});
        }
        // Direct-write failures are logged but not rethrown (best-effort
        // fallback; the primary path is the durable Event Hub consumer).
      } catch (fallbackErr) {
        console.error(
          `[eventHubSink] direct fallback also failed: ${fallbackErr}`,
        );
      }
    }
  })().finally(() => {
    _flushPromise = null;
  });

  return _flushPromise;
}

/** Flush any buffered events on process exit (graceful shutdown). */
export function flushOnExit(): void {
  if (_flushPromise) {
    void _flushPromise.finally(() => flushNow());
  } else {
    void flushNow();
  }
}

// Best-effort graceful-shutdown flush so buffered intents aren't lost when
// the worker is stopped/rotated. The durable guarantee is the Event Hub
// consumer (idempotent redelivery) + the recover-stuck-runs self-heal for
// the rare process crash mid-buffer.
if (typeof process !== "undefined" && process.on) {
  process.on("SIGTERM", () => {
    flushOnExit();
  });
  process.on("SIGINT", () => {
    flushOnExit();
  });
}
