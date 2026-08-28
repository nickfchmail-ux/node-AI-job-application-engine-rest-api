// ============================================================
//  Azure Storage Queue sender helper (FREE replacement for
//  Azure Service Bus — mandated 2026-08-28 by the user:
//  "I want it to be totally free but make the app works").
//
//  Service Bus (~$10/mo) → Azure Storage Queues ($0).
//  Storage Queues live in the Function App's existing host
//  storage account (`AzureWebJobsStorage`), so there is NO new
//  service, NO monthly fee, and NO Functions plan upgrade.
//
//  API is a drop-in for the old serviceBus.ts:
//    enqueue(name, body, { messageId, ttlSeconds, scheduledEnqueueTimeUtc })
//    ensureQueues()
//    closeServiceBus()
//
//  Local dev: AzureWebJobsStorage=UseDevelopmentStorage=true
//  Production: AzureWebJobsStorage=<existing function host storage>
// ============================================================

import {
  QueueClient,
  QueueServiceClient,
} from "@azure/storage-queue";

const QUEUES = {
  scrapeRequests: "scrape-requests",
  jobs: "jobs",
  resumeBuilds: "resume-builds",
} as const;

let _serviceClient: QueueServiceClient | null = null;
let _connString = "";

function getServiceClient(): QueueServiceClient {
  const conn = process.env.AzureWebJobsStorage ?? "";
  if (!conn) {
    throw new Error(
      "Azure Storage Queue not configured. Set AzureWebJobsStorage (the Function App host storage — already required by Functions).",
    );
  }
  if (_serviceClient && conn === _connString) return _serviceClient;
  _connString = conn;
  _serviceClient = QueueServiceClient.fromConnectionString(conn);
  return _serviceClient;
}

/** A lazily-created QueueClient (queues are cheap; create per call is fine). */
function getQueue(name: string): QueueClient {
  return getServiceClient().getQueueClient(name);
}

/**
 * Ensure the queues exist (idempotent; Storage createQueue is a no-op if the
 * queue already exists). Called at startup / on scrape.
 */
export async function ensureQueues(): Promise<void> {
  for (const name of Object.values(QUEUES)) {
    try {
      await getServiceClient().createQueue(name);
    } catch (err) {
      // QueueExists → fine; anything else → log and continue (send will retry).
      console.warn(`[storagequeue] ensureQueues(${name}) warning: ${err}`);
    }
  }
}

/**
 * Send a message to a Storage Queue with TTL + optional delay (visibility).
 * Returns the message id (used as azure_run_id for tracing).
 * Guards against a hung send with a timeout so HTTP triggers never hang.
 *
 * `scheduledEnqueueTimeUtc` — Storage Queues model delayed delivery as a
 * `visibilityTimeout` (seconds the message stays invisible after enqueue;
 * max ~7 days). Maps 1:1 from Service Bus scheduled delivery.
 */
export async function enqueue(
  queue: keyof typeof QUEUES,
  body: unknown,
  opts: {
    messageId?: string;
    ttlSeconds?: number;
    scheduledEnqueueTimeUtc?: Date;
  } = {},
): Promise<string> {
  const name = QUEUES[queue];
  const messageId = opts.messageId ?? crypto.randomUUID();
  const timeoutMs = opts.ttlSeconds
    ? Math.min(opts.ttlSeconds * 1000, 30_000)
    : 30_000;

  // Storage Queue visibility timeout (seconds) for delayed delivery.
  const visibilityTimeout = opts.scheduledEnqueueTimeUtc
    ? Math.max(
        0,
        Math.ceil(
          (opts.scheduledEnqueueTimeUtc.getTime() - Date.now()) / 1000,
        ),
      )
    : undefined;

  const client = getQueue(name);
  // Ensure the queue exists before sending (idempotent).
  await client.createIfNotExists().catch(() => {});
  // CRITICAL: the Functions runtime's storage queue trigger uses
  // `messageEncoding: base64` by default (host.json). The message content must
  // be BASE64-ENCODED or the trigger can't deserialize it → the message goes
  // straight to the poison queue WITHOUT the handler ever running (deq:0, no
  // last_error). Encode the JSON as base64 to match the runtime default.
  const text = Buffer.from(JSON.stringify(body), "utf-8").toString("base64");
  await Promise.race([
    client.sendMessage(text, {
      // Storage Queues assign the message ID server-side (unlike Service Bus),
      // so `messageId` is only our caller-facing trace id (returned below).
      ...(opts.ttlSeconds ? { messageTimeToLive: opts.ttlSeconds } : {}),
      ...(visibilityTimeout !== undefined
        ? { visibilityTimeout }
        : {}),
    }),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error("Storage Queue send timed out")),
        timeoutMs,
      ),
    ),
  ]);
  console.log(
    `[storagequeue] enqueued ${messageId} → ${name}${
      visibilityTimeout ? ` (delayed ${visibilityTimeout}s)` : ""
    }`,
  );
  return messageId;
}

/** Close any open clients (on app shutdown). No-op for lazy clients. */
export async function closeServiceBus(): Promise<void> {
  _serviceClient = null;
  _connString = "";
}
