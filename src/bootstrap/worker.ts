import { setTimeout as delay } from "node:timers/promises";
import type { ChannelModel } from "amqplib";
import { readWorkerConfig } from "../config/environment.ts";
import { createWorkerHealthServer, type WorkerHealth } from "../scheduling/adapters/http/worker-health.ts";
import { checkDatabase, createDatabasePool } from "../scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../scheduling/adapters/postgres/initialize.ts";
import { postgresScheduling } from "../scheduling/adapters/postgres/scheduling.ts";
import { schedulingUseCases } from "../scheduling/application/reservations.ts";
import { connectToRabbitMq } from "../scheduling/adapters/rabbitmq/connection.ts";

async function main() {
  const config = readWorkerConfig();
  const state: WorkerHealth = { postgres: false, rabbitmq: false };
  const pool = createDatabasePool(config.databaseUrl);
  const healthServer = createWorkerHealthServer(state);
  const controller = new AbortController();
  let connection: ChannelModel | undefined;
  let initialized = false;
  const scheduling = schedulingUseCases(postgresScheduling(pool));

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
        if (!initialized) {
          // API and worker serialize schema/seed initialization with the same bootstrap lock.
          await initializeDatabase(pool);
          initialized = true;
        }
        await checkDatabase(pool);
        await scheduling.expireDirectHolds();
        state.postgres = true;
      } catch (error) {
        initialized = false;
        state.postgres = false;
        console.warn(JSON.stringify({ event: "expiry_sweep_failed", message: error instanceof Error ? error.message : "Unknown error" }));
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
      await delay(config.expirySweepIntervalMs, undefined, { signal: controller.signal }).catch((error: unknown) => {
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
