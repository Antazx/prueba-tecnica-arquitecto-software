import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../../src/scheduling/adapters/postgres/initialize.ts";
import { postgresScheduling } from "../../src/scheduling/adapters/postgres/scheduling.ts";
import { messageUseCases, type Delivery } from "../../src/scheduling/application/messages.ts";
import { postgresOutbox } from "../../src/scheduling/adapters/postgres/outbox.ts";
import { connect, type ChannelModel, type ConfirmChannel } from "amqplib";
import { assertTopology, publishDelivery } from "../../src/scheduling/adapters/rabbitmq/messaging.ts";
import { relayReadyPublications } from "../../src/scheduling/application/outbox.ts";
import { eventually, holdScope, awaitBlocked } from "../helpers/concurrency.ts";
import { postgresProxy } from "../helpers/postgres-proxy.ts";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { schedulingUseCases } from "../../src/scheduling/application/reservations.ts";
import { Writable } from "node:stream";
import { structuredNotificationWriter } from "../../src/scheduling/adapters/notification.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL is required");
const name = `appointment_retries_${Date.now()}_${process.pid}`;
const target = new URL(databaseUrl); target.pathname = `/${name}`;
const pool = createDatabasePool(target.toString());
const store = postgresScheduling(pool);
const ownPublications = new Set<string>();
let connection: ChannelModel;
let channel: ConfirmChannel;
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

async function work(type = "AllocationReviewRequested"): Promise<Delivery> {
  const delivery: Delivery = { version: 1, publicationId: randomUUID(), eventId: randomUUID(), consumer: "allocation", cycle: 0, attempt: 0 };
  ownPublications.add(delivery.publicationId);
  await pool.query(`INSERT INTO scheduling.events(id,type,version,occurred_at,payload)
    VALUES ($1,$2,1,clock_timestamp(),$3)`, [delivery.eventId, type, { hospitalId: "hospital-south", testTypeId: "mri" }]);
  await pool.query(`INSERT INTO scheduling.outbox_publications(id,event_id,consumer,cycle,attempt,available_at,created_at)
    VALUES ($1,$2,$3,0,0,clock_timestamp(),clock_timestamp())`, [delivery.publicationId, delivery.eventId, delivery.consumer]);
  return delivery;
}

it("rolls back failed business and commits a single delayed retry before acknowledging duplicate deliveries", async () => {
  const delivery = await work();
  await pool.query(`CREATE FUNCTION scheduling.fail_retry_business() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'Synthetic allocation failure'; END $$`);
  await pool.query(`CREATE TRIGGER fail_retry_business BEFORE UPDATE ON scheduling.consumer_results
    FOR EACH ROW WHEN (NEW.outcome IS NOT NULL) EXECUTE FUNCTION scheduling.fail_retry_business()`);
  const messages = messageUseCases(store, async () => {});
  try {
    await expect(messages.allocate(delivery)).resolves.toBeUndefined();
    const failed = (await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=$1 ORDER BY attempt", [delivery.eventId])).rows;
    expect(failed).toHaveLength(2);
    expect(failed[0]).toMatchObject({ attempt: 0, outcome: "failed", last_error: "Synthetic allocation failure" });
    expect(failed[1]).toMatchObject({ attempt: 1, outcome: null });
    expect(failed[1].not_before.getTime() - failed[0].completed_at.getTime()).toBe(5000);
    expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [delivery.eventId])).rows[0].outcome).toBeNull();
    const next = (await pool.query("SELECT * FROM scheduling.outbox_publications WHERE event_id=$1 AND attempt=1", [delivery.eventId])).rows[0];
    expect(next.available_at).toEqual(failed[1].not_before);
    expect((await postgresOutbox(pool).ready()).some((row) => row.publicationId === next.id)).toBe(false);
    await expect(messages.allocate({ ...delivery, publicationId: next.id, attempt: 1 })).rejects.toThrow("durable execution date");
    await messages.allocate(delivery);
    const copy = { ...delivery, publicationId: randomUUID() };
    await pool.query(`INSERT INTO scheduling.outbox_publications(id,event_id,consumer,cycle,attempt,available_at,created_at)
      VALUES ($1,$2,'allocation',0,0,clock_timestamp(),clock_timestamp())`, [copy.publicationId, copy.eventId]);
    await messages.allocate(copy);
    expect((await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=$1", [delivery.eventId])).rows).toHaveLength(2);
    expect((await pool.query("SELECT * FROM scheduling.outbox_publications WHERE event_id=$1 AND attempt=1", [delivery.eventId])).rows).toHaveLength(1);
  } finally {
    await pool.query("DROP TRIGGER fail_retry_business ON scheduling.consumer_results");
    await pool.query("DROP FUNCTION scheduling.fail_retry_business()");
  }
});

async function consumerProcess(environment: Record<string, string> = {}, database = target.toString()) {
  const phases: { phase: string; delivery?: Delivery }[] = [];
  let logs = "";
  const child = spawn(process.execPath, ["test/helpers/retry-consumer-process.ts"], { cwd: process.cwd(), env: {
    ...process.env, DATABASE_URL: database, RABBITMQ_URL: process.env.TEST_RABBITMQ_URL, ...environment,
  }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
  child.on("message", (value: { phase: string; delivery?: Delivery }) => phases.push(value));
  child.stdout?.on("data", (data: Buffer) => { logs += data.toString(); });
  child.stderr?.on("data", (data: Buffer) => { logs += data.toString(); });
  const stop = async (signal: NodeJS.Signals = "SIGTERM") => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill(signal);
    const timeout = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await exited; } finally { clearTimeout(timeout); }
  };
  try {
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error(logs);
      return phases.some((phase) => phase.phase === "ready");
    }, Boolean, 5000);
    return { child, phases, logs: () => logs, stop };
  } catch (error) { await stop(); throw error; }
}

it("retains a committed failure across SIGKILL before ack and an uncertain recovery commit", async () => {
  const delivery = await work("UnsupportedEvent");
  let child = await consumerProcess({ PAUSE_AFTER_COMMIT: "true" });
  try {
    await publishDelivery(channel, delivery);
    await eventually(async () => child.phases.some((phase) => phase.phase === "committed" && phase.delivery?.eventId === delivery.eventId), Boolean, 5000);
    const before = (await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=$1", [delivery.eventId])).rows;
    const publications = (await pool.query("SELECT * FROM scheduling.outbox_publications WHERE event_id=$1", [delivery.eventId])).rows;
    for (const row of publications) ownPublications.add(row.id);
    await child.stop("SIGKILL");
    child = await consumerProcess();
    await eventually(async () => child.phases.some((phase) => phase.phase === "committed" && phase.delivery?.eventId === delivery.eventId), Boolean, 5000);
    expect((await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=$1", [delivery.eventId])).rows).toEqual(before);
    expect((await pool.query("SELECT * FROM scheduling.outbox_publications WHERE event_id=$1", [delivery.eventId])).rows).toEqual(publications);
  } finally { await child.stop(); }

  const uncertain = await work("UnsupportedEvent");
  const proxy = await postgresProxy(target.toString());
  const uncertainPool = createDatabasePool(proxy.url);
  uncertainPool.on("error", () => {});
  try {
    proxy.dropNextCommit();
    await expect(messageUseCases(postgresScheduling(uncertainPool), async () => {}).allocate(uncertain)).rejects.toThrow("temporarily unavailable");
    await messageUseCases(store, async () => {}).allocate(uncertain);
    expect((await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=$1", [uncertain.eventId])).rows).toHaveLength(1);
    expect((await pool.query("SELECT * FROM scheduling.outbox_publications WHERE event_id=$1 AND destination='dead'", [uncertain.eventId])).rows).toHaveLength(1);
  } finally { await uncertainPool.end(); await proxy.close(); }
}, 15000);

it("parks a permanent failure once and retains SQL work while its real DLQ route is inaccessible", async () => {
  const delivery = await work("UnsupportedEvent");
  const messages = messageUseCases(store, async () => {});
  await messages.allocate(delivery);
  const parked = (await pool.query("SELECT * FROM scheduling.consumer_cycles WHERE event_id=$1", [delivery.eventId])).rows[0];
  expect(parked).toMatchObject({ state: "parked", park_reason: "permanent" });
  expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [delivery.eventId])).rows[0].outcome).toBeNull();
  const pending = (await pool.query("SELECT * FROM scheduling.outbox_publications WHERE event_id=$1 AND destination='dead'", [delivery.eventId])).rows[0];
  const adapter = postgresOutbox(pool);
  const outbox = { ...adapter, ready: async () => (await adapter.ready()).filter((row) => row.publicationId === pending.id) };
  await channel.unbindQueue("appointments.allocation.dlq", "appointments.dead", "allocation.dead");
  try {
    await relayReadyPublications(outbox, (row) => publishDelivery(channel, row), 20);
    expect((await pool.query("SELECT published_at,last_error FROM scheduling.outbox_publications WHERE id=$1", [pending.id])).rows[0])
      .toEqual({ published_at: null, last_error: "Publication was unroutable" });
    await messages.allocate(delivery);
    expect((await pool.query("SELECT * FROM scheduling.outbox_publications WHERE event_id=$1 AND destination='dead'", [delivery.eventId])).rows).toHaveLength(1);
  } finally { await channel.bindQueue("appointments.allocation.dlq", "appointments.dead", "allocation.dead"); }
  await eventually(async () => (await outbox.ready()).length, (n) => n === 1);
  await relayReadyPublications(outbox, (row) => publishDelivery(channel, row), 20);
  const dead = await eventually(() => channel.get("appointments.allocation.dlq", { noAck: false }), Boolean, 5000);
  if (!dead) throw new Error("Expected parked publication");
  expect(JSON.parse(dead.content.toString())).toMatchObject({ ...delivery, publicationId: pending.id, destination: "dead" });
  channel.ack(dead);
});

it("resolves an uncertain successful commit from retained evidence without recording a conflicting failure", async () => {
  const delivery = await work();
  const proxy = await postgresProxy(target.toString());
  const uncertainPool = createDatabasePool(proxy.url);
  uncertainPool.on("error", () => {});
  try {
    proxy.dropNextCommit();
    await messageUseCases(postgresScheduling(uncertainPool), async () => {}).allocate(delivery);
    expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [delivery.eventId])).rows)
      .toEqual([{ outcome: "succeeded" }]);
    expect((await pool.query("SELECT attempt,outcome FROM scheduling.consumer_attempts WHERE event_id=$1", [delivery.eventId])).rows)
      .toEqual([{ attempt: 0, outcome: "succeeded" }]);
  } finally { await uncertainPool.end(); await proxy.close(); }
});

it("lets a duplicate win after rollback and revalidates its success before recording recovery", async () => {
  const delivery = await work();
  const url = new URL(target); url.searchParams.set("application_name", "retry-failing-delivery");
  const proxy = await postgresProxy(url.toString());
  const failingPool = createDatabasePool(proxy.url);
  await pool.query(`CREATE FUNCTION scheduling.fail_racing_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF current_setting('application_name')='retry-failing-delivery' THEN RAISE EXCEPTION 'Synthetic losing delivery'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER fail_racing_delivery BEFORE UPDATE ON scheduling.consumer_results
    FOR EACH ROW WHEN (NEW.outcome IS NOT NULL) EXECUTE FUNCTION scheduling.fail_racing_delivery()`);
  try {
    proxy.holdNextRollback();
    const losing = messageUseCases(postgresScheduling(failingPool), async () => {}).allocate(delivery);
    await eventually(async () => proxy.rolledBack, Boolean, 3000);
    await messageUseCases(store, async () => {}).allocate(delivery);
    proxy.releaseRollback(); await losing;
    expect((await pool.query("SELECT attempt,outcome FROM scheduling.consumer_attempts WHERE event_id=$1", [delivery.eventId])).rows)
      .toEqual([{ attempt: 0, outcome: "succeeded" }]);
    expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.outbox_publications WHERE event_id=$1", [delivery.eventId])).rows[0].n).toBe(1);
  } finally {
    proxy.releaseRollback(); await failingPool.end(); await proxy.close();
    await pool.query("DROP TRIGGER fail_racing_delivery ON scheduling.consumer_results");
    await pool.query("DROP FUNCTION scheduling.fail_racing_delivery()");
  }
});

it("coordinates failed duplicate deliveries from two independent consumers before scheduling one retry", async () => {
  const delivery = await work();
  await pool.query(`CREATE FUNCTION scheduling.fail_duplicate_deliveries() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN IF NEW.event_id='${delivery.eventId}'::uuid THEN RAISE EXCEPTION 'Synthetic duplicate failure'; END IF; RETURN NEW; END $$`);
  await pool.query(`CREATE TRIGGER fail_duplicate_deliveries BEFORE UPDATE ON scheduling.consumer_results
    FOR EACH ROW WHEN (NEW.outcome IS NOT NULL) EXECUTE FUNCTION scheduling.fail_duplicate_deliveries()`);
  const firstUrl = new URL(target); firstUrl.searchParams.set("application_name", "retry-consumer-A");
  const secondUrl = new URL(target); secondUrl.searchParams.set("application_name", "retry-consumer-B");
  const a = await consumerProcess({}, firstUrl.toString());
  const b = await consumerProcess({}, secondUrl.toString());
  const barrier = await holdScope(pool, "hospital-south", "mri");
  try {
    await publishDelivery(channel, delivery); await publishDelivery(channel, delivery);
    await awaitBlocked(pool, ["retry-consumer-A", "retry-consumer-B"], barrier.pid);
    await barrier.release();
    await eventually(async () => [...a.phases, ...b.phases].filter((phase) => phase.phase === "committed" && phase.delivery?.eventId === delivery.eventId).length,
      (n) => n === 2, 5000);
    expect((await pool.query("SELECT attempt,outcome FROM scheduling.consumer_attempts WHERE event_id=$1 ORDER BY attempt", [delivery.eventId])).rows)
      .toEqual([{ attempt: 0, outcome: "failed" }, { attempt: 1, outcome: null }]);
    expect((await pool.query("SELECT * FROM scheduling.outbox_publications WHERE event_id=$1 AND attempt=1", [delivery.eventId])).rows).toHaveLength(1);
  } finally {
    await barrier.release(); await a.stop(); await b.stop();
    await pool.query("DROP TRIGGER fail_duplicate_deliveries ON scheduling.consumer_results");
    await pool.query("DROP FUNCTION scheduling.fail_duplicate_deliveries()");
  }
}, 15000);

it("pauses a real database connection outage without spending logical or physical failure budgets in bulk", async () => {
  const deliveries = await Promise.all([work(), work(), work()]);
  const proxy = await postgresProxy(target.toString());
  let child = await consumerProcess({}, proxy.url);
  try {
    proxy.setAvailable(false);
    for (const delivery of deliveries) await publishDelivery(channel, delivery);
    await eventually(async () => child.phases.filter((phase) => phase.phase === "received" && deliveries.some((row) => row.eventId === phase.delivery?.eventId)).length,
      (n) => n >= 2, 12000);
    expect((await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=ANY($1::uuid[])", [deliveries.map((row) => row.eventId)])).rows).toEqual([]);
    expect((await channel.checkQueue("appointments.allocation.dlq")).messageCount).toBe(0);
    await child.stop();
    const retained = [];
    for (let index = 0; index < deliveries.length; index++) {
      const message = await eventually(() => channel.get("appointments.allocation", { noAck: false }), Boolean, 5000);
      if (!message) throw new Error("Expected retained outage work");
      retained.push(message);
    }
    const physicalCounts = retained.map((message) => Number(message.properties.headers?.["x-delivery-count"] ?? 0));
    // Closing the consumer adds one failed delivery; previous pause nacks add none.
    expect(physicalCounts.sort()).toEqual([0, 0, 1]);
    for (const message of retained) channel.nack(message, false, true);
    process.stdout.write(`Global outage physical failure counts after explicit consumer close ${JSON.stringify(physicalCounts)}\n`);
    proxy.setAvailable(true);
    child = await consumerProcess({}, proxy.url);
    await eventually(async () => (await pool.query("SELECT count(*)::integer AS n FROM scheduling.consumer_results WHERE event_id=ANY($1::uuid[]) AND outcome='succeeded'", [deliveries.map((row) => row.eventId)])).rows[0].n,
      (n) => n === 3, 10000);
    expect((await pool.query("SELECT attempt,outcome FROM scheduling.consumer_attempts WHERE event_id=ANY($1::uuid[])", [deliveries.map((row) => row.eventId)])).rows)
      .toEqual(deliveries.map(() => ({ attempt: 0, outcome: "succeeded" })));
  } finally { proxy.setAvailable(true); await child.stop(); await proxy.close(); }
}, 25000);

async function offeredNotification() {
  const hospitalId = `retry-${randomUUID()}`;
  const scope = { hospitalId, testTypeId: "mri" };
  await pool.query("INSERT INTO scheduling.hospitals VALUES ($1)", [hospitalId]);
  await pool.query("INSERT INTO scheduling.waiting_list_scopes VALUES ($1,'mri')", [hospitalId]);
  await pool.query("INSERT INTO scheduling.diagnostic_resources VALUES ($1,$1,'mri')", [hospitalId]);
  await pool.query(`INSERT INTO scheduling.slots VALUES ($1,$1,$1,'mri',date_trunc('milliseconds',clock_timestamp())+interval '1 day',
    date_trunc('milliseconds',clock_timestamp())+interval '1 day 30 minutes')`, [hospitalId]);
  const api = schedulingUseCases(store);
  const held = await api.createHold("patient-carlos", hospitalId, randomUUID());
  if (!("id" in held.body)) throw new Error("Expected direct hold");
  await api.joinWaitingList("patient-ana", scope, randomUUID());
  await api.cancelReservation("patient-carlos", held.body.id);
  const release = (await pool.query(`SELECT p.* FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id
    WHERE e.type='SlotReleased' AND e.payload->>'hospitalId'=$1`, [hospitalId])).rows[0];
  await messageUseCases(store, async () => {}).allocate({ version: 1, eventId: release.event_id, publicationId: release.id, consumer: "allocation", cycle: 0, attempt: 0 });
  const row = (await pool.query(`SELECT p.* FROM scheduling.outbox_publications p JOIN scheduling.events e ON e.id=p.event_id
    WHERE e.type='OfferCreated' AND e.payload->>'hospitalId'=$1`, [hospitalId])).rows[0];
  ownPublications.add(row.id);
  return { version: 1, eventId: row.event_id, publicationId: row.id, consumer: "notification", cycle: 0, attempt: 0 } satisfies Delivery;
}

it("executes four real transported attempts with durable 5s/30s/120s waits and parks only after the fourth failure", async () => {
  const delivery = await offeredNotification();
  const adapter = postgresOutbox(pool);
  const outbox = { ...adapter, ready: async () => (await adapter.ready()).filter((row) => row.eventId === delivery.eventId) };
  let child = await consumerProcess({ CONSUMER: "notification", FAIL_OUTPUT: "true", PAUSE_AFTER_COMMIT: "true" });
  try {
    await relayReadyPublications(outbox, (row) => publishDelivery(channel, row), 50);
    await eventually(async () => child.phases.some((phase) => phase.phase === "committed" && phase.delivery?.eventId === delivery.eventId), Boolean, 5000);
    const first = (await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=$1 ORDER BY attempt", [delivery.eventId])).rows;
    expect(first[0]).toMatchObject({ outcome: "failed", last_error: "Synthetic notification output failure" });
    await child.stop("SIGKILL");
    child = await consumerProcess({ CONSUMER: "notification", FAIL_OUTPUT: "true" });
    await eventually(async () => child.phases.some((phase) => phase.phase === "committed" && phase.delivery?.attempt === 0 && phase.delivery.eventId === delivery.eventId), Boolean, 5000);
    expect((await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=$1 ORDER BY attempt", [delivery.eventId])).rows).toEqual(first);
    for (let attempt = 1; attempt <= 3; attempt++) {
      const state = (await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=$1 ORDER BY attempt", [delivery.eventId])).rows;
      expect(state[attempt].not_before.getTime() - state[attempt - 1].completed_at.getTime()).toBe([0, 5000, 30000, 120000][attempt]);
      expect((await outbox.ready()).some((row) => row.attempt === attempt)).toBe(false);
      await eventually(async () => {
        await relayReadyPublications(outbox, (row) => publishDelivery(channel, row), 50);
        return (await pool.query("SELECT outcome FROM scheduling.consumer_attempts WHERE event_id=$1 AND attempt=$2", [delivery.eventId, attempt])).rows[0].outcome;
      }, (outcome) => outcome === "failed", [0, 8000, 33000, 123000][attempt]);
      const publication = (await pool.query("SELECT * FROM scheduling.outbox_publications WHERE event_id=$1 AND attempt=$2 AND destination='work'", [delivery.eventId, attempt])).rows[0];
      expect(publication.published_at.getTime()).toBeGreaterThanOrEqual(state[attempt].not_before.getTime());
      process.stdout.write(`Durable logical attempt ${JSON.stringify({ eventId: delivery.eventId, attempt, notBefore: state[attempt].not_before, publishedAt: publication.published_at })}\n`);
    }
    expect((await pool.query("SELECT state,park_reason FROM scheduling.consumer_cycles WHERE event_id=$1", [delivery.eventId])).rows)
      .toEqual([{ state: "parked", park_reason: "exhausted" }]);
    expect((await pool.query("SELECT outcome FROM scheduling.consumer_results WHERE event_id=$1", [delivery.eventId])).rows[0].outcome).toBeNull();
    await relayReadyPublications(outbox, (row) => publishDelivery(channel, row), 50);
    const dead = await eventually(() => channel.get("appointments.notifications.dlq", { noAck: false }), Boolean, 5000);
    if (!dead) throw new Error("Expected exhausted notification");
    expect(JSON.parse(dead.content.toString())).toMatchObject({ eventId: delivery.eventId, consumer: "notification", attempt: 3, destination: "dead" });
    channel.ack(dead);
    const all = (await pool.query("SELECT * FROM scheduling.outbox_publications WHERE event_id=$1", [delivery.eventId])).rows;
    expect(all).toHaveLength(5);
    for (const row of all) ownPublications.add(row.id);
  } finally { await child.stop(); }
}, 185000);

it("keeps terminal outcomes across every attempt while logical consumers retain independent histories", async () => {
  const delivery = await work();
  const messages = messageUseCases(store, async () => {});
  await messages.allocate(delivery);
  const old = { ...delivery, publicationId: randomUUID(), attempt: 2 };
  const other = { ...delivery, publicationId: randomUUID(), consumer: "notification" as const };
  for (const row of [old, other]) await pool.query(`INSERT INTO scheduling.outbox_publications(id,event_id,consumer,cycle,attempt,available_at,created_at)
    VALUES ($1,$2,$3,0,$4,clock_timestamp(),clock_timestamp())`, [row.publicationId, row.eventId, row.consumer, row.attempt]);
  await messages.allocate(old); await messages.notify(other);
  expect((await pool.query("SELECT consumer,outcome FROM scheduling.consumer_results WHERE event_id=$1 ORDER BY consumer", [delivery.eventId])).rows)
    .toEqual([{ consumer: "allocation", outcome: "succeeded" }, { consumer: "notification", outcome: null }]);
  expect((await pool.query("SELECT consumer,attempt,outcome FROM scheduling.consumer_attempts WHERE event_id=$1 ORDER BY consumer", [delivery.eventId])).rows)
    .toEqual([{ consumer: "allocation", attempt: 0, outcome: "succeeded" }, { consumer: "notification", attempt: 0, outcome: "failed" }]);
});

it("leaves all notifications pending when their shared output sink is broken", async () => {
  const notifications = [await offeredNotification(), await offeredNotification()];
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error("Synthetic pipe closed"), { code: "EPIPE" })); } });
  const messages = messageUseCases(store, structuredNotificationWriter(output));
  for (const notification of notifications) await expect(messages.notify(notification)).rejects.toThrow("Notification output is unavailable");
  expect((await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=ANY($1::uuid[])", [notifications.map((row) => row.eventId)])).rows).toEqual([]);
  for (const notification of notifications) await messageUseCases(store, async () => {}).notify(notification);
  expect((await pool.query("SELECT attempt,outcome FROM scheduling.consumer_attempts WHERE event_id=ANY($1::uuid[])", [notifications.map((row) => row.eventId)])).rows)
    .toEqual(notifications.map(() => ({ attempt: 0, outcome: "succeeded" })));
});

it("physically parks real process crashes before any SQL failure evidence without completing the business", async () => {
  const completed = await work();
  await messageUseCases(store, async () => {}).allocate(completed);
  // A preceding consumer may have committed but lost its ack before shutdown.
  await publishDelivery(channel, completed);
  const delivery = await work();
  await publishDelivery(channel, delivery);
  for (let failure = 0; failure <= 20; failure++) {
    const child = await consumerProcess({ PAUSE_BEFORE_EVENT_ID: delivery.eventId });
    try {
      await eventually(async () => child.phases.some((phase) => phase.phase === "received" && phase.delivery?.eventId === delivery.eventId), Boolean, 5000);
    } finally { await child.stop("SIGKILL"); }
  }
  const dead = await eventually(() => channel.get("appointments.allocation.dlq", { noAck: false }), Boolean, 10000);
  if (!dead) throw new Error("Expected physically parked work");
  expect(JSON.parse(dead.content.toString()).eventId).toBe(delivery.eventId);
  expect(dead.properties.headers?.["x-death"]?.[0]).toMatchObject({ reason: "delivery_limit", queue: "appointments.allocation" });
  expect((await pool.query("SELECT * FROM scheduling.consumer_results WHERE event_id=$1", [delivery.eventId])).rows).toEqual([]);
  expect((await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=$1", [delivery.eventId])).rows).toEqual([]);
  expect((await pool.query("SELECT attempt,outcome FROM scheduling.consumer_attempts WHERE event_id=$1", [completed.eventId])).rows)
    .toEqual([{ attempt: 0, outcome: "succeeded" }]);
  channel.ack(dead);
}, 45000);
