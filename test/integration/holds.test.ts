import { randomUUID } from "node:crypto";
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
const api = buildApi(() => Promise.resolve(), (query) => listSlots(pool, query), schedulingUseCases(postgresScheduling(pool)));
let document: Awaited<ReturnType<typeof readApiContract>>;
beforeAll(async () => { await initializeDatabase(pool); document = await readApiContract(api); });
afterEach(async () => {
  await pool.query("DELETE FROM scheduling.http_creation_results WHERE idempotency_key LIKE 'hold-test-%'");
  await pool.query("DELETE FROM scheduling.reservations WHERE slot_id LIKE 'hold-test-%'");
  await pool.query("DELETE FROM scheduling.slots WHERE id LIKE 'hold-test-%'");
});
afterAll(async () => { await api.close(); await pool.end(); });

async function slot(id: string, offset = "3 days") {
  await pool.query(`INSERT INTO scheduling.slots(id, resource_id, hospital_id, test_type_id, starts_at, ends_at)
    VALUES ($1, 'scanner-north-1', 'hospital-north', 'mri',
      date_trunc('milliseconds', clock_timestamp()) + $2::interval,
      date_trunc('milliseconds', clock_timestamp()) + $2::interval + interval '30 minutes')`, [id, offset]);
}

async function hold(slotId: string, key: string, patientId = "patient-ana") {
  const response = await api.inject({
    method: "POST", url: `/slots/${slotId}/holds`, headers: { "x-patient-id": patientId, "idempotency-key": key },
  });
  expectContractResponse(document, "POST", "/slots/{id}/holds", response);
  return response;
}

it("creates a hold and lets only its presented synthetic owner consult it", async () => {
  await slot("hold-test-created");
  const response = await hold("hold-test-created", "hold-test-initial");
  expect(response.statusCode).toBe(201);
  const reservation = response.json();
  expect(reservation).toMatchObject({ slotId: "hold-test-created", state: "HELD" });
  expect(Date.parse(reservation.expiresAt) - Date.parse(reservation.createdAt)).toBe(600_000);
  const own = await api.inject({ url: `/reservations/${reservation.id}`, headers: { "x-patient-id": "patient-ana" } });
  expect(own.statusCode).toBe(200);
  expectContractResponse(document, "GET", "/reservations/{id}", own);
  expect(own.json()).toMatchObject({ ...reservation, temporal: { expired: false, closurePending: false }, actions: { canConfirm: true } });
  for (const id of [reservation.id, "missing-reservation"]) {
    const foreign = await api.inject({ url: `/reservations/${id}`, headers: { "x-patient-id": "patient-bruno" } });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.json()).toEqual({ code: "NOT_FOUND" });
    expectContractResponse(document, "GET", "/reservations/{id}", foreign);
  }
  const unknown = await api.inject({ url: `/reservations/${reservation.id}`, headers: { "x-patient-id": "missing-patient" } });
  expect(unknown.statusCode).toBe(400);
  expect(unknown.json()).toEqual({ code: "UNKNOWN_PATIENT" });
  expectContractResponse(document, "GET", "/reservations/{id}", unknown);
});

it("returns the documented missing-slot response for a registered patient", async () => {
  const response = await hold("hold-test-missing-slot", "hold-test-missing-key");
  expect(response.statusCode).toBe(404);
  expect(response.json()).toEqual({ code: "NOT_FOUND" });
});

it("replays the original successful representation and code after losing the response and after a state change", async () => {
  await slot("hold-test-replay");
  const lostResponse = await hold("hold-test-replay", "hold-test-replay-key");
  expect(lostResponse.statusCode).toBe(201);
  await pool.query("UPDATE scheduling.reservations SET state = 'CANCELLED' WHERE id = $1", [lostResponse.json().id]);
  const replay = await hold("hold-test-replay", "hold-test-replay-key");
  expect(replay.statusCode).toBe(201);
  expect(replay.json()).toEqual(lostResponse.json());
  const current = await api.inject({ url: `/reservations/${lostResponse.json().id}`, headers: { "x-patient-id": "patient-ana" } });
  expect(current.statusCode).toBe(200);
  expect(current.json().state).toBe("CANCELLED");
  expectContractResponse(document, "GET", "/reservations/{id}", current);
});

it("rejects an incompatible destination but keeps equal keys of different patients independent", async () => {
  await slot("hold-test-key-a");
  await slot("hold-test-key-b", "4 days");
  expect((await hold("hold-test-key-a", "hold-test-shared-key")).statusCode).toBe(201);
  const incompatible = await hold("hold-test-key-b", "hold-test-shared-key");
  expect(incompatible.statusCode).toBe(409);
  expect(incompatible.json().code).toBe("IDEMPOTENCY_KEY_REUSED");
  expect((await hold("hold-test-key-b", "hold-test-shared-key", "patient-bruno")).statusCode).toBe(201);
});

it("shows pending expiry without writing and conservatively keeps a persisted expired hold occupied", async () => {
  await slot("hold-test-expired");
  const id = randomUUID();
  await pool.query(`INSERT INTO scheduling.reservations(id, slot_id, patient_id, state, created_at, expires_at) VALUES ($1, 'hold-test-expired', 'patient-ana', 'HELD',
    date_trunc('milliseconds', clock_timestamp()) - interval '20 minutes',
    date_trunc('milliseconds', clock_timestamp()) - interval '10 minutes')`, [id]);
  const readOnlyUrl = new URL(databaseUrl);
  readOnlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
  const reader = createDatabasePool(readOnlyUrl.toString());
  const readOnlyApi = buildApi(() => Promise.resolve(), (query) => listSlots(reader, query), schedulingUseCases(postgresScheduling(reader)));
  try {
    const response = await readOnlyApi.inject({ url: `/reservations/${id}`, headers: { "x-patient-id": "patient-ana" } });
    expect(response.statusCode).toBe(200);
    expectContractResponse(document, "GET", "/reservations/{id}", response);
    expect(response.json()).toMatchObject({ state: "HELD", temporal: { expired: true, closurePending: true }, actions: { canConfirm: false, canCancel: false } });
    const agenda = await readOnlyApi.inject({ url: "/slots?hospitalId=hospital-north&testTypeId=mri&from=2020-01-01T00:00:00Z&to=2100-01-01T00:00:00Z" });
    expect(agenda.json().slots.find((entry: { id: string }) => entry.id === "hold-test-expired").directlyBookable).toBe(false);
    const attempt = await hold("hold-test-expired", "hold-test-expired-key", "patient-bruno");
    expect(attempt.statusCode).toBe(409);
    expect(attempt.json().code).toBe("SLOT_OCCUPIED");
    // This probes the persisted uniqueness boundary directly, outside the normal writer protocol.
    await expect(pool.query(`INSERT INTO scheduling.reservations(id, slot_id, patient_id, state, created_at, expires_at) VALUES ($1, 'hold-test-expired', 'patient-bruno', 'HELD',
      date_trunc('milliseconds', clock_timestamp()), date_trunc('milliseconds', clock_timestamp()) + interval '10 minutes')`, [randomUUID()]))
      .rejects.toMatchObject({ code: "23505", constraint: "reservations_one_occupant_idx" });
  } finally { await readOnlyApi.close(); await reader.end(); }
});

it("rolls back the hold and key when the final SQL result write fails, then permits retry", async () => {
  await slot("hold-test-rollback");
  await pool.query("CREATE ROLE hold_test_no_result NOLOGIN");
  const restrictedUrl = new URL(databaseUrl);
  restrictedUrl.searchParams.set("options", "-c role=hold_test_no_result");
  const restricted = createDatabasePool(restrictedUrl.toString());
  const failingApi = buildApi(() => Promise.resolve(), (query) => listSlots(restricted, query), schedulingUseCases(postgresScheduling(restricted)));
  try {
    await pool.query("GRANT USAGE ON SCHEMA scheduling TO hold_test_no_result");
    await pool.query("GRANT SELECT ON ALL TABLES IN SCHEMA scheduling TO hold_test_no_result");
    await pool.query("GRANT INSERT ON scheduling.reservations, scheduling.http_creation_results TO hold_test_no_result");
    await pool.query("GRANT UPDATE (hospital_id) ON scheduling.waiting_list_scopes TO hold_test_no_result");
    await pool.query("GRANT UPDATE (id) ON scheduling.slots, scheduling.reservations TO hold_test_no_result");
    // This permits row coordination but denies the final fingerprint/status/body write.
    await pool.query("GRANT UPDATE (idempotency_key) ON scheduling.http_creation_results TO hold_test_no_result");
    const response = await failingApi.inject({ method: "POST", url: "/slots/hold-test-rollback/holds", headers: {
      "x-patient-id": "patient-ana", "idempotency-key": "hold-test-rollback-key",
    } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR" });
    expectContractResponse(document, "POST", "/slots/{id}/holds", response);
    expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.reservations WHERE slot_id = 'hold-test-rollback'")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::integer AS count FROM scheduling.http_creation_results WHERE idempotency_key = 'hold-test-rollback-key'")).rows[0].count).toBe(0);
    expect((await hold("hold-test-rollback", "hold-test-rollback-key")).statusCode).toBe(201);
  } finally {
    await failingApi.close();
    await restricted.end();
    await pool.query("REVOKE ALL ON ALL TABLES IN SCHEMA scheduling FROM hold_test_no_result");
    await pool.query("REVOKE USAGE ON SCHEMA scheduling FROM hold_test_no_result");
    await pool.query("DROP ROLE hold_test_no_result");
  }
});

it.each([
  { headers: {}, body: undefined },
  { headers: { "x-patient-id": "patient-ana" }, body: undefined },
  { headers: { "x-patient-id": "invalid patient", "idempotency-key": "hold-test-invalid" }, body: undefined },
  { headers: { "x-patient-id": "missing-patient", "idempotency-key": "hold-test-invalid" }, body: undefined },
  { headers: { "x-patient-id": "patient-ana", "idempotency-key": " " }, body: undefined },
  { headers: { "x-patient-id": "patient-ana", "idempotency-key": "hold-test-body" }, body: { patientId: "patient-bruno" } },
  { headers: { "x-patient-id": "patient-ana", "idempotency-key": "hold-test-body" }, body: { expiresAt: "2100-01-01T00:00:00Z" } },
  { headers: { "x-patient-id": "patient-ana", "idempotency-key": "hold-test-body", "content-type": "application/unsupported" }, body: "invalid" },
])("rejects invalid synthetic identity, missing key or contradictory body %#", async ({ headers, body }) => {
  await slot("hold-test-invalid");
  const response = await api.inject({ method: "POST", url: "/slots/hold-test-invalid/holds", headers, payload: body });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ code: headers["x-patient-id"] === "missing-patient" ? "UNKNOWN_PATIENT" :
    body !== undefined && headers["content-type"] !== "application/unsupported" ? "BODY_NOT_ALLOWED" : "INVALID_REQUEST" });
  expectContractResponse(document, "POST", "/slots/{id}/holds", response);
  expect((await hold("hold-test-invalid", "hold-test-valid-after-rejection", "patient-bruno")).statusCode).toBe(201);
});

it("caps the persisted deadline at an approaching start and rejects a started slot", async () => {
  await slot("hold-test-near", "5 minutes");
  await slot("hold-test-started", "-1 hour");
  const response = await hold("hold-test-near", "hold-test-near");
  expect(response.statusCode).toBe(201);
  expect(response.json().expiresAt).toBe(response.json().startsAt);
  const started = await hold("hold-test-started", "hold-test-started");
  expect(started.statusCode).toBe(409);
  expect(started.json().code).toBe("SLOT_STARTED");
});

it("exposes a confirmed reservation without marking its previous deadline expired", async () => {
  await slot("hold-test-confirmed");
  const id = randomUUID();
  await pool.query(`INSERT INTO scheduling.reservations(id, slot_id, patient_id, state, created_at, expires_at) VALUES ($1, 'hold-test-confirmed', 'patient-ana', 'CONFIRMED',
    date_trunc('milliseconds', clock_timestamp()) - interval '20 minutes',
    date_trunc('milliseconds', clock_timestamp()) - interval '10 minutes')`, [id]);
  const response = await api.inject({ url: `/reservations/${id}`, headers: { "x-patient-id": "patient-ana" } });
  expect(response.statusCode).toBe(200);
  expectContractResponse(document, "GET", "/reservations/{id}", response);
  expect(response.json()).toMatchObject({ state: "CONFIRMED", temporal: { expired: false, closurePending: false }, actions: { canConfirm: true, canCancel: true } });
});

it("returns identifiable 503 for a failed PostgreSQL connection on both read routes", async () => {
  const unavailableUrl = new URL(databaseUrl);
  unavailableUrl.port = "1";
  const unavailable = createDatabasePool(unavailableUrl.toString());
  const unavailableApi = buildApi(() => Promise.resolve(), (query) => listSlots(unavailable, query), schedulingUseCases(postgresScheduling(unavailable)));
  try {
    for (const url of ["/slots?hospitalId=hospital-north&testTypeId=mri&from=2020-01-01T00:00:00Z&to=2100-01-01T00:00:00Z", `/reservations/${randomUUID()}`]) {
      const response = await unavailableApi.inject({ url, headers: { "x-patient-id": "patient-ana" } });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toEqual({ code: "DEPENDENCY_UNAVAILABLE" });
      expectContractResponse(document, "GET", url.startsWith("/slots") ? "/slots" : "/reservations/{id}", response);
    }
  } finally { await unavailableApi.close(); await unavailable.end(); }
});

it("truncates a PostgreSQL internal clock below a millisecond without rounding up", async () => {
  const result = await pool.query<{ at: Date }>("SELECT date_trunc('milliseconds', timestamptz '2030-05-10 11:59:59.999900+00') AS at");
  expect(result.rows[0].at.toISOString()).toBe("2030-05-10T11:59:59.999Z");
});
