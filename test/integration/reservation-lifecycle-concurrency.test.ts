import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../../src/scheduling/adapters/postgres/initialize.ts";
import { awaitBlocked, eventually, freePort, holdScope, postHold, startApiPair } from "../helpers/concurrency.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; use an isolated test database");
const pool = createDatabasePool(databaseUrl);
let pair: Awaited<ReturnType<typeof startApiPair>>;
beforeAll(async () => { await initializeDatabase(pool); pair = await startApiPair(databaseUrl, "lifecycle-race"); }, 15000);
afterEach(async (context) => {
  if (context.task.result?.state === "fail") process.stdout.write(`API A: ${pair.a.logs()}\nAPI B: ${pair.b.logs()}\n`);
  await pool.query("DELETE FROM scheduling.http_creation_results WHERE idempotency_key LIKE 'lifecycle-race-%'");
  await pool.query("DELETE FROM scheduling.outbox_publications WHERE event_id IN (SELECT event_id FROM scheduling.reservation_closures WHERE reservation_id IN (SELECT id FROM scheduling.reservations WHERE slot_id LIKE 'lifecycle-race-%'))");
  await pool.query("DELETE FROM scheduling.reservation_closures WHERE reservation_id IN (SELECT id FROM scheduling.reservations WHERE slot_id LIKE 'lifecycle-race-%')");
  await pool.query("DELETE FROM scheduling.events WHERE payload->>'slotId' LIKE 'lifecycle-race-%'");
  await pool.query("DELETE FROM scheduling.reservations WHERE slot_id LIKE 'lifecycle-race-%'");
  await pool.query("DELETE FROM scheduling.slots WHERE id LIKE 'lifecycle-race-%'");
});
afterAll(async () => { await pair?.stop(); await pool.end(); });

async function hold(name: string) {
  const slotId = `lifecycle-race-${name}`;
  await pool.query(`INSERT INTO scheduling.slots VALUES ($1, 'scanner-north-1', 'hospital-north', 'mri',
    date_trunc('milliseconds', clock_timestamp()) + interval '3 days',
    date_trunc('milliseconds', clock_timestamp()) + interval '3 days 30 minutes')`, [slotId]);
  const result = await postHold(pair.a, slotId, slotId, "patient-ana");
  expect(result.status).toBe(201);
  return result.body as { id: string; slotId: string };
}
async function transition(api: { url: string }, id: string, action: "confirm" | "cancel") {
  const response = await fetch(`${api.url}/reservations/${id}/${action}`, { method: "POST", headers: { "x-patient-id": "patient-ana" } });
  return { status: response.status, body: await response.json() };
}
async function rowBarrier(id: string) {
  const client = await pool.connect();
  await client.query("BEGIN");
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await client.query("SELECT id FROM scheduling.reservations WHERE id = $1 FOR UPDATE", [id]);
  let released = false;
  return { pid, release: async () => {
    if (released) return;
    released = true;
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  } };
}
async function startWorker() {
  const port = await freePort();
  const url = new URL(databaseUrl!);
  const applicationName = "lifecycle-race-worker";
  url.searchParams.set("application_name", applicationName);
  const child = spawn(process.execPath, ["src/bootstrap/worker.ts"], { env: { ...process.env,
    DATABASE_URL: url.toString(), RABBITMQ_URL: "amqp://diagnostic:diagnostic_dev@127.0.0.1:1", HOST: "127.0.0.1",
    WORKER_HEALTH_PORT: String(port), EXPIRY_SWEEP_INTERVAL_MS: "50",
  }, stdio: ["ignore", "pipe", "pipe"] });
  let logs = "";
  child.stdout.on("data", (data: Buffer) => { logs += data.toString(); });
  child.stderr.on("data", (data: Buffer) => { logs += data.toString(); });
  return { applicationName, healthUrl: `http://127.0.0.1:${port}/health/ready`, stop: async () => {
    if (child.exitCode !== null) throw new Error(`Worker exited unexpectedly: ${logs}`);
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
  } };
}
async function expectOneExpiry(id: string) {
  expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id = $1", [id])).rows[0].state).toBe("EXPIRED");
  const releases = (await pool.query("SELECT reason FROM scheduling.reservation_closures WHERE reservation_id = $1", [id])).rows;
  expect(releases).toEqual([{ reason: "EXPIRED" }]);
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.events e JOIN scheduling.outbox_publications p ON p.event_id=e.id WHERE e.payload->>'reservationId'=$1", [id])).rows[0].count).toBe(1);
}

it("rechecks PostgreSQL time after two APIs wait across expiry, racing the periodic worker", async () => {
  const reservation = await hold("cross-deadline");
  const worker = await startWorker();
  try {
    await eventually(async () => {
      try {
        const health = await fetch(worker.healthUrl);
        const body = await health.json() as { dependencies: { postgres: string } };
        return body.dependencies.postgres === "up";
      } catch { return false; }
    }, Boolean, 8000);
  } catch (error) { await worker.stop(); throw error; }
  const deadline = (await pool.query<{ expires_at: Date }>(`UPDATE scheduling.reservations SET expires_at = date_trunc('milliseconds', clock_timestamp()) + interval '900 milliseconds'
    WHERE id = $1 RETURNING expires_at`, [reservation.id])).rows[0].expires_at;
  const barrier = await holdScope(pool, "hospital-north", "mri");
  const confirming = transition(pair.a, reservation.id, "confirm");
  const cancelling = transition(pair.b, reservation.id, "cancel");
  try {
    const waiting = await awaitBlocked(pool, [pair.a.applicationName, pair.b.applicationName], barrier.pid);
    for (const request of waiting) {
      expect(request.xact_start.getTime()).toBeLessThan(deadline.getTime());
      expect(request.query_start.getTime()).toBeLessThan(deadline.getTime());
    }
    await eventually(async () => (await pool.query<{ reached: boolean }>("SELECT date_trunc('milliseconds', clock_timestamp()) >= $1 AS reached", [deadline])).rows[0].reached, Boolean);
    await awaitBlocked(pool, [pair.a.applicationName, pair.b.applicationName, worker.applicationName], barrier.pid);
  } catch (error) {
    await barrier.release();
    await worker.stop();
    throw error;
  } finally { await barrier.release(); }
  try {
    for (const response of await Promise.all([confirming, cancelling])) {
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ id: reservation.id, state: "EXPIRED", code: "RESERVATION_EXPIRED" });
    }
    await expectOneExpiry(reservation.id);
  } finally { await worker.stop(); }
});

it("lets the worker win expiry under its scope before queued confirmation and cancellation", async () => {
  const reservation = await hold("worker-first");
  await pool.query("UPDATE scheduling.reservations SET created_at = created_at - interval '20 minutes', expires_at = expires_at - interval '20 minutes' WHERE id = $1", [reservation.id]);
  const barrier = await rowBarrier(reservation.id);
  const worker = await startWorker();
  let confirming: ReturnType<typeof transition> | undefined;
  let cancelling: ReturnType<typeof transition> | undefined;
  try {
    await awaitBlocked(pool, [worker.applicationName], barrier.pid);
    confirming = transition(pair.a, reservation.id, "confirm");
    cancelling = transition(pair.b, reservation.id, "cancel");
    await awaitBlocked(pool, [worker.applicationName, pair.a.applicationName, pair.b.applicationName], barrier.pid);
  } catch (error) {
    await barrier.release();
    await worker.stop();
    throw error;
  } finally { await barrier.release(); }
  try {
    for (const response of await Promise.all([confirming!, cancelling!])) expect(response).toMatchObject({ status: 409, body: { id: reservation.id, state: "EXPIRED", code: "RESERVATION_EXPIRED" } });
    await expectOneExpiry(reservation.id);
  } finally { await worker.stop(); }
});

it("serializes confirmation then cancellation through two processes without duplicate release", async () => {
  const reservation = await hold("confirm-first");
  const barrier = await rowBarrier(reservation.id);
  const confirming = transition(pair.a, reservation.id, "confirm");
  let cancelling: ReturnType<typeof transition> | undefined;
  try {
    await awaitBlocked(pool, [pair.a.applicationName], barrier.pid);
    cancelling = transition(pair.b, reservation.id, "cancel");
    await awaitBlocked(pool, [pair.a.applicationName, pair.b.applicationName], barrier.pid);
  } finally { await barrier.release(); }
  expect(await confirming).toMatchObject({ status: 200, body: { id: reservation.id, state: "CONFIRMED" } });
  expect(await cancelling).toMatchObject({ status: 200, body: { id: reservation.id, state: "CANCELLED" } });
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.events WHERE payload->>'reservationId'=$1", [reservation.id])).rows[0].count).toBe(1);
});
