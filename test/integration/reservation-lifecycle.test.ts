import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
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
const useCases = schedulingUseCases(postgresScheduling(pool));
const api = buildApi(() => Promise.resolve(), (query) => listSlots(pool, query), useCases);
let document: Awaited<ReturnType<typeof readApiContract>>;
beforeAll(async () => { await initializeDatabase(pool); document = await readApiContract(api); });
afterEach(async () => {
  await pool.query("DELETE FROM scheduling.http_creation_results WHERE idempotency_key LIKE 'lifecycle-test-%'");
  await pool.query("DELETE FROM scheduling.outbox_publications WHERE event_id IN (SELECT event_id FROM scheduling.reservation_closures WHERE reservation_id IN (SELECT id FROM scheduling.reservations WHERE slot_id LIKE 'lifecycle-test-%'))");
  await pool.query("DELETE FROM scheduling.reservation_closures WHERE reservation_id IN (SELECT id FROM scheduling.reservations WHERE slot_id LIKE 'lifecycle-test-%')");
  await pool.query("DELETE FROM scheduling.events WHERE payload->>'slotId' LIKE 'lifecycle-test-%'");
  await pool.query("DELETE FROM scheduling.reservations WHERE slot_id LIKE 'lifecycle-test-%'");
  await pool.query("DELETE FROM scheduling.slots WHERE id LIKE 'lifecycle-test-%'");
});
afterAll(async () => { await api.close(); await pool.end(); });

async function hold(name: string) {
  const slotId = `lifecycle-test-${name}`;
  await pool.query(`INSERT INTO scheduling.slots VALUES ($1, 'scanner-north-1', 'hospital-north', 'mri',
    date_trunc('milliseconds', clock_timestamp()) + interval '3 days',
    date_trunc('milliseconds', clock_timestamp()) + interval '3 days 30 minutes')`, [slotId]);
  const result = await api.inject({ method: "POST", url: `/slots/${slotId}/holds`, headers: {
    "x-patient-id": "patient-ana", "idempotency-key": slotId,
  } });
  expect(result.statusCode).toBe(201);
  expectContractResponse(document, "POST", "/slots/{id}/holds", result);
  return result.json<{ id: string; slotId: string; state: string; expiresAt: string }>();
}
async function transition(id: string, action: "confirm" | "cancel", patientId = "patient-ana") {
  const response = await api.inject({ method: "POST", url: `/reservations/${id}/${action}`, headers: { "x-patient-id": patientId } });
  expectContractResponse(document, "POST", `/reservations/{id}/${action}`, response);
  return response;
}

it("confirms the own hold in place and repeats confirmation after the previous TTL", async () => {
  const reservation = await hold("confirmation");
  const confirmed = await transition(reservation.id, "confirm");
  expect(confirmed.statusCode).toBe(200);
  expect(confirmed.json()).toMatchObject({ id: reservation.id, state: "CONFIRMED", expiresAt: reservation.expiresAt });
  await pool.query("UPDATE scheduling.reservations SET created_at = created_at - interval '20 minutes', expires_at = expires_at - interval '20 minutes' WHERE id = $1", [reservation.id]);
  const repeated = await transition(reservation.id, "confirm");
  expect(repeated.statusCode).toBe(200);
  expect(repeated.json()).toMatchObject({ id: reservation.id, state: "CONFIRMED" });
});

it("commits expiry and one durable release even when late confirmation responds conflict", async () => {
  const reservation = await hold("late-confirmation");
  await pool.query("UPDATE scheduling.reservations SET created_at = created_at - interval '20 minutes', expires_at = expires_at - interval '20 minutes' WHERE id = $1", [reservation.id]);
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await transition(reservation.id, "confirm");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ id: reservation.id, state: "EXPIRED", code: "RESERVATION_EXPIRED" });
  }
  const expired = await api.inject({ url: `/reservations/${reservation.id}`, headers: { "x-patient-id": "patient-ana" } });
  expect(expired.statusCode).toBe(200);
  expect(expired.json()).toMatchObject({ state: "EXPIRED", temporal: { expired: false, closurePending: false }, actions: { canConfirm: false, canCancel: false, canRejectOffer: false } });
  expectContractResponse(document, "GET", "/reservations/{id}", expired);
  expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id = $1", [reservation.id])).rows[0].state).toBe("EXPIRED");
  const events = (await pool.query(`SELECT e.id, e.type, e.payload, p.id AS publication_id, p.consumer, p.cycle, p.attempt, p.published_at
    FROM scheduling.events e JOIN scheduling.outbox_publications p ON p.event_id = e.id WHERE e.payload->>'reservationId' = $1`, [reservation.id])).rows;
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ type: "SlotReleased", payload: { reservationId: reservation.id, slotId: reservation.slotId,
    hospitalId: "hospital-north", testTypeId: "mri", reason: "EXPIRED" }, consumer: "allocation", cycle: 0, attempt: 0, published_at: null });
  expect(events[0].publication_id).not.toBe(events[0].id);
});

it("cancels and repeats only R1, while reconfirmation reports its current CANCELLED state and preserves R2", async () => {
  const reservation = await hold("cancel-reconfirm");
  expect((await transition(reservation.id, "confirm")).statusCode).toBe(200);
  const cancellation = await transition(reservation.id, "cancel");
  expect(cancellation.statusCode).toBe(200);
  expect(cancellation.json()).toMatchObject({ id: reservation.id, state: "CANCELLED" });
  const replacement = await api.inject({ method: "POST", url: `/slots/${reservation.slotId}/holds`, headers: {
    "x-patient-id": "patient-bruno", "idempotency-key": "lifecycle-test-replacement",
  } });
  expect(replacement.statusCode).toBe(201);
  expectContractResponse(document, "POST", "/slots/{id}/holds", replacement);
  for (const action of ["confirm", "cancel"] as const) {
    const response = await transition(reservation.id, action);
    expect(response.statusCode).toBe(action === "confirm" ? 409 : 200);
    expect(response.json()).toMatchObject({ id: reservation.id, state: "CANCELLED", ...(action === "confirm" ? { code: "RESERVATION_STATE_CONFLICT" } : {}) });
  }
  expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id = $1", [replacement.json().id])).rows[0].state).toBe("HELD");
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.events WHERE payload->>'reservationId' = $1", [reservation.id])).rows[0].count).toBe(1);
});

it("recovers overdue direct holds including started slots, while keeping confirmed appointments", async () => {
  const overdue = await hold("sweep-overdue");
  const started = await hold("sweep-started");
  const confirmed = await hold("sweep-confirmed");
  expect((await transition(confirmed.id, "confirm")).statusCode).toBe(200);
  await pool.query(`UPDATE scheduling.reservations SET created_at = created_at - interval '20 minutes', expires_at = expires_at - interval '20 minutes'
    WHERE id = ANY($1::uuid[])`, [[overdue.id, started.id, confirmed.id]]);
  await pool.query("UPDATE scheduling.slots SET starts_at = starts_at - interval '4 days', ends_at = ends_at - interval '4 days' WHERE id = $1", [started.slotId]);
  await expect(useCases.expireTemporaryReservations()).resolves.toBe(2);
  await expect(useCases.expireTemporaryReservations()).resolves.toBe(0);
  const states = (await pool.query("SELECT state FROM scheduling.reservations WHERE id = ANY($1::uuid[]) ORDER BY state", [[overdue.id, started.id, confirmed.id]])).rows;
  expect(states).toEqual([{ state: "CONFIRMED" }, { state: "EXPIRED" }, { state: "EXPIRED" }]);
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.events WHERE payload->>'slotId' LIKE 'lifecycle-test-sweep-%'")).rows[0].count).toBe(2);
});

it("expires a late cancellation with 409 and replays a completed cancellation after start", async () => {
  const late = await hold("late-cancel");
  await pool.query("UPDATE scheduling.reservations SET created_at = created_at - interval '20 minutes', expires_at = expires_at - interval '20 minutes' WHERE id = $1", [late.id]);
  for (let repeat = 0; repeat < 2; repeat++) {
    const response = await transition(late.id, "cancel");
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ id: late.id, state: "EXPIRED", code: "RESERVATION_EXPIRED" });
  }
  const cancelled = await hold("cancel-replay-started");
  expect((await transition(cancelled.id, "cancel")).statusCode).toBe(200);
  const confirmed = await hold("cancel-started-conflict");
  expect((await transition(confirmed.id, "confirm")).statusCode).toBe(200);
  await pool.query(`UPDATE scheduling.slots SET starts_at = starts_at - interval '4 days', ends_at = ends_at - interval '4 days'
    WHERE id = ANY($1::text[])`, [[cancelled.slotId, confirmed.slotId]]);
  expect((await transition(cancelled.id, "cancel")).statusCode).toBe(200);
  const conflict = await transition(confirmed.id, "cancel");
  expect(conflict.statusCode).toBe(409);
  expect(conflict.json()).toMatchObject({ id: confirmed.id, state: "CONFIRMED", code: "APPOINTMENT_STARTED" });
  expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.events WHERE payload->>'reservationId' = ANY($1::text[])", [[late.id, cancelled.id, confirmed.id]])).rows[0].count).toBe(2);
});

it("rolls back state, closure and logical event when SQL cannot store the outbox publication", async () => {
  const reservation = await hold("outbox-rollback");
  await pool.query("CREATE ROLE lifecycle_test_no_outbox NOLOGIN");
  const restrictedUrl = new URL(databaseUrl);
  restrictedUrl.searchParams.set("options", "-c role=lifecycle_test_no_outbox");
  const restricted = createDatabasePool(restrictedUrl.toString());
  const failingApi = buildApi(() => Promise.resolve(), (query) => listSlots(restricted, query), schedulingUseCases(postgresScheduling(restricted)));
  try {
    await pool.query("GRANT USAGE ON SCHEMA scheduling TO lifecycle_test_no_outbox");
    await pool.query("GRANT SELECT ON ALL TABLES IN SCHEMA scheduling TO lifecycle_test_no_outbox");
    await pool.query("GRANT UPDATE ON scheduling.reservations, scheduling.slots, scheduling.waiting_list_scopes TO lifecycle_test_no_outbox");
    await pool.query("GRANT INSERT ON scheduling.events, scheduling.reservation_closures TO lifecycle_test_no_outbox");
    const response = await failingApi.inject({ method: "POST", url: `/reservations/${reservation.id}/cancel`, headers: { "x-patient-id": "patient-ana" } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR" });
    expectContractResponse(document, "POST", "/reservations/{id}/cancel", response);
    expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id = $1", [reservation.id])).rows[0].state).toBe("HELD");
    expect((await pool.query("SELECT * FROM scheduling.reservation_closures WHERE reservation_id = $1", [reservation.id])).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM scheduling.events WHERE payload->>'reservationId' = $1", [reservation.id])).rows).toEqual([]);
    expect((await transition(reservation.id, "cancel")).statusCode).toBe(200);
  } finally {
    await failingApi.close(); await restricted.end();
    await pool.query("REVOKE ALL ON ALL TABLES IN SCHEMA scheduling FROM lifecycle_test_no_outbox");
    await pool.query("REVOKE USAGE ON SCHEMA scheduling FROM lifecycle_test_no_outbox");
    await pool.query("DROP ROLE lifecycle_test_no_outbox");
  }
});

it("keeps own GET evaluation free of writes before and after expiry with outbox unchanged", async () => {
  const reservation = await hold("get-pending");
  const readOnlyUrl = new URL(databaseUrl);
  readOnlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
  const reader = createDatabasePool(readOnlyUrl.toString());
  const readApi = buildApi(() => Promise.resolve(), (query) => listSlots(reader, query), schedulingUseCases(postgresScheduling(reader)));
  const get = () => readApi.inject({ url: `/reservations/${reservation.id}`, headers: { "x-patient-id": "patient-ana" } });
  try {
    const before = await get();
    expect(before.statusCode).toBe(200);
    expectContractResponse(document, "GET", "/reservations/{id}", before);
    expect(before.json()).toMatchObject({ state: "HELD", temporal: { expired: false, closurePending: false }, actions: { canConfirm: true, canCancel: true } });
    await pool.query("UPDATE scheduling.reservations SET created_at = created_at - interval '20 minutes', expires_at = expires_at - interval '20 minutes' WHERE id = $1", [reservation.id]);
    const persisted = (await pool.query("SELECT * FROM scheduling.reservations WHERE id = $1", [reservation.id])).rows;
    const after = await get();
    expect(after.statusCode).toBe(200);
    expectContractResponse(document, "GET", "/reservations/{id}", after);
    expect(after.json()).toMatchObject({ state: "HELD", temporal: { expired: true, closurePending: true }, actions: { canConfirm: false, canCancel: false } });
    expect(Date.parse(after.json().evaluatedAt)).toBeGreaterThanOrEqual(Date.parse(after.json().expiresAt));
    expect((await pool.query("SELECT * FROM scheduling.reservations WHERE id = $1", [reservation.id])).rows).toEqual(persisted);
    expect((await pool.query("SELECT * FROM scheduling.events WHERE payload->>'reservationId' = $1", [reservation.id])).rows).toEqual([]);
  } finally { await readApi.close(); await reader.end(); }
});

it("protects ownership, rejects contradictory bodies and leaves offered reservations for offer operations", async () => {
  const reservation = await hold("owner");
  for (const action of ["confirm", "cancel"] as const) {
    expect((await transition(reservation.id, action, "patient-bruno")).statusCode).toBe(404);
    expect((await transition("missing-reservation", action)).statusCode).toBe(404);
    expect((await transition(reservation.id, action, "missing-patient")).statusCode).toBe(400);
    const body = await api.inject({ method: "POST", url: `/reservations/${reservation.id}/${action}`, headers: { "x-patient-id": "patient-ana" }, payload: { patientId: "patient-bruno" } });
    expect(body.statusCode).toBe(400);
    expect(body.json()).toEqual({ code: "BODY_NOT_ALLOWED" });
    expectContractResponse(document, "POST", `/reservations/{id}/${action}`, body);
  }
  await pool.query("UPDATE scheduling.reservations SET state = 'OFFERED' WHERE id = $1", [reservation.id]);
  const current = await api.inject({ url: `/reservations/${reservation.id}`, headers: { "x-patient-id": "patient-ana" } });
  expect(current.statusCode).toBe(200);
  expect(current.json()).toMatchObject({ state: "OFFERED", temporal: { expired: false, closurePending: false }, actions: { canConfirm: true, canCancel: false, canRejectOffer: true } });
  expectContractResponse(document, "GET", "/reservations/{id}", current);
  const offered = await transition(reservation.id, "cancel");
  expect(offered.statusCode).toBe(409);
  expect(offered.json()).toMatchObject({ id: reservation.id, state: "OFFERED", code: "RESERVATION_STATE_CONFLICT" });
  expect((await pool.query("SELECT * FROM scheduling.events WHERE payload->>'reservationId' = $1", [reservation.id])).rows).toEqual([]);
});
