import { connect } from "amqplib";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { postgresScheduling } from "../../src/scheduling/adapters/postgres/scheduling.ts";
import { messageUseCases } from "../../src/scheduling/application/messages.ts";
import { assertTopology, consumeWork } from "../../src/scheduling/adapters/rabbitmq/messaging.ts";
import { structuredNotificationWriter } from "../../src/scheduling/adapters/notification.ts";

const pool = createDatabasePool(process.env.DATABASE_URL!);
const connection = await connect(process.env.RABBITMQ_URL!);
connection.on("error", () => {});
const topology = await connection.createChannel();
await assertTopology(topology); await topology.close();
const messages = messageUseCases(postgresScheduling(pool), structuredNotificationWriter());
await consumeWork(connection, "allocation", async (delivery) => {
  await messages.allocate(delivery);
  process.send?.({ phase: "committed", eventId: delivery.eventId });
  if (process.env.PAUSE_AFTER_COMMIT === "true") await new Promise<void>((resolve) => process.once("message", () => resolve()));
});
process.send?.({ phase: "ready" });
process.once("SIGTERM", () => {
  void (async () => { await connection.close(); await pool.end(); process.exit(0); })();
});
