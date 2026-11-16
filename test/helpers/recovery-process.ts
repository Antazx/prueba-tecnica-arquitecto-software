import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { postgresScheduling } from "../../src/scheduling/adapters/postgres/scheduling.ts";
import { recoverMessage } from "../../src/scheduling/application/recovery.ts";
import { recoverDlq } from "../../src/scheduling/adapters/rabbitmq/recovery.ts";
import { connectToRabbitMq, closeRabbitMq } from "../../src/scheduling/adapters/rabbitmq/connection.ts";

const pool = createDatabasePool(process.env.DATABASE_URL!); pool.on("error", () => {});
const connection = await connectToRabbitMq(process.env.RABBITMQ_URL!); connection.on("error", () => {});
process.once("SIGTERM", () => { void (async () => { await closeRabbitMq(connection); await pool.end(); process.exit(0); })(); });
process.send?.({ phase: "ready" });
try {
  const result = await recoverDlq(connection, { consumer: "allocation", publicationId: process.env.PUBLICATION_ID!, scanLimit: 100,
    operator: "synthetic-process-operator", reason: "Synthetic cause repaired" }, async (request) => {
    process.send?.({ phase: "received" });
    if (process.env.PAUSE_BEFORE_SQL === "true") await new Promise<void>((resolve) => process.once("message", () => resolve()));
    const recovered = await recoverMessage(postgresScheduling(pool), request);
    process.send?.({ phase: "committed", result: recovered });
    if (process.env.PAUSE_AFTER_COMMIT === "true") await new Promise<void>((resolve) => process.once("message", () => resolve()));
    return recovered;
  });
  process.send?.({ phase: "acknowledged", result });
} finally { await closeRabbitMq(connection); await pool.end(); }
