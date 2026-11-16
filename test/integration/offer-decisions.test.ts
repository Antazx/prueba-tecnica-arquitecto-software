import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../../src/scheduling/adapters/postgres/initialize.ts";
import { postgresScheduling } from "../../src/scheduling/adapters/postgres/scheduling.ts";
import { schedulingUseCases } from "../../src/scheduling/application/reservations.ts";
import { messageUseCases } from "../../src/scheduling/application/messages.ts";
import type { Delivery } from "../../src/scheduling/application/messages.ts";
import { awaitBlocked, eventually, holdScope, startApiPair } from "../helpers/concurrency.ts";
import { startWorkerProcess } from "../helpers/worker-process.ts";
import { once } from "node:events";
import { connect } from "amqplib";
import { assertTopology, publishConfirmed } from "../../src/scheduling/adapters/rabbitmq/messaging.ts";
import { buildApi } from "../../src/scheduling/adapters/http/api.ts";
import { readApiContract, expectContractResponse, expectNetworkContractResponse, type ApiDocument } from "../helpers/openapi.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const pool = createDatabasePool(databaseUrl);
const scheduling = postgresScheduling(pool);
const api = schedulingUseCases(scheduling);
const messages = messageUseCases(scheduling, async () => {});
const scope = { hospitalId: "decision-test-hospital", testTypeId: "mri" };
let servers: Awaited<ReturnType<typeof startApiPair>>;
let document: ApiDocument;

async function cleanup() {
  const events = "SELECT id FROM scheduling.events WHERE payload->>'hospitalId'='decision-test-hospital'";
  for (const table of ["consumer_attempts", "consumer_cycles", "consumer_results", "outbox_publications"]) {
    await pool.query(`DELETE FROM scheduling.${table} WHERE event_id IN (${events})`);
  }
  await pool.query("DELETE FROM scheduling.reservation_closures WHERE reservation_id IN (SELECT id FROM scheduling.reservations WHERE slot_id LIKE 'decision-test-%')");
  await pool.query(`DELETE FROM scheduling.events WHERE id IN (${events})`);
  await pool.query("DELETE FROM scheduling.reservations WHERE slot_id LIKE 'decision-test-%'");
  await pool.query("DELETE FROM scheduling.waiting_list_slot_exclusions WHERE entry_id IN (SELECT id FROM scheduling.waiting_list_entries WHERE hospital_id=$1)", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.slots WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.diagnostic_resources WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.waiting_list_scopes WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.hospitals WHERE id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.http_creation_results WHERE idempotency_key LIKE 'decision-test-%'");
}
beforeAll(async () => {
  await initializeDatabase(pool); await cleanup();
  servers = await startApiPair(databaseUrl, "decision-test-api");
  document = await readApiContract(servers.a.url);
});
beforeEach(async () => {
  await pool.query("INSERT INTO scheduling.hospitals VALUES ($1)", [scope.hospitalId]);
  await pool.query("INSERT INTO scheduling.waiting_list_scopes VALUES ($1,$2)", [scope.hospitalId, scope.testTypeId]);
  await pool.query("INSERT INTO scheduling.diagnostic_resources VALUES ('decision-test-resource',$1,$2)", [scope.hospitalId, scope.testTypeId]);
  await pool.query(`INSERT INTO scheduling.slots VALUES ('decision-test-h1','decision-test-resource',$1,$2,
    date_trunc('milliseconds',clock_timestamp())+interval '1 day',date_trunc('milliseconds',clock_timestamp())+interval '1 day 30 minutes')`, [scope.hospitalId, scope.testTypeId]);
});
afterEach(cleanup);
afterAll(async () => { await servers?.stop(); await pool.end(); });

async function post(path: string, patientId = "patient-ana", server = servers.a) {
  const response = await fetch(`${server.url}${path}`, { method: "POST", headers: { "X-Patient-Id": patientId } });
  return { status: response.status, body: await expectNetworkContractResponse(document, "POST", path.replace(/\/(reservations|waiting-list-entries)\/[^/]+/, "/$1/{id}"), response) };
}
async function create(path: string, patientId: string, key: string, body?: object) {
  const response = await fetch(`${servers.a.url}${path}`, { method: "POST", headers: {
    "X-Patient-Id": patientId, "Idempotency-Key": `decision-test-${key}`, ...(body ? { "Content-Type": "application/json" } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, body: await expectNetworkContractResponse(document, "POST", path.replace(/\/slots\/[^/]+/, "/slots/{id}"), response) };
}
async function getEntry(id: string, patientId = "patient-ana") {
  const response = await fetch(`${servers.b.url}/waiting-list-entries/${id}`, { headers: { "X-Patient-Id": patientId } });
  return { status: response.status, body: await expectNetworkContractResponse(document, "GET", "/waiting-list-entries/{id}", response) };
}
async function publications(type = "SlotReleased") {
  return (await pool.query(`SELECT p.*,e.payload FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id
    WHERE e.type=$1 AND e.payload->>'hospitalId'=$2 ORDER BY p.created_at,p.id`, [type, scope.hospitalId])).rows;
}
function envelope(row: { id: string; event_id: string; consumer: "allocation" | "notification"; cycle: number; attempt: number }): Delivery {
  return { version: 1, publicationId: row.id, eventId: row.event_id, consumer: row.consumer, cycle: row.cycle, attempt: row.attempt };
}
async function offerToAna(maximumMs?: number) {
  const hold = await api.createHold("patient-carlos", "decision-test-h1", "decision-test-hold");
  if (!("id" in hold.body)) throw new Error("Expected hold");
  const joined = await api.joinWaitingList("patient-ana", scope, "decision-test-join");
  if (!("admissionOrder" in joined.body)) throw new Error("Expected entry");
  await api.cancelReservation("patient-carlos", hold.body.id);
  await messageUseCases(scheduling, async () => {}, { offerMaximumMs: maximumMs }).allocate(envelope((await publications())[0]));
  const own = await getEntry(joined.body.id);
  if (!("offer" in own.body) || !own.body.offer) throw new Error("Expected offer");
  return { entry: joined.body, offer: own.body.offer };
}
async function releaseCount(reservationId: string) {
  return (await pool.query("SELECT count(*)::integer AS n FROM scheduling.events WHERE type='SlotReleased' AND payload->>'reservationId'=$1", [reservationId])).rows[0].n;
}
async function rowBarrier(reservationId: string) {
  const client = await pool.connect();
  await client.query("BEGIN");
  const pid = (await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await client.query("SELECT id FROM scheduling.reservations WHERE id=$1 FOR UPDATE", [reservationId]);
  let released = false;
  return { pid, release: async () => {
    if (released) return;
    released = true;
    try { await client.query("ROLLBACK"); } finally { client.release(); }
  } };
}

it("rejects its own offer through HTTP, retaining FIFO and one unique exclusion/release", async () => {
  const { entry, offer } = await offerToAna();
  const active = await create("/waiting-list-entries", "patient-ana", "active-offer", scope);
  expect(active).toMatchObject({ status: 200, body: { id: entry.id, state: "OFFERED", offer } });
  expect(await post(`/reservations/${offer.id}/reject`)).toMatchObject({ status: 200, body: { id: offer.id, state: "CANCELLED" } });
  expect((await getEntry(entry.id)).body).toMatchObject({
    id: entry.id, state: "WAITING", admissionOrder: entry.admissionOrder, excludedSlotIds: ["decision-test-h1"],
  });
  expect(await releaseCount(offer.id)).toBe(1);
  expect((await publications()).filter((row) => row.payload.reservationId === offer.id)).toHaveLength(1);
  expect((await publications("AllocationReviewRequested"))).toHaveLength(1);
  expect((await pool.query("SELECT reason FROM scheduling.reservation_closures WHERE reservation_id=$1", [offer.id])).rows).toEqual([{ reason: "OFFER_REJECTED" }]);
  expect(await create("/waiting-list-entries", "patient-ana", "active-offer", scope)).toEqual(active);
  expect(await create("/waiting-list-entries", "patient-ana", "join", scope)).toEqual({ status: 201, body: entry });
});

it("withdraws its offered participation through HTTP and preserves a terminal withdrawal", async () => {
  const { entry, offer } = await offerToAna();
  const result = await post(`/waiting-list-entries/${entry.id}/withdraw`);
  expect(result).toMatchObject({ status: 200, body: { id: entry.id, state: "CLOSED", closureReason: "WITHDRAWN" } });
  expect((await api.getReservation("patient-ana", offer.id)).body).toMatchObject({ id: offer.id, state: "CANCELLED" });
  expect(await post(`/waiting-list-entries/${entry.id}/withdraw`)).toEqual(result);
  expect(await post(`/reservations/${offer.id}/confirm`)).toMatchObject({ status: 409, body: { state: "CANCELLED" } });
  expect(await releaseCount(offer.id)).toBe(1);
});

it.each(["reject", "withdraw"])("materializes an expired offer on late %s with no recovery of waiting or duplicate release", async (action) => {
  const { entry, offer } = await offerToAna(80);
  await eventually(async () => (await pool.query("SELECT clock_timestamp() >= expires_at AS expired FROM scheduling.reservations WHERE id=$1", [offer.id])).rows[0].expired, Boolean);
  const path = action === "reject" ? `/reservations/${offer.id}/reject` : `/waiting-list-entries/${entry.id}/withdraw`;
  expect(await post(path)).toMatchObject({ status: action === "reject" ? 409 : 200, body: action === "reject"
    ? { id: offer.id, state: "EXPIRED", code: "RESERVATION_EXPIRED" }
    : { id: entry.id, state: "CLOSED", closureReason: "EXPIRED" } });
  expect((await getEntry(entry.id)).body).toMatchObject({ state: "CLOSED", closureReason: "EXPIRED", excludedSlotIds: [] });
  expect((await post(path)).status).toBe(action === "reject" ? 409 : 200);
  expect(await releaseCount(offer.id)).toBe(1);
});

it("preserves an accepted appointment and later participation when withdrawing its original ID", async () => {
  const { entry, offer } = await offerToAna();
  expect((await post(`/reservations/${offer.id}/confirm`)).status).toBe(200);
  const joined = await api.joinWaitingList("patient-ana", scope, "decision-test-rejoin");
  expect(joined.status).toBe(201);
  expect(await post(`/waiting-list-entries/${entry.id}/withdraw`)).toMatchObject({ status: 200, body: { id: entry.id, state: "CLOSED", closureReason: "ACCEPTED" } });
  expect((await api.getReservation("patient-ana", offer.id)).body).toMatchObject({ id: offer.id, state: "CONFIRMED" });
  if (!("id" in joined.body)) throw new Error("Expected new entry");
  expect((await getEntry(joined.body.id)).body).toMatchObject({ id: joined.body.id, state: "WAITING" });
  expect(await releaseCount(offer.id)).toBe(0);
});

it("repeats a past valid rejection without changing a subsequent offer even after the old deadline", async () => {
  const { entry, offer } = await offerToAna(800);
  const rejected = await post(`/reservations/${offer.id}/reject`);
  expect(rejected.status).toBe(200);
  await pool.query(`INSERT INTO scheduling.slots SELECT 'decision-test-h2',resource_id,hospital_id,test_type_id,
    starts_at+interval '1 hour',ends_at+interval '1 hour' FROM scheduling.slots WHERE id='decision-test-h1'`);
  await messages.allocate(envelope((await publications()).find((row) => row.payload.reservationId === offer.id)!));
  const next = await getEntry(entry.id);
  expect(next.body).toMatchObject({ state: "OFFERED", offer: { slotId: "decision-test-h2" } });
  await eventually(async () => (await pool.query("SELECT clock_timestamp() >= expires_at AS expired FROM scheduling.reservations WHERE id=$1", [offer.id])).rows[0].expired, Boolean);
  expect(await post(`/reservations/${offer.id}/reject`)).toEqual(rejected);
  if (!("offer" in next.body) || !next.body.offer) throw new Error("Expected next offer");
  expect((await getEntry(entry.id)).body).toMatchObject({
    id: entry.id, state: "OFFERED", admissionOrder: entry.admissionOrder, offer: next.body.offer, excludedSlotIds: ["decision-test-h1"],
  });
  expect(await releaseCount(offer.id)).toBe(1);
  expect((await pool.query("SELECT slot_id FROM scheduling.waiting_list_slot_exclusions WHERE entry_id=$1", [entry.id])).rows).toEqual([{ slot_id: "decision-test-h1" }]);
  await expect(pool.query("INSERT INTO scheduling.waiting_list_slot_exclusions VALUES ($1,'decision-test-h1')", [entry.id])).rejects.toMatchObject({ code: "23505" });
});

it("keeps rejection separate from cancellation and enforces presented ownership and request validation", async () => {
  const { entry, offer } = await offerToAna();
  expect((await post(`/reservations/${offer.id}/cancel`))).toMatchObject({ status: 409, body: { state: "OFFERED", code: "RESERVATION_STATE_CONFLICT" } });
  for (const path of [`/reservations/${offer.id}/reject`, `/waiting-list-entries/${entry.id}/withdraw`]) {
    expect((await post(path, "patient-bruno")).status).toBe(404);
    expect((await post(path, "missing-patient")).status).toBe(400);
    for (const options of [
      { method: "POST" },
      { method: "POST", headers: { "X-Patient-Id": "patient-ana", "Content-Type": "application/json" }, body: "{}" },
    ]) {
      const response = await fetch(`${servers.a.url}${path}`, options);
      expect(response.status).toBe(400);
      expect(await expectNetworkContractResponse(document, "POST", path.replace(/\/(reservations|waiting-list-entries)\/[^/]+/, "/$1/{id}"), response)).toEqual({ code: options.body ? "BODY_NOT_ALLOWED" : "INVALID_REQUEST" });
    }
  }
  expect((await post(`/reservations/${randomUUID()}/reject`)).status).toBe(404);
  expect((await post(`/waiting-list-entries/${randomUUID()}/withdraw`)).status).toBe(404);
  expect((await api.getReservation("patient-ana", offer.id)).body).toMatchObject({ state: "OFFERED" });
  expect(await releaseCount(offer.id)).toBe(0);
});

it("returns the complete current reservation when rejecting a direct hold, appointment or cancellation", async () => {
  const held = await create("/slots/decision-test-h1/holds", "patient-ana", "not-an-offer");
  expect(held.status).toBe(201);
  expect(await post(`/reservations/${held.body.id}/reject`)).toMatchObject({ status: 409, body: { ...held.body, code: "RESERVATION_STATE_CONFLICT" } });
  const confirmed = await post(`/reservations/${held.body.id}/confirm`);
  expect(confirmed.status).toBe(200);
  expect(await post(`/reservations/${held.body.id}/reject`)).toMatchObject({ status: 409, body: { ...confirmed.body, code: "RESERVATION_STATE_CONFLICT" } });
  const cancelled = await post(`/reservations/${held.body.id}/cancel`);
  expect(cancelled.status).toBe(200);
  expect(await post(`/reservations/${held.body.id}/reject`)).toMatchObject({ status: 409, body: { ...cancelled.body, code: "RESERVATION_STATE_CONFLICT" } });
});

it("retains the rejecting patient's FIFO while the excluded origin goes to the next eligible patient", async () => {
  const { entry, offer } = await offerToAna();
  const bruno = await api.joinWaitingList("patient-bruno", scope, "decision-test-bruno");
  expect(bruno.status).toBe(201);
  await pool.query(`INSERT INTO scheduling.slots SELECT 'decision-test-h2',resource_id,hospital_id,test_type_id,
    starts_at+interval '1 hour',ends_at+interval '1 hour' FROM scheduling.slots WHERE id='decision-test-h1'`);
  expect((await post(`/reservations/${offer.id}/reject`)).status).toBe(200);
  await messages.allocate(envelope((await publications()).find((row) => row.payload.reservationId === offer.id)!));
  expect((await pool.query("SELECT slot_id,patient_id FROM scheduling.reservations WHERE slot_id LIKE 'decision-test-%' AND state='OFFERED' ORDER BY slot_id")).rows)
    .toEqual([{ slot_id: "decision-test-h1", patient_id: "patient-bruno" }, { slot_id: "decision-test-h2", patient_id: "patient-ana" }]);
  expect((await getEntry(entry.id)).body).toMatchObject({ admissionOrder: entry.admissionOrder, excludedSlotIds: ["decision-test-h1"] });
  expect(await releaseCount(offer.id)).toBe(1);
});

it.each(["accept-first", "withdraw-first"])("serializes %s in two API processes with observable lock barriers", async (order) => {
  const { entry, offer } = await offerToAna();
  const paths = order === "accept-first"
    ? [`/reservations/${offer.id}/confirm`, `/waiting-list-entries/${entry.id}/withdraw`]
    : [`/waiting-list-entries/${entry.id}/withdraw`, `/reservations/${offer.id}/confirm`];
  const barrier = await rowBarrier(offer.id);
  const first = post(paths[0]);
  let second: ReturnType<typeof post> | undefined;
  try {
    await awaitBlocked(pool, [servers.a.applicationName], barrier.pid);
    second = post(paths[1], "patient-ana", servers.b);
    await awaitBlocked(pool, [servers.a.applicationName, servers.b.applicationName], barrier.pid);
  } finally { await barrier.release(); }
  expect((await first).status).toBe(200);
  expect((await second!).status).toBe(order === "accept-first" ? 200 : 409);
  expect((await getEntry(entry.id)).body).toMatchObject({
    state: "CLOSED", closureReason: order === "accept-first" ? "ACCEPTED" : "WITHDRAWN",
  });
  expect((await api.getReservation("patient-ana", offer.id)).body).toMatchObject({ state: order === "accept-first" ? "CONFIRMED" : "CANCELLED" });
  expect(await releaseCount(offer.id)).toBe(order === "accept-first" ? 0 : 1);
});

it("rechecks time after two APIs wait across expiry without recovering waiting or mixing causes", async () => {
  const { entry, offer } = await offerToAna();
  const deadline = (await pool.query<{ expires_at: Date }>(`UPDATE scheduling.reservations
    SET expires_at=date_trunc('milliseconds',clock_timestamp())+interval '900 milliseconds' WHERE id=$1 RETURNING expires_at`, [offer.id])).rows[0].expires_at;
  const barrier = await holdScope(pool, scope.hospitalId, scope.testTypeId);
  const rejecting = post(`/reservations/${offer.id}/reject`);
  const withdrawing = post(`/waiting-list-entries/${entry.id}/withdraw`, "patient-ana", servers.b);
  try {
    const waiting = await awaitBlocked(pool, [servers.a.applicationName, servers.b.applicationName], barrier.pid);
    for (const request of waiting) expect(request.xact_start.getTime()).toBeLessThan(deadline.getTime());
    await eventually(async () => (await pool.query("SELECT clock_timestamp() >= $1 AS expired", [deadline])).rows[0].expired, Boolean);
  } finally { await barrier.release(); }
  expect(await rejecting).toMatchObject({ status: 409, body: { state: "EXPIRED", code: "RESERVATION_EXPIRED" } });
  expect(await withdrawing).toMatchObject({ status: 200, body: { state: "CLOSED", closureReason: "EXPIRED" } });
  expect(await releaseCount(offer.id)).toBe(1);
  expect((await getEntry(entry.id)).body).toMatchObject({ state: "CLOSED", closureReason: "EXPIRED", excludedSlotIds: [] });
});

it.each(["reject", "withdraw"])("rolls back reservation, entry, exclusion and durable work when %s cannot save outbox", async (action) => {
  const { entry, offer } = await offerToAna();
  const role = "decision_test_no_outbox";
  await pool.query(`CREATE ROLE ${role} NOLOGIN`);
  const restrictedUrl = new URL(databaseUrl); restrictedUrl.searchParams.set("options", `-c role=${role}`);
  const restricted = createDatabasePool(restrictedUrl.toString());
  const failing = schedulingUseCases(postgresScheduling(restricted));
  const failingHttp = buildApi(async () => {}, async () => ({ evaluatedAt: "2030-01-01T00:00:00.000Z", slots: [] }), failing);
  try {
    await pool.query(`GRANT USAGE ON SCHEMA scheduling TO ${role}`);
    await pool.query(`GRANT SELECT ON ALL TABLES IN SCHEMA scheduling TO ${role}`);
    await pool.query(`GRANT UPDATE ON scheduling.slots,scheduling.waiting_list_scopes,scheduling.reservations,scheduling.waiting_list_entries TO ${role}`);
    await pool.query(`GRANT INSERT ON scheduling.events,scheduling.reservation_closures,scheduling.waiting_list_slot_exclusions TO ${role}`);
    await expect(action === "reject" ? failing.rejectOffer("patient-ana", offer.id) : failing.withdrawWaitingListEntry("patient-ana", entry.id))
      .rejects.toMatchObject({ code: "42501" });
    const response = await failingHttp.inject({ method: "POST", url: action === "reject" ? `/reservations/${offer.id}/reject` : `/waiting-list-entries/${entry.id}/withdraw`, headers: { "x-patient-id": "patient-ana" } });
    expect(response.statusCode).toBe(500);
    expect(response.json()).toEqual({ code: "INTERNAL_ERROR" });
    expectContractResponse(await readApiContract(failingHttp), "POST", action === "reject" ? "/reservations/{id}/reject" : "/waiting-list-entries/{id}/withdraw", response);
    expect((await api.getReservation("patient-ana", offer.id)).body).toMatchObject({ state: "OFFERED" });
    expect((await getEntry(entry.id)).body).toMatchObject({ state: "OFFERED", excludedSlotIds: [], offer: { id: offer.id } });
    expect(await releaseCount(offer.id)).toBe(0);
    expect((await pool.query("SELECT * FROM scheduling.reservation_closures WHERE reservation_id=$1", [offer.id])).rows).toEqual([]);
  } finally {
    await failingHttp.close();
    await restricted.end();
    await pool.query(`REVOKE ALL ON ALL TABLES IN SCHEMA scheduling FROM ${role}`);
    await pool.query(`REVOKE USAGE ON SCHEMA scheduling FROM ${role}`);
    await pool.query(`DROP ROLE ${role}`);
  }
});

it.each(["base", "excluded-prefix", "crash-before-relay", "duplicates", "reoccupied", "started"])("H1/H2 %s: rejection HTTP alone reactivates the whole scope after H2's review already completed", async (variant) => {
  const rabbitmqUrl = process.env.TEST_RABBITMQ_URL;
  if (!rabbitmqUrl) throw new Error("TEST_RABBITMQ_URL is required");
  let worker: Awaited<ReturnType<typeof startWorkerProcess>> | undefined;
  let secondWorker: Awaited<ReturnType<typeof startWorkerProcess>> | undefined;
  if (variant === "started") await pool.query(`UPDATE scheduling.slots SET
    starts_at=date_trunc('milliseconds',clock_timestamp())+interval '5 seconds',
    ends_at=date_trunc('milliseconds',clock_timestamp())+interval '30 minutes' WHERE id='decision-test-h1'`);
  await pool.query(`INSERT INTO scheduling.slots SELECT 'decision-test-h2',resource_id,hospital_id,test_type_id,
    starts_at+interval '1 day',ends_at+interval '1 day' FROM scheduling.slots WHERE id='decision-test-h1'`);
  const prefixes = variant === "excluded-prefix" ? ["decision-test-prefix-a", "decision-test-prefix-b"] : [];
  for (const [index, id] of prefixes.entries()) await pool.query(`INSERT INTO scheduling.slots SELECT $1,resource_id,hospital_id,test_type_id,
    starts_at-$2*interval '1 hour',ends_at-$2*interval '1 hour' FROM scheduling.slots WHERE id='decision-test-h1'`, [id, index + 1]);
  const holds: Record<string, string> = {};
  for (const slotId of [...prefixes, "decision-test-h1", "decision-test-h2"]) {
    const held = await create(`/slots/${slotId}/holds`, "patient-carlos", slotId);
    expect(held.status).toBe(201); holds[slotId] = held.body.id;
  }
  const joined = await create("/waiting-list-entries", "patient-ana", "ana", scope);
  expect(joined.status).toBe(201);
  for (const slotId of prefixes) await pool.query("INSERT INTO scheduling.waiting_list_slot_exclusions VALUES ($1,$2)", [joined.body.id, slotId]);
  try {
    worker = await startWorkerProcess(databaseUrl, rabbitmqUrl);
    for (const slotId of [...prefixes, "decision-test-h1"]) expect((await post(`/reservations/${holds[slotId]}/cancel`, "patient-carlos")).status).toBe(200);
    const first = await eventually(async () => (await pool.query<{ id: string; slot_id: string }>("SELECT id,slot_id FROM scheduling.reservations WHERE waiting_list_entry_id=$1 AND state='OFFERED'", [joined.body.id])).rows[0], (row) => Boolean(row), 10000);
    expect(first.slot_id).toBe("decision-test-h1");
    expect((await post(`/reservations/${holds["decision-test-h2"]}/cancel`, "patient-carlos")).status).toBe(200);
    const h2Release = (await publications()).find((row) => row.payload.reservationId === holds["decision-test-h2"]);
    if (!h2Release) throw new Error("Expected H2 release");
    await eventually(async () => (await pool.query(`SELECT r.outcome FROM scheduling.consumer_results r
      JOIN scheduling.outbox_publications p ON p.event_id=r.event_id AND p.consumer=r.consumer
      WHERE r.event_id=$1 AND r.consumer='allocation' AND p.published_at IS NOT NULL`, [h2Release.event_id])).rows[0]?.outcome, (outcome) => outcome === "succeeded", 10000);
    expect((await pool.query("SELECT id FROM scheduling.reservations WHERE slot_id='decision-test-h2' AND state='OFFERED'")).rows).toEqual([]);
    expect((await pool.query("SELECT published_at FROM scheduling.outbox_publications WHERE id=$1", [h2Release.id])).rows[0].published_at).not.toBeNull();

    const delayed = ["crash-before-relay", "duplicates", "reoccupied", "started"].includes(variant);
    if (delayed) { await worker.stop(); worker = undefined; }
    const rejected = await post(`/reservations/${first.id}/reject`);
    expect(rejected).toMatchObject({ status: 200, body: { id: first.id, state: "CANCELLED" } });
    expect(await releaseCount(first.id)).toBe(1);
    expect((await publications("AllocationReviewRequested"))).toHaveLength(1);
    const release = (await publications()).find((row) => row.payload.reservationId === first.id)!;
    expect(release.payload.reason).toBe("OFFER_REJECTED");
    let replacement: string | undefined;
    if (variant === "crash-before-relay") {
      expect((await pool.query("SELECT published_at FROM scheduling.outbox_publications WHERE id=$1", [release.id])).rows[0].published_at).toBeNull();
      const exited = once(servers.a.child, "exit"); servers.a.child.kill("SIGKILL"); await exited;
      await servers.stop(); servers = await startApiPair(databaseUrl, "decision-test-api");
    }
    if (variant === "reoccupied") {
      const held = await create("/slots/decision-test-h1/holds", "patient-carlos", "replacement");
      expect(held.status).toBe(201); replacement = held.body.id;
    }
    if (variant === "started") await eventually(async () => (await pool.query("SELECT clock_timestamp() >= starts_at AS started FROM scheduling.slots WHERE id='decision-test-h1'")).rows[0].started, Boolean, 8000);
    if (variant === "duplicates") {
      const barrier = await holdScope(pool, scope.hospitalId, scope.testTypeId);
      try {
        const connection = await connect(rabbitmqUrl); const channel = await connection.createConfirmChannel();
        try {
          await assertTopology(channel);
          await publishConfirmed(channel, "appointments.work", "allocation", envelope(release));
          await publishConfirmed(channel, "appointments.work", "allocation", envelope(release));
        } finally { await channel.close(); await connection.close(); }
        secondWorker = await startWorkerProcess(databaseUrl, rabbitmqUrl, { relay: false, applicationName: "decision-test-worker-b" });
        worker = await startWorkerProcess(databaseUrl, rabbitmqUrl);
        await awaitBlocked(pool, [worker.applicationName, secondWorker.applicationName], barrier.pid);
      } finally { await barrier.release(); }
    }
    if (delayed && !worker) worker = await startWorkerProcess(databaseUrl, rabbitmqUrl);
    // Observational SQL only: no new business request or replay of H2 can activate this wait.
    const next = await eventually(async () => (await pool.query("SELECT id,slot_id FROM scheduling.reservations WHERE waiting_list_entry_id=$1 AND state='OFFERED'", [joined.body.id])).rows[0], (row) => row?.slot_id === "decision-test-h2", 10000);
    expect(next.id).not.toBe(first.id);
    const own = await getEntry(joined.body.id);
    expect(own.body).toMatchObject({ state: "OFFERED", admissionOrder: joined.body.admissionOrder, excludedSlotIds: expect.arrayContaining([...prefixes, "decision-test-h1"]), offer: { id: next.id } });
    expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.reservations WHERE slot_id='decision-test-h2' AND state='OFFERED'")).rows[0].n).toBe(1);
    expect(await releaseCount(first.id)).toBe(1);
    if (replacement) expect((await api.getReservation("patient-carlos", replacement)).body).toMatchObject({ id: replacement, state: "HELD" });
    await eventually(async () => (await pool.query(`SELECT count(*)::integer AS n FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id
      LEFT JOIN scheduling.consumer_results r ON r.event_id=p.event_id AND r.consumer=p.consumer
      WHERE e.payload->>'hospitalId'=$1 AND (p.published_at IS NULL OR r.outcome IS NULL)`, [scope.hospitalId])).rows[0].n, (n) => n === 0, 10000);
    process.stdout.write(`H1/H2 network evidence ${JSON.stringify({ variant, entry: joined.body.id, first: first.id, next: next.id, h2AlreadyCompleted: h2Release.event_id, rejectionEvent: release.event_id })}\n`);
  } finally { await worker?.stop(); await secondWorker?.stop(); }
}, 25000);

it.each([
  { action: "reject", first: "request" }, { action: "reject", first: "sweep" },
  { action: "withdraw", first: "request" }, { action: "withdraw", first: "sweep" },
])("coordinates $action against the periodic offer sweep with $first first and two API pools", async ({ action, first }) => {
  const { entry, offer } = await offerToAna();
  const worker = await startWorkerProcess(databaseUrl, "amqp://diagnostic:diagnostic_dev@127.0.0.1:1", {
    applicationName: `decision-test-sweep-${action}-${first}`, requireRabbitmq: false, relay: false,
  });
  const barrier = await holdScope(pool, scope.hospitalId, scope.testTypeId);
  const deadline = (await pool.query<{ expires_at: Date }>(`UPDATE scheduling.reservations
    SET expires_at=date_trunc('milliseconds',clock_timestamp())+ $2*interval '1 millisecond'
    WHERE id=$1 RETURNING expires_at`, [offer.id, first === "request" ? 900 : -1])).rows[0].expires_at;
  const path = action === "reject" ? `/reservations/${offer.id}/reject` : `/waiting-list-entries/${entry.id}/withdraw`;
  let a: ReturnType<typeof post> | undefined;
  let b: ReturnType<typeof post> | undefined;
  try {
    if (first === "sweep") await awaitBlocked(pool, [worker.applicationName], barrier.pid);
    a = post(path); b = post(path, "patient-ana", servers.b);
    const waiting = await awaitBlocked(pool, [servers.a.applicationName, servers.b.applicationName], barrier.pid);
    if (first === "request") {
      for (const request of waiting) expect(request.xact_start.getTime()).toBeLessThan(deadline.getTime());
      await eventually(async () => (await pool.query("SELECT clock_timestamp() >= $1 AS expired", [deadline])).rows[0].expired, Boolean);
    }
    await awaitBlocked(pool, [worker.applicationName, servers.a.applicationName, servers.b.applicationName], barrier.pid);
    await barrier.release();
    const responses = await Promise.all([a, b]);
    for (const response of responses) expect(response).toMatchObject(action === "reject"
      ? { status: 409, body: { id: offer.id, state: "EXPIRED", code: "RESERVATION_EXPIRED" } }
      : { status: 200, body: { id: entry.id, state: "CLOSED", closureReason: "EXPIRED" } });
    expect(await releaseCount(offer.id)).toBe(1);
    expect((await pool.query("SELECT reason FROM scheduling.reservation_closures WHERE reservation_id=$1", [offer.id])).rows).toEqual([{ reason: "EXPIRED" }]);
    expect((await getEntry(entry.id)).body).toMatchObject({ state: "CLOSED", closureReason: "EXPIRED", excludedSlotIds: [] });
  } finally { await barrier.release(); await Promise.allSettled([a, b].filter((pending) => pending !== undefined)); await worker.stop(); }
}, 15000);
