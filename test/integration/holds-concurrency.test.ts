import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { createConnection } from "node:net";
import { once } from "node:events";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../../src/scheduling/adapters/postgres/initialize.ts";
import { awaitBlocked, eventually, holdScope, postHold, startApiPair } from "../helpers/concurrency.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; use an isolated test database");
const pool = createDatabasePool(databaseUrl);
let pair: Awaited<ReturnType<typeof startApiPair>>;
beforeAll(async () => {
  await initializeDatabase(pool);
  pair = await startApiPair(databaseUrl, "hold-test");
}, 15000);
afterEach(async (context) => {
  if (context.task.result?.state === "fail" && pair) {
    process.stdout.write(`API A logs:\n${pair.a.logs()}\nAPI B logs:\n${pair.b.logs()}\n`);
  }
  await pool.query("DELETE FROM scheduling.http_creation_results WHERE idempotency_key LIKE 'hold-test-%'");
  await pool.query("DELETE FROM scheduling.reservations WHERE slot_id LIKE 'hold-test-%'");
  await pool.query("DELETE FROM scheduling.slots WHERE id LIKE 'hold-test-%'");
});
afterAll(async () => { await pair?.stop(); await pool.end(); });

async function slot(id: string, hospital = "hospital-north", offset = "3 days") {
  await pool.query(`INSERT INTO scheduling.slots
    SELECT $1, id, hospital_id, test_type_id, date_trunc('milliseconds', clock_timestamp()) + $3::interval,
      date_trunc('milliseconds', clock_timestamp()) + $3::interval + interval '30 minutes'
    FROM scheduling.diagnostic_resources WHERE id = $2`, [id, hospital === "hospital-north" ? "scanner-north-1" : "scanner-south-1", offset]);
}

it("admits exactly one of three competing patients through two API processes after observed lock waits", async () => {
  await slot("hold-test-race");
  const barrier = await holdScope(pool, "hospital-north", "mri");
  const requests = [
    postHold(pair.a, "hold-test-race", "hold-test-race-a", "patient-ana"),
    postHold(pair.b, "hold-test-race", "hold-test-race-b", "patient-bruno"),
    postHold(pair.a, "hold-test-race", "hold-test-race-c", "patient-carlos"),
  ];
  try { await awaitBlocked(pool, [pair.a.applicationName, pair.b.applicationName], barrier.pid, 3); }
  finally { await barrier.release(); }
  const responses = await Promise.all(requests);
  expect(responses.map((response) => response.status).sort()).toEqual([201, 409, 409]);
  expect(responses.filter((response) => response.status === 409).map((response) => response.body)).toEqual([
    { code: "SLOT_OCCUPIED" }, { code: "SLOT_OCCUPIED" },
  ]);
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.reservations WHERE slot_id = 'hold-test-race' AND state IN ('HELD', 'OFFERED', 'CONFIRMED')")).rows[0].count).toBe(1);
});

it("lets a distinct scope commit while another API is still waiting on its own scope", async () => {
  await slot("hold-test-independent-a");
  await slot("hold-test-independent-b", "hospital-south");
  const barrier = await holdScope(pool, "hospital-north", "mri");
  const blocked = postHold(pair.a, "hold-test-independent-a", "hold-test-independent-a", "patient-ana");
  try {
    await awaitBlocked(pool, [pair.a.applicationName], barrier.pid);
    const independent = await postHold(pair.b, "hold-test-independent-b", "hold-test-independent-b", "patient-bruno");
    expect(independent.status).toBe(201);
    await awaitBlocked(pool, [pair.a.applicationName], barrier.pid);
  } finally { await barrier.release(); }
  expect((await blocked).status).toBe(201);
});

it("coordinates the same patient and key between instances, preserving the original deadline and 201", async () => {
  await slot("hold-test-same-key");
  await slot("hold-test-same-key-other", "hospital-north", "4 days");
  const barrier = await holdScope(pool, "hospital-north", "mri");
  const first = postHold(pair.a, "hold-test-same-key", "hold-test-same-key", "patient-ana");
  let second: ReturnType<typeof postHold> | undefined;
  try {
    await awaitBlocked(pool, [pair.a.applicationName], barrier.pid);
    second = postHold(pair.b, "hold-test-same-key", "hold-test-same-key", "patient-ana");
    // B waits on A's technical key; A waits on the controller's scope.
    await awaitBlocked(pool, [pair.a.applicationName, pair.b.applicationName], barrier.pid);
  } finally { await barrier.release(); }
  const [a, b] = await Promise.all([first, second]);
  expect(a.status).toBe(201);
  expect(b).toEqual(a);
  expect(await postHold(pair.b, "hold-test-same-key-other", "hold-test-same-key", "patient-ana"))
    .toEqual({ status: 409, body: { code: "IDEMPOTENCY_KEY_REUSED" } });
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.reservations WHERE slot_id = 'hold-test-same-key'")).rows[0].count).toBe(1);
});

it("recovers the committed original result after a client disconnects without reading its response", async () => {
  await slot("hold-test-response-lost");
  const address = new URL(pair.a.url);
  const socket = createConnection({ host: address.hostname, port: Number(address.port) });
  try {
    await once(socket, "connect");
    // The client never reads a response: it disconnects after independently observing commit.
    socket.pause();
    socket.write(`POST /slots/hold-test-response-lost/holds HTTP/1.1\r\nHost: ${address.host}\r\nX-Patient-Id: patient-ana\r\nIdempotency-Key: hold-test-response-lost\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    const committed = await eventually(async () => (await pool.query<{ status_code: number; response_body: unknown }>(`
      SELECT status_code, response_body FROM scheduling.http_creation_results
      WHERE patient_id = 'patient-ana' AND operation = 'create-hold' AND idempotency_key = 'hold-test-response-lost'
        AND response_body IS NOT NULL`)).rows[0], (row) => row !== undefined);
    socket.destroy();
    const replay = await postHold(pair.b, "hold-test-response-lost", "hold-test-response-lost", "patient-ana");
    expect(replay).toEqual({ status: committed.status_code, body: committed.response_body });
    expect(replay.status).toBe(201);
  } finally { socket.destroy(); }
});

it("uses PostgreSQL time after waiting: a slot that starts during the wait cannot be held", async () => {
  await slot("hold-test-starts-during-wait", "hospital-north", "1200 milliseconds");
  const start = (await pool.query<{ starts_at: Date }>("SELECT starts_at FROM scheduling.slots WHERE id = 'hold-test-starts-during-wait'")).rows[0].starts_at;
  const barrier = await holdScope(pool, "hospital-north", "mri");
  const request = postHold(pair.a, "hold-test-starts-during-wait", "hold-test-starts-during-wait", "patient-ana");
  try {
    const waiting = await awaitBlocked(pool, [pair.a.applicationName], barrier.pid);
    expect(waiting[0].xact_start.getTime()).toBeLessThan(start.getTime());
    await eventually(async () => (await pool.query<{ reached: boolean }>("SELECT date_trunc('milliseconds', clock_timestamp()) >= $1 AS reached", [start])).rows[0].reached, Boolean);
  } finally { await barrier.release(); }
  expect(await request).toEqual({ status: 409, body: { code: "SLOT_STARTED" } });
});

it("reports a real PostgreSQL lock timeout as transient 503 and permits the same key to retry", async () => {
  await slot("hold-test-lock-timeout");
  const barrier = await holdScope(pool, "hospital-north", "mri");
  const request = postHold(pair.a, "hold-test-lock-timeout", "hold-test-lock-timeout", "patient-ana");
  try {
    await awaitBlocked(pool, [pair.a.applicationName], barrier.pid);
    expect(await request).toEqual({ status: 503, body: { code: "DEPENDENCY_UNAVAILABLE" } });
  } finally { await barrier.release(); }
  expect((await postHold(pair.b, "hold-test-lock-timeout", "hold-test-lock-timeout", "patient-ana")).status).toBe(201);
});
