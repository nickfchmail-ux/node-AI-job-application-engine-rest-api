// ============================================================
//  smoke-test-eventhub.js — send a harmless test event to the
//  `jobs` event hub and print the result. Proves the producer →
//  Event Hub → consumer path works end-to-end.
//
//  Usage: node smoke-test-eventhub.js "<connection-string>"
// ============================================================
const { EventHubProducerClient } = require("@azure/event-hubs");

async function main() {
  const connStr = process.argv[2];
  if (!connStr) {
    console.error("usage: node smoke-test-eventhub.js '<connection-string>'");
    process.exit(1);
  }

  const client = new EventHubProducerClient(connStr, "jobs");
  const testEvent = {
    op: "board-count",
    runId: "smoke-test-run",
    board: "smoketest",
    userId: null,
    delta: { jobs_found: 0, jobs_processed: 0, jobs_failed: 0, duplicate: 0 },
  };

  const batch = await client.createBatch({ partitionKey: "smoke-test-run" });
  batch.tryAdd({ body: testEvent });
  await client.sendBatch(batch);
  console.log("✅ Sent test event to Event Hub 'jobs' (partition smoke-test-run)");
  await client.close();
}

main().catch((err) => {
  console.error("❌ Send failed:", err.message);
  process.exit(1);
});
