import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../../src/scheduling/adapters/postgres/initialize.ts";
import { postgresScheduling } from "../../src/scheduling/adapters/postgres/scheduling.ts";
import { schedulingUseCases } from "../../src/scheduling/application/reservations.ts";
import { messageUseCases } from "../../src/scheduling/application/messages.ts";
import type { Delivery } from "../../src/scheduling/application/messages.ts";
import { Writable } from "node:stream";
import { structuredNotificationWriter } from "../../src/scheduling/adapters/notification.ts";
import { eventually } from "../helpers/concurrency.ts";
import { holdScope, awaitBlocked } from "../helpers/concurrency.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "amqplib";
import { assertTopology, publishConfirmed } from "../../src/scheduling/adapters/rabbitmq/messaging.ts";
import { postgresOutbox } from "../../src/scheduling/adapters/postgres/outbox.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const pool = createDatabasePool(databaseUrl);
const scheduling = postgresScheduling(pool);
const api = schedulingUseCases(scheduling);
const messages = messageUseCases(scheduling, async () => {});
const scope = { hospitalId: "offer-test-hospital", testTypeId: "mri" };
async function cleanup() {
  const events = "SELECT id FROM scheduling.events WHERE payload->>'hospitalId'='offer-test-hospital'";
  await pool.query(`DELETE FROM scheduling.consumer_attempts WHERE event_id IN (${events})`);
  await pool.query(`DELETE FROM scheduling.consumer_cycles WHERE event_id IN (${events})`);
  await pool.query(`DELETE FROM scheduling.consumer_results WHERE event_id IN (${events})`);
  await pool.query(`DELETE FROM scheduling.outbox_publications WHERE event_id IN (${events})`);
  await pool.query("DELETE FROM scheduling.reservation_closures WHERE reservation_id IN (SELECT id FROM scheduling.reservations WHERE slot_id LIKE 'offer-test-%')");
  await pool.query(`DELETE FROM scheduling.events WHERE id IN (${events})`);
  await pool.query("DELETE FROM scheduling.reservations WHERE slot_id LIKE 'offer-test-%'");
  await pool.query("DELETE FROM scheduling.waiting_list_slot_exclusions WHERE entry_id IN (SELECT id FROM scheduling.waiting_list_entries WHERE hospital_id=$1)", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.slots WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.diagnostic_resources WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.waiting_list_scopes WHERE hospital_id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.hospitals WHERE id=$1", [scope.hospitalId]);
  await pool.query("DELETE FROM scheduling.http_creation_results WHERE idempotency_key LIKE 'offer-test-%'");
}
beforeAll(async () => { await initializeDatabase(pool); await cleanup(); });
afterEach(cleanup);
beforeEach(async () => {
  await pool.query("INSERT INTO scheduling.hospitals VALUES ($1)", [scope.hospitalId]);
  await pool.query("INSERT INTO scheduling.waiting_list_scopes VALUES ($1, $2)", [scope.hospitalId, scope.testTypeId]);
  await pool.query("INSERT INTO scheduling.diagnostic_resources VALUES ('offer-test-resource', $1, $2)", [scope.hospitalId, scope.testTypeId]);
  await pool.query(`INSERT INTO scheduling.slots VALUES ('offer-test-h', 'offer-test-resource', $1, $2,
    date_trunc('milliseconds',clock_timestamp())+interval '1 day', date_trunc('milliseconds',clock_timestamp())+interval '1 day 30 minutes')`, [scope.hospitalId, scope.testTypeId]);
});
afterAll(async () => { await pool.end(); });

async function delivery(): Promise<Delivery> {
  const row = (await pool.query(`SELECT p.* FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id
    WHERE e.type='SlotReleased' AND e.payload->>'hospitalId'=$1 ORDER BY p.created_at, p.id LIMIT 1`, [scope.hospitalId])).rows[0];
  return { version: 1, publicationId: row.id, eventId: row.event_id, consumer: row.consumer, cycle: row.cycle, attempt: row.attempt };
}

async function offerToAna(offerMaximumMs?: number) {
  const held = await api.createHold("patient-carlos", "offer-test-h", "offer-test-carlos");
  if (!("id" in held.body)) throw new Error("Expected hold");
  const entry = await api.joinWaitingList("patient-ana", scope, "offer-test-ana");
  if (!("id" in entry.body)) throw new Error("Expected entry");
  await api.cancelReservation("patient-carlos", held.body.id);
  await messageUseCases(scheduling, async () => {}, { offerMaximumMs }).allocate(await delivery());
  const offer = (await pool.query("SELECT * FROM scheduling.reservations WHERE slot_id='offer-test-h' AND state='OFFERED'")).rows[0];
  const row = (await pool.query(`SELECT p.* FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id
    WHERE e.type='OfferCreated' AND e.payload->>'reservationId'=$1`, [offer.id])).rows[0];
  const notification: Delivery = { version: 1, publicationId: row.id, eventId: row.event_id, consumer: "notification", cycle: 0, attempt: 0 };
  return { offer, entryId: entry.body.id, notification };
}

async function allocationReady() {
  const held = await api.createHold("patient-carlos", "offer-test-h", "offer-test-carlos");
  if (!("id" in held.body)) throw new Error("Expected hold");
  await api.joinWaitingList("patient-ana", scope, "offer-test-ana");
  await api.cancelReservation("patient-carlos", held.body.id);
  return delivery();
}

async function consumerProcess(name: string, pause = false) {
  const url = new URL(databaseUrl!); url.searchParams.set("application_name", name);
  const phases: string[] = [];
  let logs = "";
  const child = spawn(process.execPath, ["test/helpers/consumer-process.ts"], { cwd: process.cwd(), env: {
    ...process.env, DATABASE_URL: url.toString(), RABBITMQ_URL: process.env.TEST_RABBITMQ_URL, PAUSE_AFTER_COMMIT: String(pause),
  }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.on("message", (value: { phase: string }) => phases.push(value.phase));
  child.stdout?.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  await eventually(async () => {
    if (child.exitCode !== null) throw new Error(logs);
    return phases.includes("ready");
  }, Boolean, 8000);
  return { child, phases, stop: async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGTERM"); await exited;
  } };
}

it("atomically allocates once under duplicate deliveries, exposes the own offer and accepts its same identity", async () => {
  const held = await api.createHold("patient-carlos", "offer-test-h", `offer-test-${randomUUID()}`);
  expect(held.status).toBe(201);
  const reservation = held.body as { id: string };
  expect((await api.joinWaitingList("patient-ana", scope, "offer-test-ana")).status).toBe(201);
  expect((await api.joinWaitingList("patient-bruno", scope, "offer-test-bruno")).status).toBe(201);
  expect((await api.cancelReservation("patient-carlos", reservation.id)).status).toBe(200);
  const envelope = await delivery();
  await Promise.all([messages.allocate(envelope), messages.allocate(envelope)]);
  const rows = (await pool.query("SELECT * FROM scheduling.reservations WHERE slot_id='offer-test-h' AND state='OFFERED'")).rows;
  expect(rows).toHaveLength(1);
  expect(rows[0].patient_id).toBe("patient-ana");
  expect(rows[0].expires_at.getTime() - rows[0].created_at.getTime()).toBe(7_200_000);
  const own = await api.getWaitingListEntry("patient-ana", rows[0].waiting_list_entry_id);
  expect(own.body).toMatchObject({ state: "OFFERED", offer: { id: rows[0].id }, temporal: { expired: false } });
  expect((await api.confirmReservation("patient-ana", rows[0].id)).body).toMatchObject({ id: rows[0].id, state: "CONFIRMED" });
  expect((await api.getWaitingListEntry("patient-ana", rows[0].waiting_list_entry_id)).body).toMatchObject({ state: "CLOSED", closureReason: "ACCEPTED" });
  expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.events WHERE type='OfferCreated' AND payload->>'hospitalId'=$1", [scope.hospitalId])).rows[0].n).toBe(1);
});

it("returns an offered active entry with a new key while preserving a permitted direct hold", async () => {
  const { offer, entryId } = await offerToAna();
  await pool.query(`INSERT INTO scheduling.slots SELECT 'offer-test-other',resource_id,hospital_id,test_type_id,
    starts_at+interval '1 hour',ends_at+interval '1 hour' FROM scheduling.slots WHERE id='offer-test-h'`);
  const held = await api.createHold("patient-ana", "offer-test-other", "offer-test-coexist");
  expect(held.status).toBe(201);
  const again = await api.joinWaitingList("patient-ana", scope, "offer-test-new-key");
  expect(again.status).toBe(200);
  expect(again.body).toMatchObject({ id: entryId, state: "OFFERED", offer: { id: offer.id, expiresAt: offer.expires_at.toISOString() } });
  expect((await api.getReservation("patient-ana", offer.id)).body).toMatchObject({ state: "OFFERED" });
  expect((await api.joinWaitingList("patient-ana", scope, "offer-test-ana")).status).toBe(201);
});

it("reads expired persisted offers conservatively without writes and closes them on late acceptance", async () => {
  const { offer, entryId } = await offerToAna();
  await pool.query("UPDATE scheduling.reservations SET created_at=created_at-interval '3 hours',expires_at=clock_timestamp()::timestamp(3)-interval '1 millisecond' WHERE id=$1", [offer.id]);
  const url = new URL(databaseUrl!); url.searchParams.set("options", "-c default_transaction_read_only=on");
  const reader = createDatabasePool(url.toString());
  try {
    const readOnly = schedulingUseCases(postgresScheduling(reader));
    const response = await readOnly.getWaitingListEntry("patient-ana", entryId);
    expect(response.body).toMatchObject({ state: "OFFERED", temporal: { expired: true, closurePending: true }, actions: { canWithdraw: false }, offer: { id: offer.id } });
    expect((await readOnly.getReservation("patient-ana", offer.id)).body).toMatchObject({ state: "OFFERED", temporal: { expired: true }, actions: { canConfirm: false } });
  } finally { await reader.end(); }
  expect((await api.confirmReservation("patient-ana", offer.id)).status).toBe(409);
  expect((await api.getWaitingListEntry("patient-ana", entryId)).body).toMatchObject({ state: "CLOSED", closureReason: "EXPIRED" });
});

it("awaits output completion outside the business scope and allows a log checked before acceptance to appear later", async () => {
  const { offer, notification } = await offerToAna();
  let flush: ((error?: Error | null) => void) | undefined;
  let line = "";
  const output = new Writable({ write(chunk, _encoding, callback) { line += chunk.toString(); flush = callback; } });
  const notifying = messageUseCases(scheduling, structuredNotificationWriter(output)).notify(notification);
  await eventually(async () => Boolean(flush), Boolean);
  expect(JSON.parse(line)).toMatchObject({ event: "offer_notification", eventId: notification.eventId, reservationId: offer.id, expiresAt: offer.expires_at.toISOString() });
  expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [notification.eventId])).rows).toEqual([]);
  const confirmed = await api.confirmReservation("patient-ana", offer.id);
  expect(confirmed.status).toBe(200);
  flush!();
  await notifying;
  expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [notification.eventId])).rows).toEqual([{ outcome: "succeeded" }]);
});

it("retains failed notification output and revalidates a now invalid offer on its scheduled retry", async () => {
  const { offer, notification } = await offerToAna();
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("Synthetic output failure")); } });
  // Node may emit error after invoking its write callback; keep the stream's failed state observed.
  output.on("error", () => {});
  await messageUseCases(scheduling, structuredNotificationWriter(output)).notify(notification);
  expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [notification.eventId])).rows).toEqual([{ outcome: null }]);
  expect((await pool.query("SELECT outcome,last_error FROM scheduling.consumer_attempts WHERE event_id=$1 AND attempt=0", [notification.eventId])).rows)
    .toEqual([{ outcome: "failed", last_error: "Synthetic output failure" }]);
  await api.confirmReservation("patient-ana", offer.id);
  let written = false;
  await messageUseCases(scheduling, async () => { written = true; }).notify(notification);
  expect(written).toBe(false);
  expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [notification.eventId])).rows).toEqual([{ outcome: null }]);
  const next = (await pool.query("SELECT * FROM scheduling.outbox_publications WHERE event_id=$1 AND attempt=1", [notification.eventId])).rows[0];
  await eventually(async () => (await postgresOutbox(pool).ready()).some((row) => row.publicationId === next.id), Boolean, 7000);
  await messageUseCases(scheduling, async () => { written = true; }).notify({ ...notification, attempt: 1, publicationId: next.id });
  expect(written).toBe(false);
  expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [notification.eventId])).rows).toEqual([{ outcome: "discarded" }]);
}, 10000);

it("uses chronological slot IDs and FIFO regardless of message order, accepting the documented matching cost", async () => {
  await pool.query("INSERT INTO scheduling.diagnostic_resources VALUES ('offer-test-second-resource',$1,$2)", [scope.hospitalId, scope.testTypeId]);
  for (const id of ["offer-test-b", "offer-test-a"]) await pool.query(`INSERT INTO scheduling.slots SELECT $1,CASE WHEN $1='offer-test-b' THEN 'offer-test-second-resource' ELSE resource_id END,hospital_id,test_type_id,
    starts_at-interval '1 hour',ends_at-interval '1 hour' FROM scheduling.slots WHERE id='offer-test-h'`, [id]);
  const holds: string[] = [];
  for (const slot of ["offer-test-h", "offer-test-a", "offer-test-b"]) {
    const result = await api.createHold("patient-carlos", slot, `offer-test-${slot}`);
    if (!("id" in result.body)) throw new Error("Expected hold");
    holds.push(result.body.id);
  }
  expect((await api.joinWaitingList("patient-ana", scope, "offer-test-ana")).status).toBe(201);
  const bruno = await api.joinWaitingList("patient-bruno", scope, "offer-test-bruno");
  if (!("id" in bruno.body)) throw new Error("Expected entry");
  await pool.query("INSERT INTO scheduling.waiting_list_slot_exclusions VALUES ($1,'offer-test-b')", [bruno.body.id]);
  for (const id of holds) await api.cancelReservation("patient-carlos", id);
  const publications = (await pool.query(`SELECT p.* FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id
    WHERE e.type='SlotReleased' AND e.payload->>'hospitalId'=$1 ORDER BY p.created_at DESC,p.id DESC`, [scope.hospitalId])).rows;
  for (const row of publications) await messages.allocate({ version: 1, publicationId: row.id, eventId: row.event_id, consumer: "allocation", cycle: 0, attempt: 0 });
  expect((await pool.query("SELECT slot_id,patient_id FROM scheduling.reservations WHERE slot_id LIKE 'offer-test-%' AND state='OFFERED' ORDER BY slot_id")).rows)
    .toEqual([{ slot_id: "offer-test-a", patient_id: "patient-ana" }, { slot_id: "offer-test-h", patient_id: "patient-bruno" }]);
});

it.each(["excluded", "reoccupied", "started"])("reviews beyond an %s origin without modifying a substitute reservation", async (origin) => {
  await pool.query(`INSERT INTO scheduling.slots SELECT 'offer-test-other',resource_id,hospital_id,test_type_id,
    starts_at+interval '1 hour',ends_at+interval '1 hour' FROM scheduling.slots WHERE id='offer-test-h'`);
  const first = await api.createHold("patient-carlos", "offer-test-h", "offer-test-first");
  const second = await api.createHold("patient-carlos", "offer-test-other", "offer-test-second");
  if (!("id" in first.body) || !("id" in second.body)) throw new Error("Expected holds");
  const joined = await api.joinWaitingList("patient-ana", scope, "offer-test-ana");
  if (!("id" in joined.body)) throw new Error("Expected entry");
  await pool.query("INSERT INTO scheduling.waiting_list_slot_exclusions VALUES ($1,'offer-test-h')", [joined.body.id]);
  await api.cancelReservation("patient-carlos", first.body.id);
  const old = await delivery();
  let substitute: string | undefined;
  if (origin === "reoccupied") {
    const replacement = await api.createHold("patient-carlos", "offer-test-h", "offer-test-replacement");
    expect(replacement.status).toBe(201);
    if ("id" in replacement.body) substitute = replacement.body.id;
  }
  if (origin === "started") await pool.query("UPDATE scheduling.slots SET starts_at=starts_at-interval '2 days',ends_at=ends_at-interval '2 days' WHERE id='offer-test-h'");
  await api.cancelReservation("patient-carlos", second.body.id);
  await messages.allocate(old);
  expect((await api.getWaitingListEntry("patient-ana", joined.body.id)).body).toMatchObject({ state: "OFFERED", offer: { slotId: "offer-test-other" } });
  if (substitute) expect((await api.getReservation("patient-carlos", substitute)).body).toMatchObject({ id: substitute, state: "HELD" });
});

it("rolls back allocation, entry state and consumer result when its following outbox cannot be saved", async () => {
  const held = await api.createHold("patient-carlos", "offer-test-h", "offer-test-carlos");
  if (!("id" in held.body)) throw new Error("Expected hold");
  await api.joinWaitingList("patient-ana", scope, "offer-test-ana");
  await api.cancelReservation("patient-carlos", held.body.id);
  const envelope = await delivery();
  await pool.query("CREATE ROLE offer_test_consumer NOLOGIN");
  const url = new URL(databaseUrl!); url.searchParams.set("options", "-c role=offer_test_consumer");
  const restricted = createDatabasePool(url.toString());
  try {
    await pool.query("GRANT USAGE ON SCHEMA scheduling TO offer_test_consumer");
    await pool.query("GRANT SELECT,UPDATE,INSERT ON ALL TABLES IN SCHEMA scheduling TO offer_test_consumer");
    await pool.query("REVOKE INSERT ON scheduling.outbox_publications FROM offer_test_consumer");
    await expect(messageUseCases(postgresScheduling(restricted), async () => {}).allocate(envelope)).rejects.toMatchObject({ code: "42501" });
    expect((await pool.query("SELECT state FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [scope.hospitalId])).rows).toEqual([{ state: "WAITING" }]);
    expect((await pool.query("SELECT * FROM scheduling.consumer_results WHERE event_id=$1", [envelope.eventId])).rows).toEqual([]);
    expect((await pool.query("SELECT * FROM scheduling.reservations WHERE slot_id='offer-test-h' AND state='OFFERED'")).rows).toEqual([]);
    await messages.allocate(envelope);
    expect((await pool.query("SELECT state FROM scheduling.waiting_list_entries WHERE hospital_id=$1", [scope.hospitalId])).rows).toEqual([{ state: "OFFERED" }]);
  } finally {
    await restricted.end();
    await pool.query("REVOKE ALL ON ALL TABLES IN SCHEMA scheduling FROM offer_test_consumer");
    await pool.query("REVOKE USAGE ON SCHEMA scheduling FROM offer_test_consumer");
    await pool.query("DROP ROLE offer_test_consumer");
  }
});

it("enforces one offered reservation per entry in PostgreSQL even for different slots", async () => {
  const { offer, entryId } = await offerToAna();
  await pool.query(`INSERT INTO scheduling.slots SELECT 'offer-test-other',resource_id,hospital_id,test_type_id,
    starts_at+interval '1 hour',ends_at+interval '1 hour' FROM scheduling.slots WHERE id='offer-test-h'`);
  await expect(pool.query(`INSERT INTO scheduling.reservations(id,slot_id,patient_id,waiting_list_entry_id,state,created_at,expires_at)
    VALUES ($1,'offer-test-other','patient-ana',$2,'OFFERED',$3,$4)`, [randomUUID(), entryId, offer.created_at, offer.expires_at]))
    .rejects.toMatchObject({ code: "23505", constraint: "reservations_one_offer_entry_idx" });
});

it("coordinates duplicate broker deliveries in two consumer processes before the protected scope", async () => {
  const envelope = await allocationReady();
  const connection = await connect(process.env.TEST_RABBITMQ_URL!);
  const channel = await connection.createConfirmChannel(); await assertTopology(channel);
  const a = await consumerProcess("offer-test-consumer-A");
  const b = await consumerProcess("offer-test-consumer-B");
  const barrier = await holdScope(pool, scope.hospitalId, scope.testTypeId);
  try {
    await publishConfirmed(channel, "appointments.work", "allocation", envelope);
    await publishConfirmed(channel, "appointments.work", "allocation", envelope);
    const waiting = await awaitBlocked(pool, ["offer-test-consumer-A", "offer-test-consumer-B"], barrier.pid);
    expect(new Set(waiting.map((row) => row.pid)).size).toBe(2);
    await barrier.release();
    await eventually(async () => a.phases.filter((phase) => phase === "committed").length + b.phases.filter((phase) => phase === "committed").length, (count) => count === 2, 8000);
    expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.reservations WHERE slot_id='offer-test-h' AND state='OFFERED'")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [envelope.eventId])).rows).toEqual([{ outcome: "succeeded" }]);
  } finally { await barrier.release(); await a.stop(); await b.stop(); await channel.close(); await connection.close(); }
}, 15000);

it("redelivers after a consumer process dies between SQL commit and ack without a second offer", async () => {
  const envelope = await allocationReady();
  const connection = await connect(process.env.TEST_RABBITMQ_URL!);
  const channel = await connection.createConfirmChannel(); await assertTopology(channel);
  const a = await consumerProcess("offer-test-crash-A", true);
  let b: Awaited<ReturnType<typeof consumerProcess>> | undefined;
  try {
    await publishConfirmed(channel, "appointments.work", "allocation", envelope);
    await eventually(async () => a.phases.includes("committed"), Boolean, 8000);
    expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [envelope.eventId])).rows).toEqual([{ outcome: "succeeded" }]);
    const exited = once(a.child, "exit"); a.child.kill("SIGKILL"); await exited;
    b = await consumerProcess("offer-test-crash-B");
    await eventually(async () => b!.phases.includes("committed"), Boolean, 8000);
    expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.reservations WHERE slot_id='offer-test-h' AND state='OFFERED'")).rows[0].n).toBe(1);
    expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.events WHERE type='OfferCreated' AND payload->>'hospitalId'=$1", [scope.hospitalId])).rows[0].n).toBe(1);
  } finally { await a.stop(); await b?.stop(); await channel.close(); await connection.close(); }
}, 15000);

it("can repeat a real output written before a rolled-back consumer completion", async () => {
  const { notification } = await offerToAna();
  const lines: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { lines.push(chunk.toString()); callback(); } });
  const writer = structuredNotificationWriter(output);
  await messageUseCases(scheduling, async (notice) => {
    await writer(notice);
    throw new Error("Synthetic failure after output before result");
  }).notify(notification);
  expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [notification.eventId])).rows).toEqual([{ outcome: null }]);
  const next = (await pool.query("SELECT * FROM scheduling.outbox_publications WHERE event_id=$1 AND attempt=1", [notification.eventId])).rows[0];
  await eventually(async () => (await postgresOutbox(pool).ready()).some((row) => row.publicationId === next.id), Boolean, 7000);
  await messageUseCases(scheduling, writer).notify({ ...notification, attempt: 1, publicationId: next.id });
  expect(lines).toHaveLength(2);
  expect(lines[0]).toBe(lines[1]);
  expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [notification.eventId])).rows).toEqual([{ outcome: "succeeded" }]);
}, 10000);

it("omits an expired notice and leaves its persisted reservation untouched", async () => {
  const { offer, notification } = await offerToAna(100);
  await eventually(async () => (await pool.query("SELECT clock_timestamp() >= expires_at AS expired FROM scheduling.reservations WHERE id=$1", [offer.id])).rows[0].expired, Boolean);
  const lines: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { lines.push(chunk.toString()); callback(); } });
  await messageUseCases(scheduling, structuredNotificationWriter(output)).notify(notification);
  expect(lines).toEqual([]);
  expect((await pool.query("SELECT state FROM scheduling.reservations WHERE id=$1", [offer.id])).rows[0].state).toBe("OFFERED");
  expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [notification.eventId])).rows[0].outcome).toBe("discarded");
});

it("allows a real log after the checked deadline and still refuses late HTTP acceptance", async () => {
  const { offer, notification } = await offerToAna(250);
  let checked = false;
  let release: (() => void) | undefined;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const lines: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) { lines.push(chunk.toString()); callback(); } });
  const writer = structuredNotificationWriter(output);
  const pending = messageUseCases(scheduling, async (notice) => { checked = true; await paused; await writer(notice); }).notify(notification);
  try {
    await eventually(async () => checked, Boolean);
    await eventually(async () => (await pool.query("SELECT clock_timestamp() >= expires_at AS expired FROM scheduling.reservations WHERE id=$1", [offer.id])).rows[0].expired, Boolean);
    expect(lines).toEqual([]);
    release!(); await pending;
    expect(JSON.parse(lines[0])).toMatchObject({ reservationId: offer.id, expiresAt: offer.expires_at.toISOString() });
    expect((await api.confirmReservation("patient-ana", offer.id)).status).toBe(409);
  } finally { release!(); await pending; }
});

it("retains a publication when its relay dies after broker confirmation and republishes without a second effect", async () => {
  const envelope = await allocationReady();
  const consumer = await consumerProcess("offer-test-relay-window-consumer");
  async function relay(pause: boolean) {
    const phases: { phase: string; delivery?: Delivery }[] = [];
    let logs = "";
    const child = spawn(process.execPath, ["test/helpers/relay-process.ts"], { cwd: process.cwd(), env: {
      ...process.env, DATABASE_URL: databaseUrl, RABBITMQ_URL: process.env.TEST_RABBITMQ_URL,
      PUBLICATION_ID: envelope.publicationId, PAUSE_AFTER_CONFIRM: String(pause),
      OUTBOX_RETRY_DELAY_MS: "100",
    }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    child.on("message", (message: { phase: string; delivery?: Delivery }) => phases.push(message));
    child.stderr?.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
    await eventually(async () => {
      if (child.exitCode !== null && child.exitCode !== 0) throw new Error(logs);
      return phases.some((phase) => phase.phase === "accepted");
    }, Boolean, 8000);
    return { child, phases };
  }
  const a = await relay(true);
  try {
    const exited = once(a.child, "exit"); a.child.kill("SIGKILL"); await exited;
    expect((await pool.query("SELECT send_count,published_at FROM scheduling.outbox_publications WHERE id=$1", [envelope.publicationId])).rows[0])
      .toEqual({ send_count: 1, published_at: null });
    const readyAgain = await eventually(() => postgresOutbox(pool).ready(), (work) => work.some((item) => item.publicationId === envelope.publicationId), 2000);
    expect(readyAgain.find((work) => work.publicationId === envelope.publicationId)).toEqual(envelope);
    const b = await relay(false);
    if (b.child.exitCode === null) await once(b.child, "exit");
    expect(b.child.exitCode).toBe(0);
    expect(a.phases[0].delivery).toEqual(b.phases[0].delivery);
    await eventually(async () => consumer.phases.filter((phase) => phase === "committed").length, (count) => count === 2, 8000);
    expect((await postgresOutbox(pool).ready()).some((work) => work.publicationId === envelope.publicationId)).toBe(false);
    expect((await pool.query("SELECT send_count FROM scheduling.outbox_publications WHERE id=$1", [envelope.publicationId])).rows[0].send_count).toBe(2);
    expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.reservations WHERE slot_id='offer-test-h' AND state='OFFERED'")).rows[0].n).toBe(1);
  } finally {
    if (a.child.exitCode === null && a.child.signalCode === null) { const exited = once(a.child, "exit"); a.child.kill("SIGKILL"); await exited; }
    await consumer.stop();
  }
}, 15000);
