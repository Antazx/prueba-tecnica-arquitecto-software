import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../../src/scheduling/adapters/postgres/initialize.ts";
import { postgresScheduling } from "../../src/scheduling/adapters/postgres/scheduling.ts";
import { schedulingUseCases } from "../../src/scheduling/application/reservations.ts";
import { messageUseCases, type Delivery } from "../../src/scheduling/application/messages.ts";
import { awaitBlocked, eventually, holdScope, startApiPair } from "../helpers/concurrency.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const isolated = new URL(databaseUrl);
isolated.pathname = `/offer_expiry_${randomUUID().replaceAll("-", "")}`;
const pool = createDatabasePool(isolated.toString());
const store = postgresScheduling(pool);
const api = schedulingUseCases(store);
const messages = messageUseCases(store, async () => {});
beforeAll(async () => {
  const admin = createDatabasePool(databaseUrl);
  try { await admin.query(`CREATE DATABASE ${isolated.pathname.slice(1)}`); } finally { await admin.end(); }
  await initializeDatabase(pool);
});
afterAll(() => pool.end());

function idOf(result: { body: object }) {
  if (!("id" in result.body) || typeof result.body.id !== "string") throw new Error("Expected resource identity");
  return result.body.id;
}
async function eventDelivery(reservationId: string, type = "SlotReleased"): Promise<Delivery> {
  const row = (await pool.query(`SELECT p.* FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id
    WHERE e.type=$2 AND e.payload->>'reservationId'=$1`, [reservationId, type])).rows[0];
  return { version: 1, publicationId: row.id, eventId: row.event_id, consumer: row.consumer, cycle: row.cycle, attempt: row.attempt };
}
async function fixture(withBruno = true) {
  const hospitalId = `expiry-${randomUUID()}`;
  const scope = { hospitalId, testTypeId: "mri" };
  const slotId = `${hospitalId}-h1`;
  await pool.query("INSERT INTO scheduling.hospitals VALUES ($1)", [hospitalId]);
  await pool.query("INSERT INTO scheduling.waiting_list_scopes VALUES ($1,'mri')", [hospitalId]);
  await pool.query("INSERT INTO scheduling.diagnostic_resources VALUES ($1,$1,'mri')", [hospitalId]);
  await pool.query(`INSERT INTO scheduling.slots VALUES ($1,$2,$2,'mri',
    date_trunc('milliseconds',clock_timestamp())+interval '1 day',date_trunc('milliseconds',clock_timestamp())+interval '1 day 30 minutes')`, [slotId, hospitalId]);
  const held = await api.createHold("patient-carlos", slotId, randomUUID());
  expect(held.status).toBe(201);
  const key1 = randomUUID();
  const ana = await api.joinWaitingList("patient-ana", scope, key1);
  expect(ana.status).toBe(201);
  const bruno = withBruno ? await api.joinWaitingList("patient-bruno", scope, randomUUID()) : undefined;
  await api.cancelReservation("patient-carlos", idOf(held));
  await messages.allocate(await eventDelivery(idOf(held)));
  const entry = await api.getWaitingListEntry("patient-ana", idOf(ana));
  if (!("offer" in entry.body) || !entry.body.offer) throw new Error("Expected offer");
  return { scope, slotId, entryId: idOf(ana), key1, original: ana, offerId: entry.body.offer.id, brunoId: bruno ? idOf(bruno) : undefined };
}
async function expire(offerId: string) {
  await pool.query(`UPDATE scheduling.reservations SET created_at=created_at-interval '3 hours',
    expires_at=date_trunc('milliseconds',clock_timestamp())-interval '1 millisecond' WHERE id=$1`, [offerId]);
}
async function releaseCount(offerId: string) {
  return (await pool.query("SELECT count(*)::integer AS n FROM scheduling.reservation_closures WHERE reservation_id=$1", [offerId])).rows[0].n;
}

it("sweeps an expired offer once, closes its entry and durably activates the next waiting patient", async () => {
  const f = await fixture();
  await expire(f.offerId);
  expect(await api.expireTemporaryReservations()).toBe(1);
  expect((await api.getWaitingListEntry("patient-ana", f.entryId)).body).toMatchObject({ state: "CLOSED", closureReason: "EXPIRED" });
  expect((await api.getReservation("patient-ana", f.offerId)).body).toMatchObject({ state: "EXPIRED" });
  await messages.allocate(await eventDelivery(f.offerId));
  expect((await api.getWaitingListEntry("patient-bruno", f.brunoId!)).body).toMatchObject({ state: "OFFERED", offer: { slotId: f.slotId } });
  expect(await releaseCount(f.offerId)).toBe(1);
  expect(await api.expireTemporaryReservations()).toBe(0);
});

it("normalizes a new rejoining intention before returning an active entry, while preserving historical keys", async () => {
  const f = await fixture();
  await expire(f.offerId);
  const key2 = randomUUID();
  const joined = await api.joinWaitingList("patient-ana", f.scope, key2);
  expect(joined.status).toBe(201);
  expect(idOf(joined)).not.toBe(f.entryId);
  expect(joined.body).toMatchObject({ state: "WAITING", admissionOrder: "3" });
  expect((await api.getWaitingListEntry("patient-ana", f.entryId)).body).toMatchObject({ state: "CLOSED", closureReason: "EXPIRED" });
  expect(await api.joinWaitingList("patient-ana", f.scope, key2)).toEqual(joined);
  expect(await api.joinWaitingList("patient-ana", f.scope, f.key1)).toEqual(f.original);
  expect(await releaseCount(f.offerId)).toBe(1);
  expect((await pool.query(`SELECT count(*)::integer AS n FROM scheduling.events
    WHERE payload->>'hospitalId'=$1 AND type='AllocationReviewRequested'`, [f.scope.hospitalId])).rows[0].n).toBe(2);
});

it.each(["priority", "capacity", "own-hold"] as const)("makes the same %s rejoining decision before and after a sweep, committing closures even on conflict", async (mode) => {
  for (const swept of [false, true]) {
    const f = await fixture(mode === "priority");
    let held: Awaited<ReturnType<typeof api.createHold>> | undefined;
    if (mode === "own-hold") {
      await pool.query(`INSERT INTO scheduling.slots SELECT id||'-other',resource_id,hospital_id,test_type_id,
        starts_at+interval '1 hour',ends_at+interval '1 hour' FROM scheduling.slots WHERE id=$1`, [f.slotId]);
      held = await api.createHold("patient-ana", `${f.slotId}-other`, randomUUID());
      expect(held.status).toBe(201);
    }
    await expire(f.offerId);
    if (swept) await api.expireTemporaryReservations();
    const key = randomUUID();
    const result = await api.joinWaitingList("patient-ana", f.scope, key);
    expect(result.status).toBe(mode === "priority" ? 201 : 409);
    expect(result.body).toMatchObject(mode === "priority" ? { state: "WAITING", admissionOrder: "3" }
      : { code: mode === "capacity" ? "DIRECT_CAPACITY_AVAILABLE" : "ACTIVE_HOLD_IN_SCOPE" });
    expect((await api.getWaitingListEntry("patient-ana", f.entryId)).body).toMatchObject({ state: "CLOSED", closureReason: "EXPIRED" });
    expect(await releaseCount(f.offerId)).toBe(1);
    const saved = (await pool.query("SELECT status_code,response_body FROM scheduling.http_creation_results WHERE idempotency_key=$1", [key])).rows[0];
    expect(saved.status_code).toBe(mode === "priority" ? 201 : null);
    if (held) expect((await api.getReservation("patient-ana", idOf(held))).body).toMatchObject({ state: "HELD", expiresAt: "expiresAt" in held.body ? held.body.expiresAt : undefined });
    expect(await api.joinWaitingList("patient-ana", f.scope, f.key1)).toEqual(f.original);
    if (mode === "capacity") {
      expect((await api.createHold("patient-carlos", f.slotId, randomUUID())).status).toBe(201);
      const changed = await api.joinWaitingList("patient-ana", f.scope, key);
      expect(changed.status).toBe(201);
      expect(idOf(changed)).not.toBe(f.entryId);
    }
  }
});

it("returns and retains a new successful key for a live offer despite a coexisting own hold", async () => {
  const f = await fixture(false);
  await pool.query(`INSERT INTO scheduling.slots SELECT id||'-other',resource_id,hospital_id,test_type_id,
    starts_at+interval '1 hour',ends_at+interval '1 hour' FROM scheduling.slots WHERE id=$1`, [f.slotId]);
  const held = await api.createHold("patient-ana", `${f.slotId}-other`, randomUUID());
  const key = randomUUID();
  const existing = await api.joinWaitingList("patient-ana", f.scope, key);
  expect(existing).toMatchObject({ status: 200, body: { id: f.entryId, state: "OFFERED", offer: { id: f.offerId } } });
  await expire(f.offerId);
  expect(await api.joinWaitingList("patient-ana", f.scope, key)).toEqual(existing);
  expect(await api.joinWaitingList("patient-ana", f.scope, f.key1)).toEqual(f.original);
  expect(await releaseCount(f.offerId)).toBe(0);
  expect((await api.getReservation("patient-ana", idOf(held))).body).toMatchObject({ state: "HELD" });
  await api.expireTemporaryReservations();
});

it("normalizes another patient's expired offer before Q2 without inventing an admission", async () => {
  const f = await fixture(false);
  await expire(f.offerId);
  const key = randomUUID();
  const result = await api.joinWaitingList("patient-bruno", f.scope, key);
  expect(result).toMatchObject({ status: 409, body: { code: "DIRECT_CAPACITY_AVAILABLE", slots: [{ id: f.slotId }] } });
  expect(await releaseCount(f.offerId)).toBe(1);
  expect((await pool.query("SELECT status_code FROM scheduling.http_creation_results WHERE idempotency_key=$1", [key])).rows).toEqual([{ status_code: null }]);
  expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [f.scope.hospitalId])).rows[0].n).toBe(1);
});

it("closes own expired holds even after their slot started before rejoining", async () => {
  const f = await fixture(false);
  await pool.query(`INSERT INTO scheduling.slots SELECT id||'-other',resource_id,hospital_id,test_type_id,
    starts_at+interval '1 hour',ends_at+interval '1 hour' FROM scheduling.slots WHERE id=$1`, [f.slotId]);
  const held = await api.createHold("patient-ana", `${f.slotId}-other`, randomUUID());
  await expire(f.offerId); await expire(idOf(held));
  await pool.query("UPDATE scheduling.slots SET starts_at=starts_at-interval '2 days',ends_at=ends_at-interval '2 days' WHERE id=$1", [`${f.slotId}-other`]);
  expect(await api.joinWaitingList("patient-ana", f.scope, randomUUID())).toMatchObject({ status: 409, body: { code: "DIRECT_CAPACITY_AVAILABLE" } });
  expect(await releaseCount(f.offerId)).toBe(1);
  expect(await releaseCount(idOf(held))).toBe(1);
});

it("rolls back closures, release work, I2 and its key together on a deferred commit failure", async () => {
  const f = await fixture();
  await expire(f.offerId);
  const key = randomUUID();
  await pool.query(`CREATE FUNCTION scheduling.fail_expiry_commit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.idempotency_key='${key}' AND NEW.status_code IS NOT NULL THEN
      RAISE EXCEPTION 'Synthetic commit failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE CONSTRAINT TRIGGER fail_expiry_commit AFTER UPDATE ON scheduling.http_creation_results
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION scheduling.fail_expiry_commit()`);
  try {
    await expect(api.joinWaitingList("patient-ana", f.scope, key)).rejects.toThrow("Synthetic commit failure");
    expect((await api.getWaitingListEntry("patient-ana", f.entryId)).body).toMatchObject({ state: "OFFERED", temporal: { expired: true, closurePending: true } });
    expect(await releaseCount(f.offerId)).toBe(0);
    expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [f.scope.hospitalId])).rows[0].n).toBe(2);
    expect((await pool.query("SELECT * FROM scheduling.http_creation_results WHERE idempotency_key=$1", [key])).rows).toEqual([]);
  } finally {
    await pool.query("DROP TRIGGER fail_expiry_commit ON scheduling.http_creation_results");
    await pool.query("DROP FUNCTION scheduling.fail_expiry_commit()");
    await api.expireTemporaryReservations();
  }
});

it("keeps GETs read only, exposes a pending expired offer and never invents expiry for confirmed or waiting entries", async () => {
  const f = await fixture();
  const readonlyUrl = new URL(isolated); readonlyUrl.searchParams.set("options", "-c default_transaction_read_only=on");
  const reader = createDatabasePool(readonlyUrl.toString());
  const read = schedulingUseCases(postgresScheduling(reader));
  try {
    expect((await read.getWaitingListEntry("patient-ana", f.entryId)).body).toMatchObject({ state: "OFFERED", temporal: { expired: false, closurePending: false }, actions: { canAcceptOffer: true } });
    await expire(f.offerId);
    expect((await read.getWaitingListEntry("patient-ana", f.entryId)).body).toMatchObject({ state: "OFFERED", offer: { id: f.offerId }, temporal: { expired: true, closurePending: true }, actions: { canAcceptOffer: false, canRejectOffer: false } });
    expect((await read.getReservation("patient-ana", f.offerId)).body).toMatchObject({ state: "OFFERED", temporal: { expired: true, closurePending: true }, actions: { canConfirm: false } });
    expect((await read.getWaitingListEntry("patient-bruno", f.brunoId!)).body).toMatchObject({ state: "WAITING", temporal: { expired: false, closurePending: false } });
    expect(await releaseCount(f.offerId)).toBe(0);
  } finally { await reader.end(); }
  await api.expireTemporaryReservations();
  const confirmed = await fixture();
  expect((await api.confirmReservation("patient-ana", confirmed.offerId)).status).toBe(200);
  await expire(confirmed.offerId);
  await api.expireTemporaryReservations();
  expect((await api.getReservation("patient-ana", confirmed.offerId)).body).toMatchObject({ state: "CONFIRMED", temporal: { expired: false, closurePending: false } });
  expect(await releaseCount(confirmed.offerId)).toBe(0);
});

it.each([false, true])("coordinates two new keys across the offer deadline with FIFO priority=%s", async (priority) => {
  const f = await fixture(priority);
  const pair = await startApiPair(isolated.toString(), `offer-cross-${randomUUID()}`);
  const deadline = (await pool.query<{ expires_at: Date }>(`UPDATE scheduling.reservations
    SET expires_at=date_trunc('milliseconds',clock_timestamp())+interval '900 milliseconds' WHERE id=$1 RETURNING expires_at`, [f.offerId])).rows[0].expires_at;
  const barrier = await holdScope(pool, f.scope.hospitalId, "mri");
  const key = randomUUID();
  const join = async (url: string) => {
    const response = await fetch(`${url}/waiting-list-entries`, { method: "POST", headers: { "x-patient-id": "patient-ana", "idempotency-key": key, "content-type": "application/json" }, body: JSON.stringify(f.scope) });
    return { status: response.status, body: await response.json() };
  };
  const a = join(pair.a.url); const b = join(pair.b.url);
  try {
    const waiting = await awaitBlocked(pool, [pair.a.applicationName, pair.b.applicationName], barrier.pid);
    for (const request of waiting) expect(request.xact_start.getTime()).toBeLessThan(deadline.getTime());
    await eventually(async () => (await pool.query("SELECT clock_timestamp() >= $1 AS reached", [deadline])).rows[0].reached, Boolean);
  } finally { await barrier.release(); }
  try {
    const responses = await Promise.all([a, b]);
    expect(responses.map((response) => response.status)).toEqual(priority ? [201, 201] : [409, 409]);
    expect(responses[0].body).toEqual(responses[1].body);
    expect(await releaseCount(f.offerId)).toBe(1);
    expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [f.scope.hospitalId])).rows[0].n).toBe(priority ? 3 : 1);
    expect((await pool.query("SELECT status_code FROM scheduling.http_creation_results WHERE idempotency_key=$1", [key])).rows).toEqual([{ status_code: priority ? 201 : null }]);
  } finally { await pair.stop(); }
}, 10000);

it.each(["confirmation", "sweep"])("coordinates expiry, confirmation and rejoining with %s first under a real row barrier", async (first) => {
  const f = await fixture();
  const pair = await startApiPair(isolated.toString(), `offer-transition-${first}`);
  if (first === "sweep") await expire(f.offerId);
  else await pool.query("UPDATE scheduling.reservations SET expires_at=date_trunc('milliseconds',clock_timestamp())+interval '900 milliseconds' WHERE id=$1", [f.offerId]);
  const deadline = (await pool.query("SELECT expires_at FROM scheduling.reservations WHERE id=$1", [f.offerId])).rows[0].expires_at;
  const controller = await pool.connect();
  await controller.query("BEGIN");
  const pid = (await controller.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await controller.query("SELECT id FROM scheduling.reservations WHERE id=$1 FOR UPDATE", [f.offerId]);
  const sweeperName = `offer-sweep-${first}`;
  const url = new URL(isolated); url.searchParams.set("application_name", sweeperName);
  let child: ReturnType<typeof spawn> | undefined;
  let output = "";
  const sweep = () => {
    child = spawn(process.execPath, ["test/helpers/expiry-process.ts"], { env: { ...process.env, DATABASE_URL: url.toString() }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
    return once(child, "exit");
  };
  const post = async (base: string, path: string, body?: object) => {
    const response = await fetch(`${base}${path}`, { method: "POST", headers: { "x-patient-id": "patient-ana", "idempotency-key": randomUUID(), ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: await response.json() };
  };
  let confirming: ReturnType<typeof post> | undefined;
  let joining: ReturnType<typeof post> | undefined;
  let swept: ReturnType<typeof sweep> | undefined;
  try {
    if (first === "confirmation") {
      confirming = post(pair.a.url, `/reservations/${f.offerId}/confirm`);
      const blocked = await awaitBlocked(pool, [pair.a.applicationName], pid);
      expect(blocked[0].xact_start.getTime()).toBeLessThan(deadline.getTime());
      await eventually(async () => (await pool.query("SELECT clock_timestamp()>=$1 AS reached", [deadline])).rows[0].reached, Boolean);
      swept = sweep();
    } else {
      swept = sweep();
      await awaitBlocked(pool, [sweeperName], pid);
      confirming = post(pair.a.url, `/reservations/${f.offerId}/confirm`);
    }
    joining = post(pair.b.url, "/waiting-list-entries", f.scope);
    await awaitBlocked(pool, [sweeperName, pair.a.applicationName, pair.b.applicationName], pid);
  } finally { try { await controller.query("ROLLBACK"); } finally { controller.release(); } }
  try {
    expect(await confirming).toMatchObject({ status: 409, body: { id: f.offerId, state: "EXPIRED" } });
    expect(await joining).toMatchObject({ status: 201, body: { state: "WAITING", admissionOrder: "3" } });
    await swept;
    expect(child!.exitCode, output).toBe(0);
    expect(await releaseCount(f.offerId)).toBe(1);
    expect((await api.getWaitingListEntry("patient-ana", f.entryId)).body).toMatchObject({ state: "CLOSED", closureReason: "EXPIRED" });
  } finally { if (child && child.exitCode === null) { const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; } await pair.stop(); }
}, 10000);
