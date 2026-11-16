import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../../src/scheduling/adapters/postgres/initialize.ts";
import { awaitBlocked, eventually, holdScope, postHold, startApiPair } from "../helpers/concurrency.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; use an isolated test database");
const pool = createDatabasePool(databaseUrl);
const scope = { hospitalId: "wait-race-hospital", testTypeId: "mri" };
let pair: Awaited<ReturnType<typeof startApiPair>>;
type Response = { status: number; body: { id: string; state: string; code?: string; admissionOrder?: string } };

async function post(api: { url: string }, path: string, patientId: string, key?: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${api.url}${path}`, { method: "POST", headers: {
    "x-patient-id": patientId, ...(key ? { "idempotency-key": key } : {}), ...(body ? { "content-type": "application/json" } : {}),
  }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: response.status, body: await response.json() as Response["body"] };
}
const join = (api: { url: string }, key: string, patientId = "patient-ana") => post(api, "/waiting-list-entries", patientId, key, scope);
const cancel = (api: { url: string }, id: string) => post(api, `/reservations/${id}/cancel`, "patient-carlos");

beforeAll(async () => {
  await initializeDatabase(pool);
  pair = await startApiPair(databaseUrl, "wait-race");
});
beforeEach(async () => {
  await pool.query("INSERT INTO scheduling.hospitals VALUES ($1)", [scope.hospitalId]);
  await pool.query("INSERT INTO scheduling.waiting_list_scopes VALUES ($1, $2)", [scope.hospitalId, scope.testTypeId]);
  await pool.query("INSERT INTO scheduling.diagnostic_resources VALUES ('wait-race-scanner', $1, $2)", [scope.hospitalId, scope.testTypeId]);
  await pool.query(`INSERT INTO scheduling.slots VALUES ('wait-race-slot', 'wait-race-scanner', $1, $2,
    date_trunc('milliseconds', clock_timestamp()) + interval '3 days', date_trunc('milliseconds', clock_timestamp()) + interval '3 days 30 minutes')`, [scope.hospitalId, scope.testTypeId]);
});
afterEach(async () => {
  await pool.query("DELETE FROM scheduling.http_creation_results WHERE idempotency_key LIKE 'wait-race-%'");
  await pool.query("DELETE FROM scheduling.outbox_publications WHERE event_id IN (SELECT id FROM scheduling.events WHERE payload->>'hospitalId'=$1)", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.reservation_closures WHERE reservation_id IN (SELECT id FROM scheduling.reservations WHERE slot_id LIKE 'wait-race-%')");
  await pool.query("DELETE FROM scheduling.events WHERE payload->>'hospitalId'=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.reservations WHERE slot_id LIKE 'wait-race-%'");
  await pool.query("DELETE FROM scheduling.waiting_list_slot_exclusions WHERE entry_id IN (SELECT id FROM scheduling.waiting_list_entries WHERE hospital_id=$1)", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.slots WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.diagnostic_resources WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.waiting_list_scopes WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.hospitals WHERE id=$1", [scope.hospitalId]);
});
afterAll(async () => { await pair?.stop(); await pool.end(); });

async function occupy() {
  const id = randomUUID();
  await pool.query(`INSERT INTO scheduling.reservations(id, slot_id, patient_id, state, created_at, expires_at)
    VALUES ($1, 'wait-race-slot', 'patient-carlos', 'CONFIRMED', date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', clock_timestamp()) + interval '10 minutes')`, [id]);
  return id;
}

async function slotBarrier() {
  const client = await pool.connect();
  await client.query("BEGIN");
  const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
  await client.query("SELECT id FROM scheduling.slots WHERE id='wait-race-slot' FOR UPDATE");
  return { pid: rows[0].pid, release: async () => { try { await client.query("ROLLBACK"); } finally { client.release(); } } };
}

async function ordered(first: () => Promise<unknown>, second: () => Promise<unknown>) {
  // The first API owns the scope and waits on this slot; the second must then queue behind it.
  const barrier = await slotBarrier();
  const firstResponse = first();
  let secondResponse: Promise<unknown> | undefined;
  try {
    await awaitBlocked(pool, [pair.a.applicationName], barrier.pid);
    secondResponse = second();
    await awaitBlocked(pool, [pair.a.applicationName, pair.b.applicationName], barrier.pid);
  } finally { await barrier.release(); }
  return Promise.all([firstResponse, secondResponse!]);
}

it.each([true, false])("serializes join/direct in the observed protected order, direct first=%s", async (directFirst) => {
  const direct = () => postHold(pair.a, "wait-race-slot", "wait-race-direct", "patient-carlos");
  if (directFirst) {
    const results = await ordered(direct, () => join(pair.b, "wait-race-join"));
    expect(results).toMatchObject([{ status: 201 }, { status: 201, body: { admissionOrder: "1" } }]);
  } else {
    const results = await ordered(() => join(pair.a, "wait-race-join"), () => postHold(pair.b, "wait-race-slot", "wait-race-direct", "patient-carlos"));
    expect(results).toMatchObject([{ status: 409, body: { code: "DIRECT_CAPACITY_AVAILABLE" } }, { status: 201 }]);
    expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [scope.hospitalId])).rows[0].count).toBe(0);
  }
});

it.each([true, false])("serializes join/release in the observed protected order, join first=%s", async (joinFirst) => {
  const id = await occupy();
  if (joinFirst) {
    const results = await ordered(() => join(pair.a, "wait-race-release-join"), () => cancel(pair.b, id));
    expect(results).toMatchObject([{ status: 201 }, { status: 200 }]);
    const bypass = await postHold(pair.a, "wait-race-slot", "wait-race-bypass", "patient-bruno");
    expect(bypass).toMatchObject({ status: 409, body: { code: "WAITING_LIST_PRIORITY" } });
    expect((await pool.query("SELECT type FROM scheduling.events WHERE payload->>'hospitalId'=$1 ORDER BY occurred_at, id", [scope.hospitalId])).rows)
      .toEqual([{ type: "AllocationReviewRequested" }, { type: "SlotReleased" }]);
  } else {
    const results = await ordered(() => cancel(pair.a, id), () => join(pair.b, "wait-race-release-join"));
    expect(results).toMatchObject([{ status: 200 }, { status: 409, body: { code: "DIRECT_CAPACITY_AVAILABLE" } }]);
    expect((await pool.query("SELECT type FROM scheduling.events WHERE payload->>'hospitalId'=$1", [scope.hospitalId])).rows).toEqual([{ type: "SlotReleased" }]);
  }
});

it.each([true, false])("coordinates concurrent admission keys across two API pools, identical keys=%s", async (sameKey) => {
  await occupy();
  const barrier = await holdScope(pool, scope.hospitalId, scope.testTypeId);
  const a = join(pair.a, "wait-race-key-a");
  const b = join(pair.b, sameKey ? "wait-race-key-a" : "wait-race-key-b");
  try { await awaitBlocked(pool, [pair.a.applicationName, pair.b.applicationName], barrier.pid); }
  finally { await barrier.release(); }
  const results = await Promise.all([a, b]);
  expect(results.map((response) => response.status).sort()).toEqual(sameKey ? [201, 201] : [200, 201]);
  expect(results[0].body).toEqual(results[1].body);
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [scope.hospitalId])).rows[0].count).toBe(1);
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.events WHERE payload->>'hospitalId'=$1", [scope.hospitalId])).rows[0].count).toBe(1);
});

it.each([false, true])("rechecks own hold expiry after real scope wait with prior eligible patient=%s", async (hasPriority) => {
  const held = await postHold(pair.a, "wait-race-slot", "wait-race-cross-hold", "patient-ana");
  expect(held.status).toBe(201);
  const reservationId = held.body.id as string;
  if (hasPriority) expect((await join(pair.b, "wait-race-bruno", "patient-bruno")).status).toBe(201);
  const deadline = (await pool.query<{ expires_at: Date }>(`UPDATE scheduling.reservations
    SET expires_at=date_trunc('milliseconds', clock_timestamp())+interval '900 milliseconds' WHERE id=$1 RETURNING expires_at`, [reservationId])).rows[0].expires_at;
  const barrier = await holdScope(pool, scope.hospitalId, scope.testTypeId);
  const a = join(pair.a, "wait-race-cross-admission");
  const b = join(pair.b, "wait-race-cross-admission");
  try {
    const activity = await awaitBlocked(pool, [pair.a.applicationName, pair.b.applicationName], barrier.pid);
    for (const request of activity) {
      expect(request.xact_start.getTime()).toBeLessThan(deadline.getTime());
      expect(request.query_start.getTime()).toBeLessThan(deadline.getTime());
    }
    await eventually(async () => (await pool.query<{ reached: boolean }>("SELECT date_trunc('milliseconds', clock_timestamp()) >= $1 AS reached", [deadline])).rows[0].reached, Boolean);
  } finally { await barrier.release(); }
  const responses = await Promise.all([a, b]);
  if (hasPriority) {
    expect(responses).toMatchObject([{ status: 201, body: { admissionOrder: "2" } }, { status: 201, body: { admissionOrder: "2" } }]);
    expect(responses[0].body).toEqual(responses[1].body);
  } else {
    for (const response of responses) expect(response).toMatchObject({ status: 409, body: { code: "DIRECT_CAPACITY_AVAILABLE" } });
    expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [scope.hospitalId])).rows[0].count).toBe(0);
  }
  expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id=$1", [reservationId])).rows[0].state).toBe("EXPIRED");
  expect((await pool.query("SELECT reason FROM scheduling.reservation_closures WHERE reservation_id=$1", [reservationId])).rows).toEqual([{ reason: "EXPIRED" }]);
  expect((await pool.query("SELECT type FROM scheduling.events WHERE payload->>'hospitalId'=$1 ORDER BY occurred_at, id", [scope.hospitalId])).rows)
    .toEqual(hasPriority ? [{ type: "AllocationReviewRequested" }, { type: "SlotReleased" }] : [{ type: "SlotReleased" }]);
});
