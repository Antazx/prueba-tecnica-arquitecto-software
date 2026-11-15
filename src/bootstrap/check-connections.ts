import { randomUUID } from "node:crypto";
import { readWorkerConfig } from "../config/environment.ts";
import { checkDatabase, createDatabasePool } from "../scheduling/adapters/postgres/database.ts";
import { connectToRabbitMq } from "../scheduling/adapters/rabbitmq/connection.ts";

async function main() {
  const config = readWorkerConfig();
  const pool = createDatabasePool(config.databaseUrl);
  pool.on("error", () => {});
  try {
    await checkDatabase(pool);
    const connection = await connectToRabbitMq(config.rabbitmqUrl);
    connection.on("error", () => {});
    try {
      const channel = await connection.createConfirmChannel();
      const { queue } = await channel.assertQueue("", { exclusive: true, autoDelete: true });
      const expected = Buffer.from(`diagnostic-appointments-setup:${randomUUID()}`);
      channel.sendToQueue(queue, expected);
      await channel.waitForConfirms();
      const received = await channel.get(queue, { noAck: false });
      if (!received || !received.content.equals(expected)) {
        throw new Error("RabbitMQ did not return the setup probe message");
      }
      channel.ack(received);
      await channel.close();
      console.info("PostgreSQL scheduling schema and RabbitMQ confirmed round trip: OK");
    } finally {
      await connection.close();
    }
  } finally {
    await pool.end();
  }
}

main().catch((error: unknown) => {
  console.error("Connection check failed:", error);
  process.exitCode = 1;
});
