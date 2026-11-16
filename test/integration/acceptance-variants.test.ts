import { afterEach, beforeEach, expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../../src/scheduling/adapters/postgres/initialize.ts";
import { postgresScheduling } from "../../src/scheduling/adapters/postgres/scheduling.ts";
import { schedulingUseCases } from "../../src/scheduling/application/reservations.ts";
import { messageUseCases, type Delivery } from "../../src/scheduling/application/messages.ts";
import { eventually, startApiPair } from "../helpers/concurrency.ts";
import { startWorkerProcess } from "../helpers/worker-process.ts";
import { amqpProxy } from "../helpers/amqp-proxy.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const scope = { hospitalId: "hospital-south", testTypeId: "mri" };
const slotId = "slot-south-mri-1";
let pool: ReturnType<typeof createDatabasePool>;
let api: ReturnType<typeof schedulingUseCases>;
let apis: Awaited<ReturnType<typeof startApiPair>>;
let target: URL;
beforeEach(async () => {
  const name = `acceptance_${Date.now()}_${process.pid}`;
  const admin = createDatabasePool(databaseUrl);
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  target = new URL(databaseUrl); target.pathname = `/${name}`;
  pool = createDatabasePool(target.toString());
  await initializeDatabase(pool);
  api = schedulingUseCases(postgresScheduling(pool));
  apis = await startApiPair(target.toString(), "acceptance");
});
afterEach(async () => { await apis?.stop(); await pool?.end(); });
async function post(path: string, patientId = "patient-ana", key?: string, body?: object) {
  const result = await fetch(`${apis.a.url}${path}`, { method: "POST", headers: {
    "x-patient-id": patientId, ...(key ? { "idempotency-key": key } : {}), ...(body ? { "content-type": "application/json" } : {}),
  }, body: body ? JSON.stringify(body) : undefined });
  return { status: result.status, body: await result.json() };
}
const hold = (patientId = "patient-ana") => post(`/slots/${slotId}/holds`, patientId, `hold-${patientId}`);
const join = (key: string, patientId = "patient-ana", body = scope) => post("/waiting-list-entries", patientId, key, body);
async function consumeReleases() {
  const rows = (await pool.query("SELECT p.* FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id WHERE e.type='SlotReleased' ORDER BY p.created_at,p.id")).rows;
  for (const row of rows) {
    const delivery: Delivery = { version: 1, publicationId: row.id, eventId: row.event_id, consumer: "allocation", cycle: row.cycle, attempt: row.attempt };
    await messageUseCases(postgresScheduling(pool), async () => {}).allocate(delivery);
  }
  return rows;
}

it("AC59/AC11: consumes a release after repeated Q24 rejection without latent participation, then reports Q2 after consumption completed", async () => {
  const held = await hold();
  expect(held.status).toBe(201);
  for (const key of ["rejected-1", "rejected-2"]) expect(await join(key)).toEqual({ status: 409, body: { code: "ACTIVE_HOLD_IN_SCOPE" } });
  expect((await api.getReservation("patient-ana", held.body.id)).body).toMatchObject({ state: "HELD", expiresAt: held.body.expiresAt });
  expect((await post(`/reservations/${held.body.id}/cancel`)).status).toBe(200);
  const releases = await consumeReleases();
  expect(releases).toHaveLength(1);
  expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [releases[0].event_id])).rows).toEqual([{ outcome: "succeeded" }]);
  expect(await join("after-completed-release")).toMatchObject({ status: 409, body: { code: "DIRECT_CAPACITY_AVAILABLE", slots: [{ id: slotId }] } });
  expect((await pool.query("SELECT * FROM scheduling.waiting_list_entries")).rows).toEqual([]);
  expect((await pool.query("SELECT * FROM scheduling.reservations WHERE state='OFFERED'")).rows).toEqual([]);
  expect((await pool.query("SELECT * FROM scheduling.http_creation_results WHERE operation='join-waiting-list' AND status_code IS NOT NULL")).rows).toEqual([]);
});

it.each([
  { hospitalId: "hospital-north", testTypeId: "mri" },
  { hospitalId: "hospital-north", testTypeId: "ultrasound" },
])("AC60: an own hold does not replace Q2 in another scope $hospitalId/$testTypeId", async (otherScope) => {
  const held = await hold();
  expect(held.status).toBe(201);
  expect(await join("other-scope", "patient-ana", otherScope)).toMatchObject({ status: 409, body: { code: "DIRECT_CAPACITY_AVAILABLE" } });
  expect((await api.getReservation("patient-ana", held.body.id)).body).toMatchObject({ state: "HELD", expiresAt: held.body.expiresAt });
  expect((await pool.query("SELECT * FROM scheduling.waiting_list_entries")).rows).toEqual([]);
});

it.each([false, true])("AC61: admission after an own expired hold agrees before and after sweeping; prior waiting=%s", async (priority) => {
  for (const swept of [false, true]) {
    const held = await api.createHold("patient-ana", slotId, `expiry-hold-${swept}`);
    expect(held.status).toBe(201);
    const id = (held.body as { id: string }).id;
    let priorId: string | undefined;
    if (priority) {
      const prior = await api.joinWaitingList("patient-bruno", scope, `prior-${swept}`);
      expect(prior.status).toBe(201); priorId = (prior.body as { id: string }).id;
    }
    await pool.query("UPDATE scheduling.reservations SET created_at=created_at-interval '20 minutes', expires_at=expires_at-interval '20 minutes' WHERE id=$1", [id]);
    if (swept) expect(await api.expireTemporaryReservations()).toBe(1);
    const result = await api.joinWaitingList("patient-ana", scope, `new-${swept}`);
    expect(result).toMatchObject(priority ? { status: 201, body: { state: "WAITING" } } : { status: 409, body: { code: "DIRECT_CAPACITY_AVAILABLE" } });
    expect((await pool.query("SELECT reason FROM scheduling.reservation_closures WHERE reservation_id=$1", [id])).rows).toEqual([{ reason: "EXPIRED" }]);
    expect((await api.getReservation("patient-ana", id)).body).toMatchObject({ state: "EXPIRED" });
    if (priority) {
      const body = result.body as { id: string; admissionOrder: string };
      const prior = (await api.getWaitingListEntry("patient-bruno", priorId!)).body as { admissionOrder: string };
      expect(BigInt(body.admissionOrder)).toBe(BigInt(prior.admissionOrder) + 1n);
      await api.withdrawWaitingListEntry("patient-ana", body.id);
      await api.withdrawWaitingListEntry("patient-bruno", priorId!);
    }
  }
});

it("AC63: replays closed I1 with its original 201 despite an own live hold, preserving the deadline and creating no I2", async () => {
  const carlos = await hold("patient-carlos");
  const first = await join("historical-k1"); expect(first.status).toBe(201);
  expect((await post(`/waiting-list-entries/${first.body.id}/withdraw`)).status).toBe(200);
  await post(`/reservations/${carlos.body.id}/cancel`, "patient-carlos");
  const held = await hold(); expect(held.status).toBe(201);
  expect(await join("historical-k1")).toEqual(first);
  expect((await api.getWaitingListEntry("patient-ana", first.body.id)).body).toMatchObject({ state: "CLOSED", closureReason: "WITHDRAWN" });
  expect((await api.getReservation("patient-ana", held.body.id)).body).toMatchObject({ state: "HELD", expiresAt: held.body.expiresAt });
  expect((await pool.query("SELECT id FROM scheduling.waiting_list_entries")).rows).toEqual([{ id: first.body.id }]);
});

it("AC68/AC33: retains HTTP cancellation while the broker connection is down, then asynchronously offers Ana the same slot with a new identity", async () => {
  const rabbitmqUrl = process.env.TEST_RABBITMQ_URL;
  if (!rabbitmqUrl) throw new Error("TEST_RABBITMQ_URL is required");
  const proxy = await amqpProxy(rabbitmqUrl); proxy.setAvailable(false);
  let worker: Awaited<ReturnType<typeof startWorkerProcess>> | undefined;
  try {
    worker = await startWorkerProcess(target.toString(), proxy.url, { requireRabbitmq: false });
    const first = await hold(); expect(first.status).toBe(201);
    expect((await post(`/reservations/${first.body.id}/confirm`)).body).toMatchObject({ id: first.body.id, state: "CONFIRMED" });
    const entry = await join("ana-confirmed-join"); expect(entry.status).toBe(201);
    expect((await post(`/reservations/${first.body.id}/cancel`)).status).toBe(200);
    const pending = (await pool.query("SELECT p.id,p.event_id FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id WHERE e.type='SlotReleased' AND e.payload->>'reservationId'=$1 AND p.published_at IS NULL", [first.body.id])).rows;
    expect(pending).toHaveLength(1);
    expect((await api.getWaitingListEntry("patient-ana", entry.body.id)).body).toMatchObject({ state: "WAITING" });
    proxy.setAvailable(true);
    const offered = await eventually(() => api.getWaitingListEntry("patient-ana", entry.body.id), (result) => "state" in result.body && result.body.state === "OFFERED", 15000);
    const second = (offered.body as { offer: { id: string; expiresAt: string } }).offer;
    expect(second.id).not.toBe(first.body.id);
    await eventually(async () => worker!.logs().includes(`"reservationId":"${second.id}"`), Boolean, 10000);
    expect((await api.getReservation("patient-ana", first.body.id)).body).toMatchObject({ state: "CANCELLED" });
    expect((await api.getReservation("patient-ana", second.id)).body).toMatchObject({ state: "OFFERED", slotId, expiresAt: second.expiresAt });
    expect((await pool.query("SELECT published_at FROM scheduling.outbox_publications WHERE id=$1", [pending[0].id])).rows[0].published_at).not.toBeNull();
    expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.reservations WHERE slot_id=$1 AND state IN ('HELD','OFFERED','CONFIRMED')", [slotId])).rows[0].n).toBe(1);
    process.stdout.write(`AC68/AC33 real network ${JSON.stringify({ R1: first.body.id, R2: second.id, publicationId: pending[0].id })}\n`);
  } finally { await worker?.stop(); await proxy.close(); }
}, 35000);

it("AC25: a restarted worker closes holds and offers overdue during its stop while preserving a confirmed appointment", async () => {
  const carlos = await hold("patient-carlos");
  const entry = await join("restart-ana"); expect(entry.status).toBe(201);
  await post(`/reservations/${carlos.body.id}/cancel`, "patient-carlos");
  await consumeReleases();
  const offered = (await api.getWaitingListEntry("patient-ana", entry.body.id)).body as { offer: { id: string } };
  const held = await api.createHold("patient-bruno", "slot-north-mri-1", "restart-held");
  const confirmed = await api.createHold("patient-carlos", "slot-north-mri-2", "restart-confirmed");
  const heldId = (held.body as { id: string }).id;
  const confirmedId = (confirmed.body as { id: string }).id;
  await api.confirmReservation("patient-carlos", confirmedId);
  let worker = await startWorkerProcess(target.toString(), "amqp://diagnostic:diagnostic_dev@127.0.0.1:1", { requireRabbitmq: false });
  try {
    await worker.stop();
    const deadline = (await pool.query<{ expires_at: Date }>(`UPDATE scheduling.reservations SET expires_at=date_trunc('milliseconds',clock_timestamp())+interval '300 milliseconds'
      WHERE id IN ($1,$2) RETURNING expires_at`, [offered.offer.id, heldId])).rows[0].expires_at;
    await pool.query("UPDATE scheduling.reservations SET created_at=created_at-interval '20 minutes',expires_at=expires_at-interval '20 minutes' WHERE id=$1", [confirmedId]);
    await eventually(async () => (await pool.query("SELECT clock_timestamp()>=$1 AS reached", [deadline])).rows[0].reached, Boolean);
    expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id IN ($1,$2) ORDER BY state", [offered.offer.id, heldId])).rows).toEqual([{ state: "HELD" }, { state: "OFFERED" }]);
    worker = await startWorkerProcess(target.toString(), "amqp://diagnostic:diagnostic_dev@127.0.0.1:1", { requireRabbitmq: false });
    await eventually(async () => (await pool.query("SELECT count(*)::integer AS n FROM scheduling.reservations WHERE id IN ($1,$2) AND state='EXPIRED'", [offered.offer.id, heldId])).rows[0].n, (n) => n === 2, 8000);
    expect((await api.getWaitingListEntry("patient-ana", entry.body.id)).body).toMatchObject({ state: "CLOSED", closureReason: "EXPIRED" });
    expect((await api.getReservation("patient-carlos", confirmedId)).body).toMatchObject({ state: "CONFIRMED" });
    expect((await pool.query("SELECT reason FROM scheduling.reservation_closures WHERE reservation_id IN ($1,$2) ORDER BY reservation_id", [offered.offer.id, heldId])).rows).toEqual([{ reason: "EXPIRED" }, { reason: "EXPIRED" }]);
    expect((await pool.query("SELECT * FROM scheduling.reservation_closures WHERE reservation_id=$1", [confirmedId])).rows).toEqual([]);
  } finally { await worker.stop(); }
}, 20000);
