// Peek at the dead-letter message to see why the scraper worker failed
import { ServiceBusClient } from "@azure/service-bus";

async function main() {
  const connStr = process.env.SB_CONNECTION_STRING!;
  const client = new ServiceBusClient(connStr);
  const receiver = client.createReceiver("scrape-requests", {
    subQueueType: "deadLetter",
  });
  const messages = await receiver.peekMessages(10);
  for (const m of messages) {
    console.log("=== dead-letter message ===");
    console.log("messageId:", m.messageId);
    console.log("deadLetterReason:", m.deadLetterReason);
    console.log(
      "deadLetterErrorDescription:",
      m.deadLetterErrorDescription?.slice(0, 500),
    );
    console.log("body:", JSON.stringify(m.body).slice(0, 300));
  }
  await receiver.close();
  await client.close();
}
main().catch((e) => {
  console.error("ERR:", e.message);
  process.exit(1);
});
