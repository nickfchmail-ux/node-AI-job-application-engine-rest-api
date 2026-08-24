// ============================================================
//  Azure Service Bus sender helper.
//
//  Local dev: ServiceBus__connectionString (SAS)
//  Production: ServiceBus__fullyQualifiedNamespace + Managed Identity
//              (ServiceBus__credential = "managedidentity")
// ============================================================

import {
  ServiceBusAdministrationClient,
  ServiceBusClient,
  ServiceBusSender,
} from "@azure/service-bus";

const QUEUES = {
  scrapeRequests: "scrape-requests",
  jobs: "jobs",
  resumeBuilds: "resume-builds",
} as const;

let _client: ServiceBusClient | null = null;
let _admin: ServiceBusAdministrationClient | null = null;
const senders = new Map<string, ServiceBusSender>();

function getClient(): ServiceBusClient {
  if (_client) return _client;

  const connStr = process.env.ServiceBus__connectionString;
  const fqns = process.env.ServiceBus__fullyQualifiedNamespace;
  const credentialType =
    process.env.ServiceBus__credential ?? "connectionstring";

  if (connStr) {
    _client = new ServiceBusClient(connStr);
  } else if (fqns && credentialType === "managedidentity") {
    // Managed Identity (DefaultAzureCredential) — works in Azure & via az login locally
    const { DefaultAzureCredential } =
      require("@azure/identity") as typeof import("@azure/identity");
    _client = new ServiceBusClient(fqns, new DefaultAzureCredential());
  } else {
    throw new Error(
      "Service Bus not configured. Set ServiceBus__connectionString (local) or ServiceBus__fullyQualifiedNamespace + ServiceBus__credential=managedidentity (prod).",
    );
  }
  return _client;
}

function getAdmin(): ServiceBusAdministrationClient {
  if (_admin) return _admin;
  const connStr = process.env.ServiceBus__connectionString;
  if (connStr) {
    _admin = new ServiceBusAdministrationClient(connStr);
  } else {
    const fqns = process.env.ServiceBus__fullyQualifiedNamespace;
    if (!fqns) {
      throw new Error(
        "Service Bus not configured for admin client: missing connectionString or fullyQualifiedNamespace.",
      );
    }
    const { DefaultAzureCredential } =
      require("@azure/identity") as typeof import("@azure/identity");
    _admin = new ServiceBusAdministrationClient(
      fqns,
      new DefaultAzureCredential(),
    );
  }
  return _admin;
}

function getSender(queue: keyof typeof QUEUES): ServiceBusSender {
  const name = QUEUES[queue];
  const existing = senders.get(name);
  if (existing) return existing;
  const sender = getClient().createSender(name);
  senders.set(name, sender);
  return sender;
}

/**
 * Send a message to a queue with duplicate-detection + TTL.
 * Returns the message id (used as azure_run_id for tracing).
 * Guards against a hung sender with a timeout so HTTP triggers
 * (POST /api/scrape) never hang on a dead Service Bus.
 */
export async function enqueue(
  queue: keyof typeof QUEUES,
  body: unknown,
  opts: { messageId?: string; ttlSeconds?: number } = {},
): Promise<string> {
  const sender = getSender(queue);
  const messageId = opts.messageId ?? crypto.randomUUID();
  const timeoutMs = opts.ttlSeconds ? Math.min(opts.ttlSeconds * 1000, 30_000) : 30_000;
  await Promise.race([
    sender.sendMessages({
      body,
      messageId,
      timeToLive: opts.ttlSeconds ? opts.ttlSeconds * 1000 : undefined, // ms
    }),
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("Service Bus send timed out")), timeoutMs),
    ),
  ]);
  console.log(`[servicebus] enqueued ${messageId} → ${QUEUES[queue]}`);
  return messageId;
}

/** Ensure the two queues exist (provision at startup / local dev). */
export async function ensureQueues(): Promise<void> {
  const admin = getAdmin();
  for (const name of Object.values(QUEUES)) {
    try {
      const exists = await admin
        .getQueueRuntimeProperties(name)
        .catch(() => null);
      if (!exists) {
        await admin.createQueue(name, {
          defaultMessageTimeToLive: "P2D", // ISO 8601 duration: 2 days
          maxDeliveryCount: 5,
          duplicateDetectionHistoryTimeWindow: "PT10M", // 10 minutes
          deadLetteringOnMessageExpiration: true,
        });
        console.log(`[servicebus] created queue ${name}`);
      }
    } catch (err) {
      console.warn(`[servicebus] ensureQueues(${name}) warning: ${err}`);
    }
  }
}

/** Close all senders (on app shutdown). */
export async function closeServiceBus(): Promise<void> {
  for (const sender of senders.values()) {
    await sender.close().catch(() => {});
  }
  senders.clear();
  await _client?.close().catch(() => {});
  _client = null;
}
