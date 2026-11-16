import { connect } from "amqplib";
import { Writable } from "node:stream";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { postgresScheduling } from "../../src/scheduling/adapters/postgres/scheduling.ts";
import { messageUseCases } from "../../src/scheduling/application/messages.ts";
import { consumeWork } from "../../src/scheduling/adapters/rabbitmq/messaging.ts";
import { structuredNotificationWriter } from "../../src/scheduling/adapters/notification.ts";

const pool = createDatabasePool(process.env.DATABASE_URL!);
pool.on("error", () => {});
const connection = await connect(process.env.RABBITMQ_URL!);
connection.on("error", () => {});
const write = process.env.FAIL_OUTPUT === "true" ? (notification: Parameters<ReturnType<typeof structuredNotificationWriter>>[0]) => structuredNotificationWriter(new Writable({
  write(_chunk, _encoding, callback) { callback(new Error("Synthetic notification output failure")); },
}))(notification) : structuredNotificationWriter();
const messages = messageUseCases(postgresScheduling(pool), write);
const consumer = process.env.CONSUMER === "notification" ? "notification" : "allocation";
await consumeWork(connection, consumer, async (delivery) => {
  process.send?.({ phase: "received", delivery });
  if (process.env.PAUSE_BEFORE_EVENT_ID === delivery.eventId) await new Promise<void>((resolve) => process.once("message", () => resolve()));
  await (consumer === "notification" ? messages.notify(delivery) : messages.allocate(delivery));
  process.send?.({ phase: "committed", delivery });
  if (process.env.PAUSE_AFTER_COMMIT === "true") await new Promise<void>((resolve) => process.once("message", () => resolve()));
});
process.send?.({ phase: "ready" });
process.once("SIGTERM", () => {
  void (async () => { await connection.close(); await pool.end(); process.exit(0); })();
});
