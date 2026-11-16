import { connect } from "amqplib";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { postgresOutbox } from "../../src/scheduling/adapters/postgres/outbox.ts";
import { assertTopology, publishDelivery } from "../../src/scheduling/adapters/rabbitmq/messaging.ts";
import { relayReadyPublications } from "../../src/scheduling/application/outbox.ts";

const pool = createDatabasePool(process.env.DATABASE_URL!);
const outbox = postgresOutbox(pool);
const connection = await connect(process.env.RABBITMQ_URL!);
connection.on("error", () => {});
const channel = await connection.createConfirmChannel();
await assertTopology(channel);
const delivery = (await outbox.ready()).find((delivery) => delivery.publicationId === process.env.PUBLICATION_ID);
if (!delivery) throw new Error("Expected pending test publication");
await relayReadyPublications({ ...outbox, ready: async () => [delivery] }, async (pending) => {
  const result = await publishDelivery(channel, pending);
  if (result.accepted) {
    process.send?.({ phase: "accepted", delivery: pending });
    if (process.env.PAUSE_AFTER_CONFIRM === "true") await new Promise<void>((resolve) => process.once("message", () => resolve()));
  }
  return result;
}, Number(process.env.OUTBOX_RETRY_DELAY_MS ?? 5000));
process.send?.({ phase: "recorded" });
await channel.close(); await connection.close(); await pool.end();
process.disconnect?.();
