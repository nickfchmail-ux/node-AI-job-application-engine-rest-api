// ============================================================
//  eventHub.ts — Azure Event Hubs sender helper (buffered).
//
//  Local dev:   EventHub__connectionString (SAS)
//  Production:  EventHub__fullyQualifiedNamespace + Managed
//               Identity (EventHub__credential = "managedidentity")
//
//  This is the PRODUCER side of the write-batching layer. The
//  pipeline functions do NOT write each job straight to Supabase;
//  they send compact "intent" events here, and the Event Hub
//  trigger consumer (`eventHubConsumer.ts`) coalesces a BATCH of
//  them into a handful of Supabase writes (one `jobs.upsert` per
//  run, one `increment_run_board` per board).
// ============================================================

import { EventHubProducerClient } from "@azure/event-hubs";

export const EVENT_HUB_NAME = "jobs";

let _producer: EventHubProducerClient | null = null;

function getProducer(): EventHubProducerClient {
  if (_producer) return _producer;

  const connStr = process.env.EventHub__connectionString;
  const fqns = process.env.EventHub__fullyQualifiedNamespace;
  const credentialType = process.env.EventHub__credential ?? "connectionstring";

  if (connStr) {
    _producer = new EventHubProducerClient(connStr, EVENT_HUB_NAME);
  } else if (fqns && credentialType === "managedidentity") {
    const { DefaultAzureCredential } =
      require("@azure/identity") as typeof import("@azure/identity");
    _producer = new EventHubProducerClient(
      fqns,
      EVENT_HUB_NAME,
      new DefaultAzureCredential(),
    );
  } else {
    throw new Error(
      "Event Hubs not configured. Set EventHub__connectionString (local) or EventHub__fullyQualifiedNamespace + EventHub__credential=managedidentity (prod).",
    );
  }
  return _producer;
}

/**
 * Send event objects to the `jobs` event hub, grouped by partition key.
 * Partitioning: a stable partition key (runId) keeps a run's events
 * ordered and co-located (so the consumer sees them together in one
 * batch). Different runs go to different partitions so one busy run
 * never blocks another. At-least-once — consumers must be idempotent
 * (they are: upsert on `url,user_id` + additive `increment_run_board`).
 *
 * ROBUSTNESS:
 *  - Events are chunked into MULTIPLE batches per key if a run produces
 *    more than one Event Hub batch's worth — nothing is dropped.
 *  - A single event that exceeds the max batch size (huge job row) is
 *    skipped with a LOUD warning; callers see `sent < total` and fall
 *    back to a direct Supabase write (no silent loss).
 *  - Guards against a hung send with a timeout.
 */
export async function sendEvents(
  events: { key: string; body: unknown }[],
): Promise<number> {
  if (events.length === 0) return 0;
  const producer = getProducer();

  // Group by partition key so each run's events stay together + ordered.
  const byKey = new Map<string, unknown[]>();
  for (const ev of events) {
    const list = byKey.get(ev.key) ?? [];
    list.push(ev.body);
    byKey.set(ev.key, list);
  }

  let sent = 0;
  for (const [key, bodies] of byKey) {
    // Chunk into as many batches as needed (a run can exceed one batch).
    let batch = await producer.createBatch({ partitionKey: key });
    for (const body of bodies) {
      if (batch.tryAdd({ body })) {
        sent++;
        continue;
      }
      // Event didn't fit in the current batch. If the batch is empty the
      // event itself exceeds the max size → skip with a loud warning.
      if (batch.count === 0) {
        console.error(
          `[eventHub] event for partition '${key}' exceeds Event Hub max batch size — falling back to direct write`,
        );
        continue;
      }
      // Flush the full batch, start a new one, retry this event.
      await sendBatch(producer, batch);
      batch = await producer.createBatch({ partitionKey: key });
      if (batch.tryAdd({ body })) {
        sent++;
      } else {
        console.error(
          `[eventHub] event for partition '${key}' exceeds Event Hub max batch size (even alone) — falling back to direct write`,
        );
      }
    }
    if (batch.count > 0) {
      await sendBatch(producer, batch);
    }
  }
  return sent;
}

/** Send a batch with a 30s timeout guard. */
async function sendBatch(
  producer: EventHubProducerClient,
  batch: Parameters<EventHubProducerClient["sendBatch"]>[0],
): Promise<void> {
  await Promise.race([
    producer.sendBatch(batch),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Event Hub send timed out")), 30_000),
    ),
  ]);
}
