import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { buildApi } from "../../src/scheduling/adapters/http/api.ts";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../../src/scheduling/adapters/postgres/initialize.ts";
import { listSlots } from "../../src/scheduling/adapters/postgres/slots.ts";
import { postgresScheduling } from "../../src/scheduling/adapters/postgres/scheduling.ts";
import { schedulingUseCases } from "../../src/scheduling/application/reservations.ts";
import { readApiContract, expectContractResponse } from "../helpers/openapi.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required; use an isolated test database");
const pool = createDatabasePool(databaseUrl);
const api = buildApi(() => Promise.resolve(), (query) => listSlots(pool, query), schedulingUseCases(postgresScheduling(pool)));
const scope = { hospitalId: "wait-test-hospital", testTypeId: "mri" };
const headers = { "x-patient-id": "patient-ana" };
const join = (key: string, patientId = "patient-ana", body = scope) => api.inject({ method: "POST", url: "/waiting-list-entries",
  headers: { "x-patient-id": patientId, "idempotency-key": key }, payload: body });
const get = (id: string, patientId = "patient-ana") => api.inject({ url: `/waiting-list-entries/${id}`, headers: { "x-patient-id": patientId } });
const withdraw = (id: string) => api.inject({ method: "POST", url: `/waiting-list-entries/${id}/withdraw`, headers });

beforeAll(async () => { await initializeDatabase(pool); });
beforeEach(async () => {
  await pool.query("INSERT INTO scheduling.hospitals VALUES ($1) ON CONFLICT DO NOTHING", [scope.hospitalId]);
  await pool.query("INSERT INTO scheduling.waiting_list_scopes VALUES ($1, $2) ON CONFLICT DO NOTHING", [scope.hospitalId, scope.testTypeId]);
  await pool.query("INSERT INTO scheduling.diagnostic_resources VALUES ('wait-test-scanner', $1, $2) ON CONFLICT DO NOTHING", [scope.hospitalId, scope.testTypeId]);
  await pool.query(`INSERT INTO scheduling.slots VALUES ('wait-test-slot', 'wait-test-scanner', $1, $2,
    date_trunc('milliseconds', clock_timestamp()) + interval '3 days', date_trunc('milliseconds', clock_timestamp()) + interval '3 days 30 minutes') ON CONFLICT DO NOTHING`, [scope.hospitalId, scope.testTypeId]);
});
afterEach(async () => {
  await pool.query("DELETE FROM scheduling.http_creation_results WHERE idempotency_key LIKE 'wait-test-%'");
  await pool.query("DELETE FROM scheduling.outbox_publications WHERE event_id IN (SELECT id FROM scheduling.events WHERE payload->>'hospitalId'=$1)", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.reservation_closures WHERE reservation_id IN (SELECT id FROM scheduling.reservations WHERE slot_id LIKE 'wait-test-%')");
  await pool.query("DELETE FROM scheduling.events WHERE payload->>'hospitalId'=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.reservations WHERE slot_id LIKE 'wait-test-%'");
  await pool.query("DELETE FROM scheduling.waiting_list_slot_exclusions WHERE entry_id IN (SELECT id FROM scheduling.waiting_list_entries WHERE hospital_id=$1)", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.slots WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.diagnostic_resources WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.waiting_list_scopes WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.hospitals WHERE id=$1", [scope.hospitalId]);
});
afterAll(async () => { await api.close(); await pool.end(); });

async function occupy(patientId = "patient-carlos", state = "CONFIRMED") {
  const id = randomUUID();
  await pool.query(`INSERT INTO scheduling.reservations(id, slot_id, patient_id, state, created_at, expires_at)
    VALUES ($1, 'wait-test-slot', $2, $3, date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', clock_timestamp()) + interval '10 minutes')`, [id, patientId, state]);
  return id;
}

it("admits a waiting patient with durable activation and increasing order, replaying the same success", async () => {
  await occupy();
  const first = await join("wait-test-first");
  expect(first.statusCode).toBe(201);
  expect(first.json()).toMatchObject({ ...scope, state: "WAITING", admissionOrder: "1" });
  const replay = await join("wait-test-first");
  expect(replay.statusCode).toBe(201);
  expect(replay.json()).toEqual(first.json());
  const second = await join("wait-test-second", "patient-bruno");
  expect(second.statusCode).toBe(201);
  expect(second.json().admissionOrder).toBe("2");
  expect((await pool.query("SELECT type FROM scheduling.events WHERE payload->>'hospitalId'=$1 ORDER BY occurred_at, id", [scope.hospitalId])).rows)
    .toEqual([{ type: "AllocationReviewRequested" }, { type: "AllocationReviewRequested" }]);
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id WHERE e.payload->>'hospitalId'=$1", [scope.hospitalId])).rows[0].count).toBe(2);
});

it("rejects new admission with public direct references or Q24 first, without latent participation", async () => {
  const available = await join("wait-test-free");
  expect(available.statusCode).toBe(409);
  expect(available.json()).toMatchObject({ code: "DIRECT_CAPACITY_AVAILABLE", slots: [{ id: "wait-test-slot", hospitalId: scope.hospitalId, testTypeId: "mri" }] });
  expect(JSON.stringify(available.json())).not.toMatch(/patient|reservation/i);
  const held = await api.inject({ method: "POST", url: "/slots/wait-test-slot/holds", headers: { ...headers, "idempotency-key": "wait-test-own-hold" } });
  expect(held.statusCode).toBe(201);
  const rejected = await join("wait-test-own-hold-admission");
  expect(rejected.statusCode).toBe(409);
  expect(rejected.json()).toEqual({ code: "ACTIVE_HOLD_IN_SCOPE" });
  const cancel = await api.inject({ method: "POST", url: `/reservations/${held.json().id}/cancel`, headers });
  expect(cancel.statusCode).toBe(200);
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [scope.hospitalId])).rows[0].count).toBe(0);
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.http_creation_results WHERE operation='join-waiting-list' AND fingerprint IS NOT NULL AND idempotency_key LIKE 'wait-test-%'")).rows[0].count).toBe(0);
  expect((await pool.query("SELECT type FROM scheduling.events WHERE payload->>'hospitalId'=$1", [scope.hospitalId])).rows).toEqual([{ type: "SlotReleased" }]);
});

it("returns the actual active entry for a new key, then withdraws only its ID and preserves historical success", async () => {
  await occupy();
  const first = await join("wait-test-entry-k1");
  expect(first.statusCode).toBe(201);
  const repeated = await join("wait-test-entry-k2");
  expect(repeated.statusCode).toBe(200);
  expect(repeated.json()).toEqual(first.json());
  const read = await get(first.json().id);
  expect(read.statusCode).toBe(200);
  expect(read.json()).toMatchObject({ ...first.json(), temporal: { expired: false, closurePending: false }, actions: { canWithdraw: true } });
  expect((await get(first.json().id, "patient-bruno")).statusCode).toBe(404);
  expect((await withdraw(first.json().id)).json()).toMatchObject({ state: "CLOSED", closureReason: "WITHDRAWN" });
  const second = await join("wait-test-entry-k3");
  expect(second.statusCode).toBe(201);
  expect(second.json()).toMatchObject({ admissionOrder: "2", state: "WAITING" });
  expect(second.json().id).not.toBe(first.json().id);
  expect((await withdraw(first.json().id)).json()).toMatchObject({ state: "CLOSED", closureReason: "WITHDRAWN" });
  expect((await get(second.json().id)).json().state).toBe("WAITING");
  for (const [key, status] of [["wait-test-entry-k1", 201], ["wait-test-entry-k2", 200]] as const) {
    const replay = await join(key);
    expect(replay.statusCode).toBe(status);
    expect(replay.json()).toEqual(first.json());
  }
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.events WHERE payload->>'hospitalId'=$1", [scope.hospitalId])).rows[0].count).toBe(2);
});

it.each(["patient-ana", "patient-carlos"])("normalizes expired %s holds before Q2 despite the stopped sweep and commits release on conflict", async (patientId) => {
  const id = await occupy(patientId, "HELD");
  await pool.query("UPDATE scheduling.reservations SET created_at=created_at-interval '20 minutes', expires_at=expires_at-interval '20 minutes' WHERE id=$1", [id]);
  const response = await join("wait-test-expired-admission");
  expect(response.statusCode).toBe(409);
  expect(response.json()).toMatchObject({ code: "DIRECT_CAPACITY_AVAILABLE", slots: [{ id: "wait-test-slot" }] });
  expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id=$1", [id])).rows[0].state).toBe("EXPIRED");
  expect((await pool.query("SELECT type FROM scheduling.events WHERE payload->>'hospitalId'=$1", [scope.hospitalId])).rows).toEqual([{ type: "SlotReleased" }]);
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [scope.hospitalId])).rows[0].count).toBe(0);
  expect((await pool.query("SELECT fingerprint FROM scheduling.http_creation_results WHERE idempotency_key='wait-test-expired-admission'")).rows[0].fingerprint).toBeNull();
});

it("normalizes an own started hold, admits behind existing history and reuses its release as durable activation", async () => {
  const id = await occupy("patient-ana", "HELD");
  await pool.query("UPDATE scheduling.reservations SET created_at=created_at-interval '4 days', expires_at=expires_at-interval '4 days' WHERE id=$1", [id]);
  await pool.query("UPDATE scheduling.slots SET starts_at=starts_at-interval '4 days', ends_at=ends_at-interval '4 days' WHERE id='wait-test-slot'");
  const response = await join("wait-test-started");
  expect(response.statusCode).toBe(201);
  expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id=$1", [id])).rows[0].state).toBe("EXPIRED");
  expect((await pool.query("SELECT type FROM scheduling.events WHERE payload->>'hospitalId'=$1", [scope.hospitalId])).rows).toEqual([{ type: "SlotReleased" }]);
});

it("normalizes only own expiries before returning an active entry with a new key", async () => {
  const own = await occupy("patient-ana", "CONFIRMED");
  const first = await join("wait-test-confirmed-then-entry");
  expect(first.statusCode).toBe(201);
  await pool.query("UPDATE scheduling.reservations SET state='HELD', created_at=created_at-interval '20 minutes', expires_at=expires_at-interval '20 minutes' WHERE id=$1", [own]);
  const active = await join("wait-test-active-new-key");
  expect(active.statusCode).toBe(200);
  expect(active.json()).toEqual(first.json());
  expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id=$1", [own])).rows[0].state).toBe("EXPIRED");
});

it("keeps eligible waiting priority on free slots in GET and direct hold while the consumer is stopped", async () => {
  const reservationId = await occupy();
  const entry = await join("wait-test-priority");
  expect(entry.statusCode).toBe(201);
  const cancel = await api.inject({ method: "POST", url: `/reservations/${reservationId}/cancel`, headers: { "x-patient-id": "patient-carlos" } });
  expect(cancel.statusCode).toBe(200);
  const agendaUrl = `/slots?${new URLSearchParams({ ...scope, from: "2020-01-01T00:00:00Z", to: "2100-01-01T00:00:00Z" })}`;
  expect((await api.inject({ url: agendaUrl })).json().slots).toMatchObject([{ id: "wait-test-slot", directlyBookable: false }]);
  const direct = () => api.inject({ method: "POST", url: "/slots/wait-test-slot/holds", headers: { "x-patient-id": "patient-bruno", "idempotency-key": "wait-test-bypass" } });
  const conflict = await direct();
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json().code).toBe("WAITING_LIST_PRIORITY");
  expectContractResponse(await readApiContract(api), "POST", "/slots/{id}/holds", conflict);
  const bruno = await join("wait-test-priority-bruno", "patient-bruno");
  expect(bruno.statusCode).toBe(201);
  expect(bruno.json().admissionOrder).toBe("2");
  await withdraw(entry.json().id);
  await api.inject({ method: "POST", url: `/waiting-list-entries/${bruno.json().id}/withdraw`, headers: { "x-patient-id": "patient-bruno" } });
  expect((await api.inject({ url: agendaUrl })).json().slots[0].directlyBookable).toBe(true);
  expect((await direct()).statusCode).toBe(201);
});

it("applies Q24 before free capacity and leaves other scopes independent", async () => {
  await occupy("patient-ana", "HELD");
  await pool.query(`INSERT INTO scheduling.slots SELECT 'wait-test-other', resource_id, hospital_id, test_type_id,
    starts_at+interval '1 hour', ends_at+interval '1 hour' FROM scheduling.slots WHERE id='wait-test-slot'`);
  expect((await join("wait-test-q24-before-q2")).json()).toEqual({ code: "ACTIVE_HOLD_IN_SCOPE" });
  await pool.query("INSERT INTO scheduling.waiting_list_scopes VALUES ($1, 'ultrasound')", [scope.hospitalId]);
  const other = await join("wait-test-other-scope", "patient-ana", { ...scope, testTypeId: "ultrasound" });
  expect(other.statusCode).toBe(201);
});

it("allows an eligible direct hold alongside an existing entry and returns that entry before Q24", async () => {
  const occupied = await occupy();
  const initial = await join("wait-test-coexist-k1");
  await pool.query("INSERT INTO scheduling.waiting_list_slot_exclusions VALUES ($1, 'wait-test-slot')", [initial.json().id]);
  await api.inject({ method: "POST", url: `/reservations/${occupied}/cancel`, headers: { "x-patient-id": "patient-carlos" } });
  const held = await api.inject({ method: "POST", url: "/slots/wait-test-slot/holds", headers: { ...headers, "idempotency-key": "wait-test-coexist-hold" } });
  expect(held.statusCode).toBe(201);
  const active = await join("wait-test-coexist-k2");
  expect(active.statusCode).toBe(200);
  expect(active.json()).toMatchObject({ id: initial.json().id, admissionOrder: "1", excludedSlotIds: ["wait-test-slot"] });
  const replay = await join("wait-test-coexist-k1");
  expect(replay.statusCode).toBe(201);
  expect(replay.json()).toEqual(initial.json());
});

it.each(["ACCEPTED", "EXPIRED", "WITHDRAWN"])("preserves closed cause %s and leaves a later entry and confirmed appointment intact", async (reason) => {
  const reservationId = await occupy("patient-ana");
  const first = await join("wait-test-closed-first");
  await pool.query("UPDATE scheduling.waiting_list_entries SET state='CLOSED', closure_reason=$2 WHERE id=$1", [first.json().id, reason]);
  const second = await join("wait-test-closed-second");
  expect(second.statusCode).toBe(201);
  const old = await withdraw(first.json().id);
  expect(old.statusCode).toBe(200);
  expect(old.json()).toMatchObject({ state: "CLOSED", closureReason: reason });
  expect((await get(second.json().id)).json().state).toBe("WAITING");
  expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id=$1", [reservationId])).rows[0].state).toBe("CONFIRMED");
});

it("uses a read-only coherent GET with no invented expiry for waiting and enforces active uniqueness in PostgreSQL", async () => {
  await occupy();
  const initial = await join("wait-test-readonly");
  const url = new URL(databaseUrl);
  url.searchParams.set("options", "-c default_transaction_read_only=on");
  const reader = createDatabasePool(url.toString());
  const readOnlyApi = buildApi(() => Promise.resolve(), (query) => listSlots(reader, query), schedulingUseCases(postgresScheduling(reader)));
  try {
    const response = await readOnlyApi.inject({ url: `/waiting-list-entries/${initial.json().id}`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ state: "WAITING", temporal: { expired: false, closurePending: false }, actions: { canWithdraw: true } });
    expect(response.json().evaluatedAt).toMatch(/\.\d{3}Z$/);
    expect(response.json().expiresAt).toBeUndefined();
  } finally { await readOnlyApi.close(); await reader.end(); }
  await expect(pool.query(`INSERT INTO scheduling.waiting_list_entries(id, patient_id, hospital_id, test_type_id, admission_order, state, created_at)
    SELECT $1, patient_id, hospital_id, test_type_id, 2, 'WAITING', created_at FROM scheduling.waiting_list_entries WHERE id=$2`, [randomUUID(), initial.json().id]))
    .rejects.toMatchObject({ code: "23505", constraint: "entries_one_active_patient_scope_idx" });
});

it("separates successful keys by operation and rejects incompatible scopes", async () => {
  const held = await api.inject({ method: "POST", url: "/slots/wait-test-slot/holds", headers: { ...headers, "idempotency-key": "wait-test-operation" } });
  await api.inject({ method: "POST", url: `/reservations/${held.json().id}/confirm`, headers });
  const joined = await join("wait-test-operation");
  expect(joined.statusCode).toBe(201);
  const mismatch = await join("wait-test-operation", "patient-ana", { hospitalId: "hospital-south", testTypeId: "mri" });
  expect(mismatch.statusCode).toBe(409);
  expect(mismatch.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
});

it.each([
  { failure: "outbox", normalized: false }, { failure: "result", normalized: false },
  { failure: "outbox", normalized: true }, { failure: "result", normalized: true },
])("rolls back admission, activation and key on $failure SQL failure, normalizing expiry=$normalized", async ({ failure, normalized }) => {
  const reservationId = await occupy(normalized ? "patient-ana" : "patient-carlos", normalized ? "HELD" : "CONFIRMED");
  if (normalized) {
    expect((await join("wait-test-rollback-prior", "patient-bruno")).statusCode).toBe(201);
    await pool.query("UPDATE scheduling.reservations SET created_at=created_at-interval '20 minutes', expires_at=expires_at-interval '20 minutes' WHERE id=$1", [reservationId]);
  }
  const role = `wait_test_no_${failure}`;
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  const url = new URL(databaseUrl);
  url.searchParams.set("options", `-c role=${role}`);
  const restricted = createDatabasePool(url.toString());
  const failingApi = buildApi(() => Promise.resolve(), (query) => listSlots(restricted, query), schedulingUseCases(postgresScheduling(restricted)));
  try {
    await pool.query(`GRANT USAGE ON SCHEMA scheduling TO ${role}`);
    await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA scheduling TO ${role}`);
    await pool.query(`GRANT UPDATE ON scheduling.waiting_list_scopes, scheduling.slots, scheduling.reservations, scheduling.waiting_list_entries TO ${role}`);
    await pool.query(`GRANT INSERT ON scheduling.waiting_list_entries, scheduling.http_creation_results, scheduling.events, scheduling.reservation_closures TO ${role}`);
    await pool.query(`GRANT UPDATE (idempotency_key) ON scheduling.http_creation_results TO ${role}`);
    if (failure === "outbox") await pool.query(`GRANT UPDATE ON scheduling.http_creation_results TO ${role}`);
    else await pool.query(`GRANT INSERT ON scheduling.outbox_publications TO ${role}`);
    const response = await failingApi.inject({ method: "POST", url: "/waiting-list-entries", headers: { ...headers, "idempotency-key": "wait-test-rollback" }, payload: scope });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR" });
    expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [scope.hospitalId])).rows[0].count).toBe(normalized ? 1 : 0);
    expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.events WHERE payload->>'hospitalId'=$1", [scope.hospitalId])).rows[0].count).toBe(normalized ? 1 : 0);
    expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.http_creation_results WHERE idempotency_key='wait-test-rollback'")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id=$1", [reservationId])).rows[0].state).toBe(normalized ? "HELD" : "CONFIRMED");
    expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.reservation_closures WHERE reservation_id=$1", [reservationId])).rows[0].count).toBe(0);
    expect((await join("wait-test-rollback")).statusCode).toBe(201);
  } finally {
    await failingApi.close(); await restricted.end();
    await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA scheduling FROM ${role}`);
    await pool.query(`REVOKE USAGE ON SCHEMA scheduling FROM ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
});

it.each([
  { identity: "", key: "wait-test-invalid", body: scope },
  { identity: "unknown", key: "wait-test-invalid", body: scope },
  { identity: "patient-ana", key: "", body: scope },
  { identity: "patient-ana", key: "wait-test-invalid", body: { ...scope, patientId: "patient-bruno" } },
  { identity: "patient-ana", key: "wait-test-invalid", body: { hospitalId: scope.hospitalId } },
])("validates identity, key and scope without accepting contradictory ownership %#", async ({ identity, key, body }) => {
  const response = await api.inject({ method: "POST", url: "/waiting-list-entries", headers: { "x-patient-id": identity, "idempotency-key": key }, payload: body });
  expect(response.statusCode).toBe(400);
});

it("returns an existing entry before normalizing foreign expiries and preserves own live hold", async () => {
  const own = await occupy("patient-ana");
  const first = await join("wait-test-normalization-order-k1");
  await pool.query("UPDATE scheduling.reservations SET state='HELD' WHERE id=$1", [own]);
  await pool.query(`INSERT INTO scheduling.slots SELECT 'wait-test-other', resource_id, hospital_id, test_type_id,
    starts_at+interval '1 hour', ends_at+interval '1 hour' FROM scheduling.slots WHERE id='wait-test-slot'`);
  const foreign = randomUUID();
  await pool.query(`INSERT INTO scheduling.reservations(id, slot_id, patient_id, state, created_at, expires_at)
    VALUES ($1, 'wait-test-other', 'patient-carlos', 'HELD', date_trunc('milliseconds', clock_timestamp())-interval '20 minutes',
      date_trunc('milliseconds', clock_timestamp())-interval '10 minutes')`, [foreign]);
  const active = await join("wait-test-normalization-order-k2");
  expect(active.statusCode).toBe(200);
  expect(active.json()).toEqual(first.json());
  expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id=$1", [foreign])).rows[0].state).toBe("HELD");
  const newPatient = await join("wait-test-normalization-order-bruno", "patient-bruno");
  expect(newPatient.statusCode).toBe(201);
  expect(newPatient.json().admissionOrder).toBe("2");
  expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id=$1", [foreign])).rows[0].state).toBe("EXPIRED");
  expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id=$1", [own])).rows[0].state).toBe("HELD");
});
