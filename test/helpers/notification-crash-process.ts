import { connect } from "amqplib";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { postgresScheduling } from "../../src/scheduling/adapters/postgres/scheduling.ts";
import { messageUseCases } from "../../src/scheduling/application/messages.ts";
import { consumeWork } from "../../src/scheduling/adapters/rabbitmq/messaging.ts";
import { structuredNotificationWriter } from "../../src/scheduling/adapters/notification.ts";

const pool = createDatabasePool(process.env.DATABASE_URL!);
const connection = await connect(process.env.RABBITMQ_URL!); connection.on("error", () => {});
const write = structuredNotificationWriter();
const messages = messageUseCases(postgresScheduling(pool), async (notification) => {
  await write(notification);
  process.send?.({ phase: "written", eventId: notification.eventId });
  if (process.env.PAUSE_AFTER_OUTPUT_EVENT_ID === notification.eventId) await new Promise<void>(() => {});
});
await consumeWork(connection, "notification", async (delivery) => {
  await messages.notify(delivery); process.send?.({ phase: "committed", eventId: delivery.eventId });
});
process.send?.({ phase: "ready" });
process.once("SIGTERM", () => { void (async () => { await connection.close(); await pool.end(); process.exit(0); })(); });
