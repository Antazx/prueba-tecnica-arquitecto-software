import { spawn } from "node:child_process";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { eventually, freePort, postHold, startApiPair } from "../helpers/concurrency.ts";

it("bootstraps alongside the API and sweeps while RabbitMQ is unavailable, retaining outbox on restart", async () => {
  const databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; use an isolated test database");
  const admin = createDatabasePool(databaseUrl);
  const name = `expiry_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const isolated = new URL(databaseUrl);
  isolated.pathname = `/${name}`;
  const pool = createDatabasePool(isolated.toString());
  const port = await freePort();
  let logs = "";
  function startWorker() {
    const child = spawn(process.execPath, ["src/bootstrap/worker.ts"], { env: { ...process.env,
      DATABASE_URL: isolated.toString(), RABBITMQ_URL: "amqp://diagnostic:diagnostic_dev@127.0.0.1:1",
      HOST: "127.0.0.1", WORKER_HEALTH_PORT: String(port), EXPIRY_SWEEP_INTERVAL_MS: "50",
    }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (data: Buffer) => { logs += data.toString(); });
    child.stderr.on("data", (data: Buffer) => { logs += data.toString(); });
    return child;
  }
  async function stop(child: ReturnType<typeof startWorker>) {
    if (child.exitCode !== null) return;
    const exited = once(child, "exit");
    child.kill("SIGTERM");
    await exited;
  }
  let worker = startWorker();
  let pair: Awaited<ReturnType<typeof startApiPair>> | undefined;
  try {
    pair = await startApiPair(isolated.toString(), "expiry-worker", { DIRECT_HOLD_TTL_MS: "300" });
    await pool.query(`INSERT INTO scheduling.slots VALUES ('expiry-worker-slot', 'scanner-north-1', 'hospital-north', 'mri',
      date_trunc('milliseconds', clock_timestamp()) + interval '3 days',
      date_trunc('milliseconds', clock_timestamp()) + interval '3 days 30 minutes')`);
    const created = await postHold(pair.a, "expiry-worker-slot", "expiry-worker-hold", "patient-ana");
    expect(created.status).toBe(201);
    expect(Date.parse(created.body.expiresAt) - Date.parse(created.body.createdAt)).toBe(300);
    await eventually(async () => {
      if (worker.exitCode !== null) throw new Error(logs);
      return (await pool.query("SELECT state FROM scheduling.reservations WHERE id = $1", [created.body.id])).rows[0].state;
    }, (state) => state === "EXPIRED", 8000);
    const before = (await pool.query("SELECT * FROM scheduling.outbox_publications")).rows;
    expect(before).toHaveLength(1);
    expect(before[0].published_at).toBeNull();
    const health = await fetch(`http://127.0.0.1:${port}/health/ready`);
    expect(health.status).toBe(503);
    expect(await health.json()).toMatchObject({ dependencies: { postgres: "up", rabbitmq: "down" } });
    await stop(worker);
    worker = startWorker();
    await eventually(async () => {
      try {
        const health = await fetch(`http://127.0.0.1:${port}/health/ready`);
        const body = await health.json() as { dependencies: { postgres: string } };
        return body.dependencies.postgres === "up";
      } catch { return false; }
    }, Boolean, 8000);
    expect((await pool.query("SELECT * FROM scheduling.outbox_publications")).rows).toEqual(before);
  } catch (error) { throw new Error(`Worker logs: ${logs}`, { cause: error }); }
  finally { await stop(worker); await pair?.stop(); await pool.end(); }
}, 20000);
