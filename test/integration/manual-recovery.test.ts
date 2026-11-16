import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../../src/scheduling/adapters/postgres/initialize.ts";
import { postgresScheduling } from "../../src/scheduling/adapters/postgres/scheduling.ts";
import { messageUseCases, type Delivery } from "../../src/scheduling/application/messages.ts";
import { recoverMessage } from "../../src/scheduling/application/recovery.ts";
import { connect, type ChannelModel, type ConfirmChannel } from "amqplib";
import { assertTopology, publishDelivery } from "../../src/scheduling/adapters/rabbitmq/messaging.ts";
import { recoverDlq } from "../../src/scheduling/adapters/rabbitmq/recovery.ts";
import { eventually, awaitBlocked, holdScope } from "../helpers/concurrency.ts";
import { postgresProxy } from "../helpers/postgres-proxy.ts";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { postgresOutbox } from "../../src/scheduling/adapters/postgres/outbox.ts";
import { relayReadyPublications } from "../../src/scheduling/application/outbox.ts";
import { amqpProxy } from "../helpers/amqp-proxy.ts";
import { connectToRabbitMq, closeRabbitMq } from "../../src/scheduling/adapters/rabbitmq/connection.ts";
import type { RecoveryResult } from "../../src/scheduling/application/recovery.ts";
import { readRecoveryPublication } from "../../src/scheduling/adapters/postgres/recovery.ts";
import { schedulingUseCases } from "../../src/scheduling/application/reservations.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const name = `appointment_recovery_${Date.now()}_${process.pid}`;
const target = new URL(databaseUrl); target.pathname = `/${name}`;
const pool = createDatabasePool(target.toString());
const store = postgresScheduling(pool);
let connection: ChannelModel;
let channel: ConfirmChannel;
const ownPublications = new Set<string>();
beforeAll(async () => {
  const admin = createDatabasePool(databaseUrl);
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  await initializeDatabase(pool);
  connection = await connect(process.env.TEST_RABBITMQ_URL!);
  channel = await connection.createConfirmChannel(); await assertTopology(channel);
});
afterAll(async () => {
  if (channel) for (const queue of ["appointments.allocation", "appointments.notifications", "appointments.allocation.dlq", "appointments.notifications.dlq"]) {
    const other = [];
    let message;
    while ((message = await channel.get(queue, { noAck: false }))) {
      if (ownPublications.has(String(message.properties.messageId))) channel.ack(message); else other.push(message);
    }
    for (const message of other) channel.nack(message, false, true);
  }
  await channel?.close(); await connection?.close(); await pool.end();
});

async function work(type = "UnsupportedEvent", sent = true): Promise<Delivery> {
  const delivery: Delivery = { version: 1, publicationId: randomUUID(), eventId: randomUUID(), consumer: "allocation", cycle: 0, attempt: 0 };
  ownPublications.add(delivery.publicationId);
  await pool.query(`INSERT INTO scheduling.events(id,type,version,occurred_at,payload)
    VALUES ($1,$2,1,clock_timestamp(),$3)`, [delivery.eventId, type, { hospitalId: "hospital-south", testTypeId: "mri" }]);
  await pool.query(`INSERT INTO scheduling.outbox_publications(id,event_id,consumer,cycle,attempt,available_at,created_at,published_at)
    VALUES ($1,$2,$3,0,0,clock_timestamp(),clock_timestamp(),CASE WHEN $4 THEN clock_timestamp() END)`, [delivery.publicationId, delivery.eventId, delivery.consumer, sent]);
  return delivery;
}
const operator = { operator: "synthetic-operator", reason: "Synthetic cause repaired; exact retained work selected" };

it("opens one new cycle from exact retained evidence without changing the event or its failed history", async () => {
  const delivery = await work();
  await messageUseCases(store, async () => {}).allocate(delivery);
  const dead = (await pool.query("SELECT id FROM scheduling.outbox_publications WHERE event_id=$1 AND destination='dead'", [delivery.eventId])).rows[0].id;
  const request = { delivery: { ...delivery, publicationId: dead, destination: "dead" as const }, source: "persisted" as const, ...operator };
  const result = await recoverMessage(store, request);
  expect(result).toMatchObject({ outcome: "recovered", cycle: 1 });
  expect(await recoverMessage(store, request)).toEqual(result);
  expect((await pool.query("SELECT state FROM scheduling.consumer_cycles WHERE event_id=$1 ORDER BY cycle", [delivery.eventId])).rows)
    .toEqual([{ state: "parked" }, { state: "active" }]);
  expect((await pool.query("SELECT cycle,attempt,outcome FROM scheduling.consumer_attempts WHERE event_id=$1 ORDER BY cycle", [delivery.eventId])).rows)
    .toEqual([{ cycle: 0, attempt: 0, outcome: "failed" }, { cycle: 1, attempt: 0, outcome: null }]);
  expect((await pool.query("SELECT * FROM scheduling.consumer_recoveries WHERE event_id=$1", [delivery.eventId])).rows).toHaveLength(1);
  expect((await pool.query("SELECT * FROM scheduling.outbox_publications WHERE event_id=$1 AND cycle=1", [delivery.eventId])).rows).toHaveLength(1);
});

it("refuses persisted recovery of never-sent work instead of replacing a live pending outbox publication", async () => {
  const delivery = await work("AllocationReviewRequested", false);
  await expect(recoverMessage(store, { delivery, source: "persisted", ...operator })).rejects.toThrow("transport evidence");
  expect((await pool.query("SELECT * FROM scheduling.consumer_recoveries WHERE event_id=$1", [delivery.eventId])).rows).toEqual([]);
});

async function parked() {
  const delivery = await work();
  await messageUseCases(store, async () => {}).allocate(delivery);
  const row = (await pool.query("SELECT id FROM scheduling.outbox_publications WHERE event_id=$1 AND destination='dead'", [delivery.eventId])).rows[0];
  const dead: Delivery = { ...delivery, publicationId: row.id, destination: "dead" };
  ownPublications.add(dead.publicationId);
  return dead;
}
const selection = (delivery: Delivery) => ({ consumer: delivery.consumer, publicationId: delivery.publicationId, scanLimit: 100, ...operator });

it("keeps the DLQ original through 22 real SQL failures and records recovery before acknowledging it", async () => {
  const dead = await parked();
  await publishDelivery(channel, dead);
  await pool.query(`CREATE FUNCTION scheduling.fail_manual_recovery() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Synthetic recovery persistence failure'; END $$`);
  await pool.query(`CREATE TRIGGER fail_manual_recovery BEFORE INSERT ON scheduling.consumer_recoveries FOR EACH ROW EXECUTE FUNCTION scheduling.fail_manual_recovery()`);
  try {
    for (let failure = 0; failure < 22; failure++) {
      await expect(recoverDlq(connection, selection(dead), (request) => recoverMessage(store, request))).rejects.toThrow("Synthetic recovery persistence failure");
      expect((await pool.query("SELECT current_cycle FROM scheduling.consumer_results WHERE event_id=$1", [dead.eventId])).rows[0].current_cycle).toBe(0);
      await eventually(async () => (await channel.checkQueue("appointments.allocation.dlq")).messageCount, (count) => count >= 1);
    }
  } finally {
    await pool.query("DROP TRIGGER fail_manual_recovery ON scheduling.consumer_recoveries");
    await pool.query("DROP FUNCTION scheduling.fail_manual_recovery()");
  }
  const recovered = await recoverDlq(connection, selection(dead), async (request) => {
    const result = await recoverMessage(store, request);
    expect((await pool.query("SELECT * FROM scheduling.consumer_recoveries WHERE event_id=$1", [dead.eventId])).rows).toHaveLength(1);
    expect((await pool.query("SELECT * FROM scheduling.outbox_publications WHERE id=$1", [result.publicationId])).rows).toHaveLength(1);
    return result;
  });
  expect(recovered).toMatchObject({ outcome: "recovered", cycle: 1 });
  ownPublications.add(recovered.publicationId!);
  process.stdout.write("Recovery DLQ survived 22 SQL failures before a single committed recovery and ack\n");
}, 15000);

it("recovers broker delivery-limit parking with no prior SQL result and preserves other DLQ deliveries", async () => {
  const delivery = await work("AllocationReviewRequested");
  const unrelated = await parked();
  await publishDelivery(channel, unrelated);
  await publishDelivery(channel, delivery);
  for (let failed = 0; failed <= 20; failed++) {
    const physical = await eventually(() => channel.get("appointments.allocation", { noAck: false }), Boolean, 5000);
    if (!physical) throw new Error("Expected physical work");
    expect(physical.properties.messageId).toBe(delivery.publicationId);
    channel.reject(physical, true);
  }
  await eventually(async () => (await channel.checkQueue("appointments.allocation.dlq")).messageCount, (count) => count >= 2, 10000);
  expect((await pool.query("SELECT * FROM scheduling.consumer_results WHERE event_id=$1", [delivery.eventId])).rows).toEqual([]);
  const result = await recoverDlq(connection, selection(delivery), (request) => recoverMessage(store, request));
  expect(result).toMatchObject({ outcome: "recovered", cycle: 1 });
  expect((await pool.query("SELECT source FROM scheduling.consumer_recoveries WHERE event_id=$1", [delivery.eventId])).rows).toEqual([{ source: "broker_dlq" }]);
  const retained = await eventually(() => channel.get("appointments.allocation.dlq", { noAck: false }), Boolean);
  if (!retained) throw new Error("Unselected DLQ work disappeared");
  expect(retained.properties.messageId).toBe(unrelated.publicationId); channel.ack(retained);
  ownPublications.add(result.publicationId!);
}, 20000);

it("resolves an uncertain recovery commit from retained evidence without opening another cycle", async () => {
  const dead = await parked(); await publishDelivery(channel, dead);
  const proxy = await postgresProxy(target.toString());
  const uncertain = createDatabasePool(proxy.url); uncertain.on("error", () => {});
  try {
    proxy.dropNextCommit();
    await expect(recoverDlq(connection, selection(dead), (request) => recoverMessage(postgresScheduling(uncertain), request))).rejects.toThrow("temporarily unavailable");
    const history = (await pool.query("SELECT * FROM scheduling.consumer_recoveries WHERE event_id=$1", [dead.eventId])).rows;
    expect(history).toHaveLength(1);
    const result = await recoverDlq(connection, selection(dead), (request) => recoverMessage(store, request));
    expect(result).toMatchObject({ outcome: "recovered", cycle: 1, publicationId: history[0].next_publication_id });
    expect((await pool.query("SELECT * FROM scheduling.consumer_recoveries WHERE event_id=$1", [dead.eventId])).rows).toEqual(history);
    ownPublications.add(result.publicationId!);
  } finally { await uncertain.end(); await proxy.close(); }
});

async function stop(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill(signal);
  const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
  try { await exited; } finally { clearTimeout(timer); }
}

it("survives SIGKILL after recovery commit before ack and recognizes physical copies as the same recovery", async () => {
  const dead = await parked();
  await publishDelivery(channel, dead); await publishDelivery(channel, dead);
  const phases: { phase: string; result?: RecoveryResult }[] = [];
  let logs = "";
  const child = spawn(process.execPath, ["test/helpers/recovery-process.ts"], { env: {
    ...process.env, DATABASE_URL: target.toString(), RABBITMQ_URL: process.env.TEST_RABBITMQ_URL,
    PUBLICATION_ID: dead.publicationId, PAUSE_AFTER_COMMIT: "true",
  }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.on("message", (value: { phase: string; result?: RecoveryResult }) => phases.push(value));
  child.stderr?.on("data", (data: Buffer) => { logs += data.toString(); });
  try {
    await eventually(async () => { if (child.exitCode !== null) throw new Error(logs); return phases.find((row) => row.phase === "committed"); }, Boolean, 5000);
    const history = (await pool.query("SELECT * FROM scheduling.consumer_recoveries WHERE event_id=$1", [dead.eventId])).rows;
    expect(history).toHaveLength(1);
    await stop(child, "SIGKILL");
    for (let copy = 0; copy < 2; copy++) {
      await eventually(async () => (await channel.checkQueue("appointments.allocation.dlq")).messageCount, (count) => count >= 2 - copy);
      const result = await recoverDlq(connection, selection(dead), (request) => recoverMessage(store, request));
      expect(result).toEqual(phases.find((row) => row.phase === "committed")!.result);
      ownPublications.add(result.publicationId!);
    }
    expect((await pool.query("SELECT * FROM scheduling.consumer_recoveries WHERE event_id=$1", [dead.eventId])).rows).toEqual(history);
  } finally { await stop(child); }
}, 15000);

function recoveryCli(dead: Delivery, applicationName: string) {
  const database = new URL(target); database.searchParams.set("application_name", applicationName);
  let logs = "";
  const child = spawn(process.execPath, ["src/bootstrap/recover-message.ts", "--mode", "persisted", "--publication-id", dead.publicationId,
    "--operator", applicationName, "--reason", "Synthetic exact retained evidence selected after repair"], {
    env: { ...process.env, DATABASE_URL: database.toString() }, stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (data: Buffer) => { logs += data.toString(); }); child.stderr?.on("data", (data: Buffer) => { logs += data.toString(); });
  const exit = once(child, "exit");
  return { child, exit, logs: () => logs };
}

it("serializes two independent operator processes on the global event lock", async () => {
  const dead = await parked();
  const controller = await pool.connect(); await controller.query("BEGIN");
  const pid = (await controller.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
  await controller.query("SELECT event_id FROM scheduling.consumer_results WHERE event_id=$1 FOR UPDATE", [dead.eventId]);
  const a = recoveryCli(dead, "recovery-operator-A"); const b = recoveryCli(dead, "recovery-operator-B");
  try {
    await awaitBlocked(pool, ["recovery-operator-A", "recovery-operator-B"], pid);
    await controller.query("ROLLBACK");
    expect((await a.exit)[0], a.logs()).toBe(0); expect((await b.exit)[0], b.logs()).toBe(0);
    const first = JSON.parse(a.logs()); const second = JSON.parse(b.logs());
    expect(first).toEqual(second);
    expect(first).toMatchObject({ outcome: "recovered", cycle: 1 });
    ownPublications.add(first.publicationId);
    expect((await pool.query("SELECT * FROM scheduling.consumer_recoveries WHERE event_id=$1", [dead.eventId])).rows).toHaveLength(1);
    const original = (await pool.query("SELECT id FROM scheduling.outbox_publications WHERE event_id=$1 AND destination='work' AND cycle=0", [dead.eventId])).rows[0];
    await messageUseCases(store, async () => {}).allocate(await readRecoveryPublication(pool, original.id));
    expect((await pool.query("SELECT current_cycle FROM scheduling.consumer_results WHERE event_id=$1", [dead.eventId])).rows[0].current_cycle).toBe(1);
  } finally {
    await controller.query("ROLLBACK"); controller.release(); await stop(a.child); await stop(b.child);
  }
}, 15000);

it("retains the next outbox publication when RabbitMQ is unreachable and does not replay published history", async () => {
  const dead = await parked();
  const result = await recoverMessage(store, { delivery: dead, source: "persisted", ...operator });
  ownPublications.add(result.publicationId!);
  const publication = await readRecoveryPublication(pool, result.publicationId!);
  const adapter = postgresOutbox(pool);
  const outbox = { ...adapter, ready: async () => (await adapter.ready()).filter((row) => row.publicationId === publication.publicationId) };
  const proxy = await amqpProxy(process.env.TEST_RABBITMQ_URL!);
  const interrupted = await connectToRabbitMq(proxy.url); interrupted.on("error", () => {});
  const interruptedChannel = await interrupted.createConfirmChannel(); interruptedChannel.on("error", () => {});
  try {
    proxy.setAvailable(false);
    await expect(relayReadyPublications(outbox, (row) => publishDelivery(interruptedChannel, row, 100), 10)).rejects.toThrow();
    expect((await pool.query("SELECT published_at,last_error FROM scheduling.outbox_publications WHERE id=$1", [publication.publicationId])).rows[0])
      .toMatchObject({ published_at: null, last_error: expect.any(String) });
    await eventually(async () => (await outbox.ready()).length, (count) => count === 1);
    await relayReadyPublications(outbox, (row) => publishDelivery(channel, row), 10);
    const physical = await eventually(() => channel.get("appointments.allocation", { noAck: false }), Boolean);
    if (!physical) throw new Error("Recovered pending outbox did not reach RabbitMQ");
    expect(JSON.parse(physical.content.toString())).toEqual(publication); channel.ack(physical);
    expect(await outbox.ready()).toEqual([]);
    const before = (await pool.query("SELECT * FROM scheduling.outbox_publications WHERE id=$1", [publication.publicationId])).rows;
    await recoverMessage(store, { delivery: dead, source: "persisted", ...operator });
    expect((await pool.query("SELECT * FROM scheduling.outbox_publications WHERE id=$1", [publication.publicationId])).rows).toEqual(before);
  } finally { await closeRabbitMq(interrupted); await proxy.close(); }
});

it("uses the same durable retry budget in the recovered cycle and does not reset it with an old DLQ copy", async () => {
  const fixture = await reviewFixture("past");
  const recovered = await recoverMessage(store, { delivery: fixture.delivery, source: "persisted", ...operator });
  const next = await readRecoveryPublication(pool, recovered.publicationId!);
  await pool.query(`CREATE FUNCTION scheduling.fail_recovered_business() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Synthetic recovered allocation failure'; END $$`);
  await pool.query(`CREATE TRIGGER fail_recovered_business BEFORE UPDATE ON scheduling.consumer_results
    FOR EACH ROW WHEN (NEW.outcome IS NOT NULL) EXECUTE FUNCTION scheduling.fail_recovered_business()`);
  try { await messageUseCases(store, async () => {}).allocate(next); }
  finally {
    await pool.query("DROP TRIGGER fail_recovered_business ON scheduling.consumer_results");
    await pool.query("DROP FUNCTION scheduling.fail_recovered_business()");
  }
  const attempts = (await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=$1 AND cycle=1 ORDER BY attempt", [next.eventId])).rows;
  expect(attempts.map((row) => ({ attempt: row.attempt, outcome: row.outcome }))).toEqual([{ attempt: 0, outcome: "failed" }, { attempt: 1, outcome: null }]);
  expect(attempts[1].not_before.getTime() - attempts[0].completed_at.getTime()).toBe(5000);
  expect(await recoverMessage(store, { delivery: fixture.delivery, source: "persisted", ...operator })).toEqual(recovered);
  expect((await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=$1 AND cycle=1 ORDER BY attempt", [next.eventId])).rows).toEqual(attempts);
  const retry = (await pool.query("SELECT id FROM scheduling.outbox_publications WHERE event_id=$1 AND cycle=1 AND attempt=1", [next.eventId])).rows[0];
  await eventually(async () => (await pool.query("SELECT not_before<=clock_timestamp() AS ready FROM scheduling.consumer_attempts WHERE event_id=$1 AND cycle=1 AND attempt=1", [next.eventId])).rows[0].ready, Boolean, 7000);
  await messageUseCases(store, async () => {}).allocate(await readRecoveryPublication(pool, retry.id));
  expect((await pool.query("SELECT outcome,current_cycle FROM scheduling.consumer_results WHERE event_id=$1", [next.eventId])).rows[0]).toEqual({ outcome: "succeeded", current_cycle: 1 });
}, 10000);

it("waits for a live consumer in another process and recognizes its committed success before recovering", async () => {
  const fixture = await reviewFixture("past");
  const delivery = await work("SlotReleased");
  await pool.query("UPDATE scheduling.events SET payload=$2 WHERE id=$1", [delivery.eventId, { hospitalId: fixture.hospitalId, testTypeId: "mri", slotId: fixture.h1 }]);
  await store.transaction((tx) => tx.coordinateConsumption(delivery));
  const barrier = await holdScope(pool, fixture.hospitalId, "mri");
  const database = new URL(target); database.searchParams.set("application_name", "recovery-live-consumer");
  const phases: string[] = [];
  let logs = "";
  const consumer = spawn(process.execPath, ["test/helpers/consumer-process.ts"], { env: {
    ...process.env, DATABASE_URL: database.toString(), RABBITMQ_URL: process.env.TEST_RABBITMQ_URL,
  }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  consumer.on("message", (value: { phase: string }) => phases.push(value.phase));
  consumer.stderr?.on("data", (value: Buffer) => { logs += value.toString(); });
  let operatorProcess: ReturnType<typeof recoveryCli> | undefined;
  try {
    await eventually(async () => { if (consumer.exitCode !== null) throw new Error(logs); return phases.includes("ready"); }, Boolean, 5000);
    await publishDelivery(channel, delivery);
    await awaitBlocked(pool, ["recovery-live-consumer"], barrier.pid);
    operatorProcess = recoveryCli(delivery, "recovery-waits-consumer");
    await awaitBlocked(pool, ["recovery-live-consumer", "recovery-waits-consumer"], barrier.pid);
    await barrier.release();
    expect((await operatorProcess.exit)[0], operatorProcess.logs()).toBe(0);
    expect(JSON.parse(operatorProcess.logs())).toMatchObject({ outcome: "already_completed", cycle: 0, publicationId: null });
    expect((await pool.query("SELECT outcome,current_cycle FROM scheduling.consumer_results WHERE event_id=$1", [delivery.eventId])).rows[0])
      .toEqual({ outcome: "succeeded", current_cycle: 0 });
    expect((await pool.query("SELECT * FROM scheduling.reservations WHERE waiting_list_entry_id=$1", [fixture.entryId])).rows).toHaveLength(1);
  } finally { await barrier.release(); if (operatorProcess) await stop(operatorProcess.child); await stop(consumer); }
}, 15000);

async function reviewFixture(original: "past" | "occupied") {
  const hospitalId = `recovery-${randomUUID()}`;
  const resourceId = `${hospitalId}-resource`;
  const h1 = `${hospitalId}-h1`; const h2 = `${hospitalId}-h2`;
  await pool.query("INSERT INTO scheduling.hospitals VALUES ($1)", [hospitalId]);
  await pool.query("INSERT INTO scheduling.waiting_list_scopes VALUES ($1,'mri')", [hospitalId]);
  await pool.query("INSERT INTO scheduling.diagnostic_resources VALUES ($1,$2,'mri')", [resourceId, hospitalId]);
  await pool.query(`INSERT INTO scheduling.slots VALUES ($1,$3,$4,'mri',date_trunc('milliseconds',clock_timestamp())+($5*interval '1 hour'),date_trunc('milliseconds',clock_timestamp())+($5*interval '1 hour')+interval '30 minutes'),
    ($2,$3,$4,'mri',date_trunc('milliseconds',clock_timestamp())+interval '2 days',date_trunc('milliseconds',clock_timestamp())+interval '2 days 30 minutes')`,
  [h1, h2, resourceId, hospitalId, original === "past" ? -1 : 24]);
  if (original === "occupied") await pool.query(`INSERT INTO scheduling.reservations(id,slot_id,patient_id,state,created_at,expires_at)
    VALUES ($1,$2,'patient-carlos','CONFIRMED',date_trunc('milliseconds',clock_timestamp())-interval '1 minute',date_trunc('milliseconds',clock_timestamp())+interval '10 minutes')`, [randomUUID(), h1]);
  const entryId = randomUUID();
  await pool.query(`INSERT INTO scheduling.waiting_list_entries(id,patient_id,hospital_id,test_type_id,admission_order,state,created_at)
    VALUES ($1,'patient-ana',$2,'mri',1,'WAITING',date_trunc('milliseconds',clock_timestamp()))`, [entryId, hospitalId]);
  const delivery = await work("SlotReleased");
  await pool.query("UPDATE scheduling.events SET payload=$2 WHERE id=$1", [delivery.eventId, { hospitalId, testTypeId: "mri", slotId: h1 }]);
  await store.transaction(async (tx) => {
    await tx.coordinateConsumption(delivery);
    await tx.failConsumption(delivery, "Synthetic repaired permanent failure", true, { kind: "park", reason: "permanent" }, await tx.currentTime());
  });
  const dead = (await pool.query("SELECT id FROM scheduling.outbox_publications WHERE event_id=$1 AND destination='dead'", [delivery.eventId])).rows[0];
  return { delivery: { ...delivery, publicationId: dead.id, destination: "dead" as const }, hospitalId, h1, h2, entryId };
}

it.each(["past", "occupied"] as const)("recovers an old review whose source slot is %s and offers another current slot", async (original) => {
  const fixture = await reviewFixture(original);
  const eventBefore = (await pool.query("SELECT * FROM scheduling.events WHERE id=$1", [fixture.delivery.eventId])).rows;
  const recovered = await recoverMessage(store, { delivery: fixture.delivery, source: "persisted", ...operator });
  const next = await readRecoveryPublication(pool, recovered.publicationId!);
  await messageUseCases(store, async () => {}).allocate(next);
  const entry = await schedulingUseCases(store).getWaitingListEntry("patient-ana", fixture.entryId);
  expect(entry.body).toMatchObject({ state: "OFFERED", offer: { slotId: fixture.h2 } });
  expect((await pool.query("SELECT * FROM scheduling.events WHERE id=$1", [fixture.delivery.eventId])).rows).toEqual(eventBefore);
  const offers = (await pool.query("SELECT id FROM scheduling.reservations WHERE waiting_list_entry_id=$1", [fixture.entryId])).rows;
  await recoverMessage(store, { delivery: fixture.delivery, source: "persisted", ...operator });
  await messageUseCases(store, async () => {}).allocate(next);
  expect((await pool.query("SELECT id FROM scheduling.reservations WHERE waiting_list_entry_id=$1", [fixture.entryId])).rows).toEqual(offers);
});

it("discards a recovered expired notification without extending its deadline and never repeats completed work", async () => {
  const fixture = await reviewFixture("past");
  const recovered = await recoverMessage(store, { delivery: fixture.delivery, source: "persisted", ...operator });
  await messageUseCases(store, async () => {}).allocate(await readRecoveryPublication(pool, recovered.publicationId!));
  const offer = (await pool.query("SELECT * FROM scheduling.reservations WHERE waiting_list_entry_id=$1", [fixture.entryId])).rows[0];
  await pool.query("UPDATE scheduling.reservations SET created_at=date_trunc('milliseconds',clock_timestamp())-interval '1 hour',expires_at=date_trunc('milliseconds',clock_timestamp())-interval '1 second' WHERE id=$1", [offer.id]);
  const notificationId = (await pool.query(`SELECT p.id FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id
    WHERE e.payload->>'reservationId'=$1 AND p.consumer='notification'`, [offer.id])).rows[0].id;
  await pool.query("UPDATE scheduling.outbox_publications SET published_at=clock_timestamp() WHERE id=$1", [notificationId]);
  const notification = await readRecoveryPublication(pool, notificationId);
  const deadline = (await pool.query("SELECT expires_at FROM scheduling.reservations WHERE id=$1", [offer.id])).rows[0].expires_at;
  const nextNotification = await recoverMessage(store, { delivery: notification, source: "persisted", ...operator });
  const written: unknown[] = [];
  await messageUseCases(store, async (notice) => { written.push(notice); }).notify(await readRecoveryPublication(pool, nextNotification.publicationId!));
  expect(written).toEqual([]);
  expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [notification.eventId])).rows[0].outcome).toBe("discarded");
  expect((await pool.query("SELECT expires_at FROM scheduling.reservations WHERE id=$1", [offer.id])).rows[0].expires_at).toEqual(deadline);

  const completed = await work("AllocationReviewRequested"); await messageUseCases(store, async () => {}).allocate(completed);
  const terminal = await recoverMessage(store, { delivery: completed, source: "broker_dlq", ...operator });
  expect(terminal).toEqual({ outcome: "already_completed", cycle: 0, publicationId: null });
  expect((await pool.query("SELECT * FROM scheduling.consumer_cycles WHERE event_id=$1", [completed.eventId])).rows).toHaveLength(1);
});

it("recognizes physical parking without a SQL failure and ignores an older attempt of the same cycle", async () => {
  const physical = await work("AllocationReviewRequested");
  expect(await recoverMessage(store, { delivery: physical, source: "broker_dlq", ...operator }))
    .toMatchObject({ outcome: "recovered", cycle: 1 });
  expect((await pool.query("SELECT source FROM scheduling.consumer_recoveries WHERE event_id=$1", [physical.eventId])).rows)
    .toEqual([{ source: "broker_dlq" }]);
  expect((await pool.query("SELECT state,park_reason FROM scheduling.consumer_cycles WHERE event_id=$1 AND cycle=0", [physical.eventId])).rows)
    .toEqual([{ state: "parked", park_reason: "physical" }]);

  const older = await work();
  await store.transaction(async (tx) => {
    await tx.coordinateConsumption(older);
    const time = await tx.currentTime();
    await tx.failConsumption(older, "Synthetic transient failure", false, { kind: "retry", attempt: 1, notBefore: time + 5000 }, time);
  });
  expect(await recoverMessage(store, { delivery: older, source: "broker_dlq", ...operator }))
    .toEqual({ outcome: "superseded", cycle: 0, publicationId: null });
  expect((await pool.query("SELECT current_cycle FROM scheduling.consumer_results WHERE event_id=$1", [older.eventId])).rows[0].current_cycle).toBe(0);
  expect((await pool.query("SELECT attempt,outcome FROM scheduling.consumer_attempts WHERE event_id=$1 ORDER BY attempt", [older.eventId])).rows)
    .toEqual([{ attempt: 0, outcome: "failed" }, { attempt: 1, outcome: null }]);
});
