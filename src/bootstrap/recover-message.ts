import { parseArgs } from "node:util";
import { checkDatabase, createDatabasePool } from "../scheduling/adapters/postgres/database.ts";
import { postgresScheduling } from "../scheduling/adapters/postgres/scheduling.ts";
import { readRecoveryPublication } from "../scheduling/adapters/postgres/recovery.ts";
import { closeRabbitMq, connectToRabbitMq } from "../scheduling/adapters/rabbitmq/connection.ts";
import { recoverDlq } from "../scheduling/adapters/rabbitmq/recovery.ts";
import { recoverMessage } from "../scheduling/application/recovery.ts";

async function main() {
  const { values } = parseArgs({ options: {
    mode: { type: "string" }, "publication-id": { type: "string" }, consumer: { type: "string" },
    operator: { type: "string" }, reason: { type: "string" }, "scan-limit": { type: "string", default: "100" },
  } });
  const publicationId = values["publication-id"];
  if (!["dlq", "persisted"].includes(values.mode ?? "") || !publicationId ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(publicationId) ||
    !values.operator?.trim() || !values.reason?.trim()) {
    throw new Error("Usage: --mode dlq|persisted --publication-id UUID --operator NAME --reason TEXT [--consumer allocation|notification --scan-limit 100]");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const pool = createDatabasePool(databaseUrl);
  pool.on("error", () => {});
  try {
    await checkDatabase(pool);
    const scheduling = postgresScheduling(pool);
    let result;
    if (values.mode === "persisted") {
      const delivery = await readRecoveryPublication(pool, publicationId);
      result = await recoverMessage(scheduling, { delivery, source: "persisted", operator: values.operator, reason: values.reason });
    } else {
      if (values.consumer !== "allocation" && values.consumer !== "notification") throw new Error("DLQ recovery requires an explicit consumer");
      if (!process.env.RABBITMQ_URL) throw new Error("RABBITMQ_URL is required for DLQ recovery");
      const connection = await connectToRabbitMq(process.env.RABBITMQ_URL);
      connection.on("error", () => {});
      try {
        result = await recoverDlq(connection, { consumer: values.consumer, publicationId, scanLimit: Number(values["scan-limit"]),
          operator: values.operator, reason: values.reason }, (request) => recoverMessage(scheduling, request));
      } finally { await closeRabbitMq(connection); }
    }
    console.info(JSON.stringify({ event: "manual_recovery", selectedPublicationId: publicationId, ...result }));
  } finally { await pool.end(); }
}
main().catch((error: unknown) => {
  console.error(JSON.stringify({ event: "manual_recovery_failed", message: error instanceof Error ? error.message : "Unknown error" }));
  process.exitCode = 1;
});
