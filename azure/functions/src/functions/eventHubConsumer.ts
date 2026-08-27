// ============================================================
//  eventHubConsumer.ts — Event Hub trigger (the batched WRITER).
//
//  Receives a BATCH of `jobs` pipeline-intent events from the
//  Event Hub (up to `maxBatchSize`, flushed by `maxWaitTime`),
//  coalesces them by run/board, and writes to Supabase in ONE
//  upsert per run.
//
//  This is what makes "every POST does NOT touch Supabase":
//    - producer side (eventHubSink.ts) batches POST intents into
//      Event Hub sends,
//    - consumer side (this) batches a chunk of those into a few
//      Supabase writes.
//
//  At-least-once delivery — idempotent via upsert + additive RPC.
//
//  IMPORTANT READ-PATH GUARANTEE: the batch flush latency is
//  bounded by Event Hub trigger `maxWaitTime` (default 60s, we set
//  ~5s) so by the time a user refreshes / retrieves, the batch has
//  already touched the DB.
// ============================================================

import { app, InvocationContext } from "@azure/functions";
import { flushToSupabase, type PipelineWriteEvent } from "../batchedSupabase";
import { notifyStateChange } from "../redisState";
import { finalizeActiveRunsForUsers } from "../supabase";

export const EVENT_HUB_NAME = "jobs";

app.eventHub("eventhub-jobs-batch-writer", {
  eventHubName: EVENT_HUB_NAME,
  connection: "EventHub", // resolves EventHub__fullyQualifiedNamespace / EventHub__connectionString
  cardinality: "many",
  consumerGroup: "$Default",
  handler: async (rawEvents: unknown, context: InvocationContext) => {
    // rawEvents is an array when cardinality === "many"
    const events = Array.isArray(rawEvents) ? rawEvents : [rawEvents];
    if (events.length === 0) return;

    // Each event body is the PipelineWriteEvent we buffered.
    const typed = events
      .map((e) => {
        const body = (e as { body?: unknown })?.body ?? e;
        if (body && typeof body === "object" && "op" in (body as object)) {
          return body as PipelineWriteEvent;
        }
        return null;
      })
      .filter((x): x is PipelineWriteEvent => x !== null);

    console.info(
      `[eventHubConsumer] batch of ${events.length} raw event(s) → ${typed.length} typed write event(s)`,
    );

    if (typed.length === 0) return;

    const result = await flushToSupabase(typed);
    console.info(
      `[eventHubConsumer] flushed: ${result.jobs} jobs, ${result.boards} boards, ${result.counts} counts (${result.failures.length} failures)`,
    );

    // ── CRITICAL: never advance the checkpoint past unpersisted events ──
    // If any write failed, THROW so the Event Hub runtime does NOT checkpoint
    // this batch — the events redeliver (at-least-once) and get retried.
    if (result.failures.length > 0) {
      console.error(
        `[eventHubConsumer] ${result.failures.length} event(s) failed to persist — throwing so the batch redelivers (no data loss)`,
      );
      throw new Error(
        `flushToSupabase failed for ${result.failures.length} event(s)`,
      );
    }

    // ── Finalize runs (ROBUST): reconcile ALL active runs of the affected
    //    users, not just this batch's runs. Handles parallel-board runs
    //    whose last job landed in a different batch → completes promptly.
    const userIds = new Set(
      typed
        .filter((ev) => ev.op === "job" && ev.userId)
        .map((ev) => (ev as { userId: string }).userId),
    );
    await finalizeActiveRunsForUsers(userIds);

    // ── Live socket nudge: tell the Express server to push fresh stats.
    for (const uid of userIds) {
      const runId =
        typed.find((ev) => ev.op === "job" && ev.userId === uid)?.runId ?? "";
      await notifyStateChange(uid, runId).catch(() => {});
    }
  },
});
