import { setTimeout as delay } from "node:timers/promises";
import type { ChannelModel } from "amqplib";
import { readWorkerConfig } from "../config/environment.ts";
import { createWorkerHealthServer, type WorkerHealth } from "../scheduling/adapters/http/worker-health.ts";
import { checkDatabase, createDatabasePool } from "../scheduling/adapters/postgres/database.ts";
import { connectToRabbitMq } from "../scheduling/adapters/rabbitmq/connection.ts";

async function main() {
  const config = readWorkerConfig();
  const state: WorkerHealth = { postgres: false, rabbitmq: false };
  const pool = createDatabasePool(config.databaseUrl);
  const healthServer = createWorkerHealthServer(state);
  const controller = new AbortController();
  let connection: ChannelModel | undefined;

  pool.on("error", () => { state.postgres = false; });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => controller.abort());
  }

  try {
    await new Promise<void>((resolve, reject) => {
      healthServer.once("error", reject);
      healthServer.listen(config.healthPort, config.host, resolve);
    });

    while (!controller.signal.aborted) {
      const wasReady = state.postgres && state.rabbitmq;
      try {
        await checkDatabase(pool);
        state.postgres = true;
      } catch {
        state.postgres = false;
      }

      if (!connection) {
        try {
          const opened = await connectToRabbitMq(config.rabbitmqUrl);
          connection = opened;
          state.rabbitmq = true;
          opened.on("error", () => { state.rabbitmq = false; });
          opened.once("close", () => {
            if (connection === opened) connection = undefined;
            state.rabbitmq = false;
            if (!controller.signal.aborted) {
              console.warn(JSON.stringify({ event: "rabbitmq_disconnected", service: "diagnostic-appointments-worker" }));
            }
          });
        } catch {
          state.rabbitmq = false;
        }
      }

      const ready = state.postgres && state.rabbitmq;
      if (ready !== wasReady) {
        console.info(JSON.stringify({ event: ready ? "worker_ready" : "worker_not_ready", dependencies: state }));
      }
      await delay(3000, undefined, { signal: controller.signal }).catch((error: unknown) => {
        if (!controller.signal.aborted) throw error;
      });
    }
  } finally {
    state.postgres = false;
    state.rabbitmq = false;
    await connection?.close().catch(() => {});
    await pool.end();
    await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  console.error("Diagnostic appointment worker failed:", error);
  process.exitCode = 1;
});
