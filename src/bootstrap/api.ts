import { readApiConfig } from "../config/environment.ts";
import { buildApi } from "../scheduling/adapters/http/api.ts";
import { checkDatabase, createDatabasePool } from "../scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../scheduling/adapters/postgres/initialize.ts";
import { listSlots } from "../scheduling/adapters/postgres/slots.ts";

async function main() {
  const config = readApiConfig();
  const pool = createDatabasePool(config.databaseUrl);
  const api = buildApi(() => checkDatabase(pool), (query) => listSlots(pool, query));
  pool.on("error", (error) => api.log.warn({ err: error }, "PostgreSQL connection lost"));

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await api.close();
    await pool.end();
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      stop().catch((error) => {
        api.log.error(error, "API shutdown failed");
        process.exitCode = 1;
      });
    });
  }

  try {
    await initializeDatabase(pool);
    await api.listen({ host: config.host, port: config.port });
  } catch (error) {
    await stop();
    throw error;
  }
}

main().catch((error: unknown) => {
  console.error("Diagnostic appointment API failed to start:", error);
  process.exitCode = 1;
});
