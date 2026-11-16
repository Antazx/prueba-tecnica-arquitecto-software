import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { connect, type ChannelModel, type ConfirmChannel } from "amqplib";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabasePool } from "../../src/scheduling/adapters/postgres/database.ts";
import { initializeDatabase } from "../../src/scheduling/adapters/postgres/initialize.ts";
import { assertTopology, publishConfirmed, publishDelivery } from "../../src/scheduling/adapters/rabbitmq/messaging.ts";
import type { Delivery } from "../../src/scheduling/application/messages.ts";
import { relayReadyPublications } from "../../src/scheduling/application/outbox.ts";
import { postgresOutbox } from "../../src/scheduling/adapters/postgres/outbox.ts";
import { eventually, freePort } from "../helpers/concurrency.ts";
import { amqpProxy } from "../helpers/amqp-proxy.ts";

const databaseUrl = process.env.TEST_DATABASE_URL;
const rabbitmqUrl = process.env.TEST_RABBITMQ_URL;
if (!databaseUrl || !rabbitmqUrl) throw new Error("TEST_DATABASE_URL and TEST_RABBITMQ_URL are required");
const name = `appointment_relay_${Date.now()}_${process.pid}`;
const target = new URL(databaseUrl); target.pathname = `/${name}`;
const pool = createDatabasePool(target.toString());
const publications = new Set<string>();
let connection: ChannelModel;
let channel: ConfirmChannel;
beforeAll(async () => {
  const admin = createDatabasePool(databaseUrl);
  try { await admin.query(`CREATE DATABASE ${name}`); } finally { await admin.end(); }
  await initializeDatabase(pool);
  connection = await connect(rabbitmqUrl);
  channel = await connection.createConfirmChannel(); await assertTopology(channel);
});
afterAll(async () => {
  if (channel) {
    for (const queue of ["appointments.allocation", "appointments.notifications", "appointments.allocation.dlq", "appointments.notifications.dlq"]) {
      const retained = [];
      let message;
      while ((message = await channel.get(queue, { noAck: false }))) {
        if (publications.has(String(message.properties.messageId))) channel.ack(message);
        else retained.push(message);
      }
      for (const other of retained) channel.reject(other, true);
    }
    await channel.close();
  }
  await connection?.close(); await pool.end();
});

async function publication(consumer: Delivery["consumer"], age = 0): Promise<Delivery> {
  const delivery: Delivery = { version: 1, publicationId: randomUUID(), eventId: randomUUID(), consumer, cycle: 0, attempt: 0 };
  publications.add(delivery.publicationId);
  await pool.query(`INSERT INTO scheduling.events(id,type,version,occurred_at,payload)
    VALUES ($1,$2,1,clock_timestamp(),$3)`, [delivery.eventId, consumer === "allocation" ? "AllocationReviewRequested" : "OfferCreated",
    consumer === "allocation" ? { hospitalId: "hospital-south", testTypeId: "mri" } : { reservationId: randomUUID() }]);
  await pool.query(`INSERT INTO scheduling.outbox_publications(id,event_id,consumer,cycle,attempt,available_at,created_at)
    VALUES ($1,$2,$3,0,0,clock_timestamp()+($4*interval '1 millisecond'),clock_timestamp()+($4*interval '1 millisecond'))`,
  [delivery.publicationId, delivery.eventId, consumer, age]);
  return delivery;
}

async function worker(relay: boolean, brokerUrl = rabbitmqUrl, confirmTimeoutMs = "5000") {
  const port = await freePort();
  let logs = "";
  const child = spawn(process.execPath, ["src/bootstrap/worker.ts"], { cwd: process.cwd(), env: {
    ...process.env, DATABASE_URL: target.toString(), RABBITMQ_URL: brokerUrl, HOST: "127.0.0.1", WORKER_HEALTH_PORT: String(port),
    RELAY_ENABLED: String(relay), EXPIRY_SWEEP_INTERVAL_MS: "50", OUTBOX_RETRY_DELAY_MS: "2500",
    PUBLISHER_CONFIRM_TIMEOUT_MS: confirmTimeoutMs,
  }, stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  child.stderr?.on("data", (chunk: Buffer) => { logs += chunk.toString(); });
  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    const exited = once(child, "exit"); child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
    try { await exited; } finally { clearTimeout(timer); }
  };
  try {
    await eventually(async () => {
      if (child.exitCode !== null) throw new Error(logs);
      try { return (await fetch(`http://127.0.0.1:${port}/health/ready`)).ok; } catch { return false; }
    }, Boolean, 8000);
    return { stop, logs: () => logs };
  } catch (error) { await stop(); throw new Error(`Worker failed: ${logs}`, { cause: error }); }
}

it("AC35: publishes P2 while P1 is still unroutable, retains its delay across restart and never promotes W2", async () => {
  let w1: Awaited<ReturnType<typeof worker>> | undefined = await worker(true);
  let w2: Awaited<ReturnType<typeof worker>> | undefined;
  let p1: Delivery | undefined;
  try {
    await channel.unbindQueue("appointments.notifications", "appointments.work", "notification");
    p1 = await publication("notification", -1000);
    const p2 = await publication("allocation");
    await eventually(async () => (await pool.query("SELECT published_at FROM scheduling.outbox_publications WHERE id=$1", [p2.publicationId])).rows[0].published_at, Boolean, 2000);
    // A real mandatory return proves the route remains broken after P2 progressed.
    await expect(publishConfirmed(channel, "appointments.work", "notification", p1)).rejects.toThrow("unroutable");
    const pending = (await pool.query("SELECT *, next_attempt_at > clock_timestamp() AS waiting FROM scheduling.outbox_publications WHERE id=$1", [p1.publicationId])).rows[0];
    expect(pending).toMatchObject({ published_at: null, send_count: 1, waiting: true });
    expect(pending.last_error).toContain("unroutable");
    expect(pending.next_attempt_at.getTime()).toBeGreaterThan(pending.last_attempt_at.getTime());
    expect((await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=$1", [p1.eventId])).rows).toEqual([]);
    await w1.stop(); w1 = undefined;
    w2 = await worker(false);
    const withoutLeader = await publication("allocation");
    // W2 establishes topology as part of connection recovery, but never publishes SQL work.
    const retained = (await pool.query("SELECT send_count,next_attempt_at FROM scheduling.outbox_publications WHERE id=$1", [p1.publicationId])).rows[0];
    expect(retained).toEqual({ send_count: 1, next_attempt_at: pending.next_attempt_at });
    expect((await pool.query("SELECT published_at FROM scheduling.outbox_publications WHERE id=$1", [withoutLeader.publicationId])).rows[0].published_at).toBeNull();
    w1 = await worker(true);
    const restarted = (await pool.query("SELECT *, next_attempt_at > clock_timestamp() AS waiting FROM scheduling.outbox_publications WHERE id=$1", [p1.publicationId])).rows[0];
    expect(restarted).toMatchObject({ published_at: null, send_count: 1, waiting: true });
    await eventually(async () => (await pool.query("SELECT published_at FROM scheduling.outbox_publications WHERE id=$1", [p1!.publicationId])).rows[0].published_at, Boolean, 6000);
    const recovered = (await pool.query("SELECT * FROM scheduling.outbox_publications WHERE id=$1", [p1.publicationId])).rows[0];
    expect(recovered).toMatchObject({ event_id: p1.eventId, consumer: "notification", cycle: 0, attempt: 0, send_count: 2 });
    expect(recovered.published_at.getTime()).toBeGreaterThanOrEqual(pending.next_attempt_at.getTime());
    expect((await pool.query("SELECT send_count FROM scheduling.outbox_publications WHERE id=$1", [p2.publicationId])).rows[0].send_count).toBe(1);
    process.stdout.write(`AC35 durable relay evidence ${JSON.stringify({ database: name, P1: p1, P2: p2, pending, recovered })}\n`);
  } finally {
    await w1?.stop(); await w2?.stop();
    await channel.bindQueue("appointments.notifications", "appointments.work", "notification");
  }
}, 18000);

it("retires a timed-out connection with withheld real replies and publishes later work on a new generation", async () => {
  const proxy = await amqpProxy(rabbitmqUrl!);
  const w1 = await worker(true, proxy.url, "200");
  try {
    expect(proxy.peers).toHaveLength(1);
    proxy.peers[0].paused = true;
    const p1 = await publication("notification");
    await eventually(async () => proxy.peers[0].replies.length, (count) => count > 0, 2000);
    const p2 = await publication("allocation");
    expect((await pool.query("SELECT send_count,published_at FROM scheduling.outbox_publications WHERE id=$1", [p2.publicationId])).rows[0])
      .toEqual({ send_count: 0, published_at: null });
    const uncertain = await eventually(async () => (await pool.query("SELECT * FROM scheduling.outbox_publications WHERE id=$1", [p1.publicationId])).rows[0],
      (row) => Boolean(row.last_error), 2000);
    expect(uncertain).toMatchObject({ send_count: 1, published_at: null, last_error: "Publisher confirmation timed out" });
    await eventually(async () => proxy.peers[0].closed, Boolean, 1500);
    await eventually(async () => (await pool.query("SELECT published_at FROM scheduling.outbox_publications WHERE id=$1", [p2.publicationId])).rows[0].published_at, Boolean, 2500);
    expect(proxy.peers.length).toBeGreaterThanOrEqual(2);
    proxy.release(0);
    const retained = (await pool.query("SELECT send_count,published_at FROM scheduling.outbox_publications WHERE id=$1", [p1.publicationId])).rows[0];
    expect(retained).toEqual({ send_count: 1, published_at: null });
    process.stdout.write(`Real AMQP timeout evidence ${JSON.stringify({ P1: p1, P2: p2, uncertain, oldClosed: proxy.peers[0].closed, generations: proxy.peers.length })}\n`);
  } finally { await proxy.close(); await w1.stop(); }
}, 12000);

it("pauses during a global connection outage, preserving pending publications and consumer budgets until repair", async () => {
  const proxy = await amqpProxy(rabbitmqUrl!);
  const w1 = await worker(true, proxy.url);
  try {
    proxy.setAvailable(false);
    await eventually(async () => proxy.peers[0].closed, Boolean, 2000);
    await eventually(async () => w1.logs().includes('"event":"rabbitmq_disconnected"'), Boolean, 2000);
    const pending = await Promise.all([publication("allocation"), publication("allocation"), publication("allocation")]);
    const ids = pending.map((row) => row.publicationId);
    const observation = (await pool.query("SELECT clock_timestamp()+interval '2200 milliseconds' AS until")).rows[0].until;
    await eventually(async () => (await pool.query("SELECT clock_timestamp() >= $1::timestamptz AS done", [observation])).rows[0].done, Boolean, 3500);
    expect((await pool.query("SELECT send_count,published_at FROM scheduling.outbox_publications WHERE id=ANY($1::uuid[])", [ids])).rows)
      .toEqual(pending.map(() => ({ send_count: 0, published_at: null })));
    expect((await pool.query("SELECT count(*)::integer AS n FROM scheduling.consumer_attempts WHERE event_id=ANY($1::uuid[])", [pending.map((row) => row.eventId)])).rows[0].n).toBe(0);
    expect(proxy.connectionTimes.length).toBeLessThanOrEqual(4);
    proxy.setAvailable(true);
    await eventually(async () => (await pool.query("SELECT count(*)::integer AS n FROM scheduling.outbox_publications WHERE id=ANY($1::uuid[]) AND published_at IS NOT NULL", [ids])).rows[0].n,
      (count) => count === pending.length, 6000);
    process.stdout.write(`Global outage relay evidence ${JSON.stringify({ publications: pending, connectionTimes: proxy.connectionTimes })}\n`);
  } finally { await w1.stop(); await proxy.close(); }
}, 14000);

it("selects only due publications in a stable total order and never advances the logical execution date", async () => {
  const outbox = postgresOutbox(pool);
  const logical = await publication("allocation", 500);
  await pool.query(`UPDATE scheduling.outbox_publications SET next_attempt_at=clock_timestamp()-interval '1 hour' WHERE id=$1`, [logical.publicationId]);
  expect((await outbox.ready()).some((row) => row.publicationId === logical.publicationId)).toBe(false);
  expect(await outbox.started(logical.publicationId, 20)).toBe(false);
  await pool.query("INSERT INTO scheduling.consumer_results(event_id,consumer) VALUES ($1,'allocation')", [logical.eventId]);
  await pool.query("INSERT INTO scheduling.consumer_cycles(event_id,consumer,cycle,state) VALUES ($1,'allocation',0,'active')", [logical.eventId]);
  await pool.query(`INSERT INTO scheduling.consumer_attempts(event_id,consumer,cycle,attempt,not_before)
    VALUES ($1,'allocation',0,0,clock_timestamp()+interval '800 milliseconds')`, [logical.eventId]);
  await eventually(async () => (await pool.query("SELECT available_at <= clock_timestamp() AS due FROM scheduling.outbox_publications WHERE id=$1", [logical.publicationId])).rows[0].due, Boolean, 2000);
  expect((await outbox.ready()).some((row) => row.publicationId === logical.publicationId)).toBe(false);
  expect(await outbox.started(logical.publicationId, 20)).toBe(false);
  await eventually(async () => (await outbox.ready()).some((row) => row.publicationId === logical.publicationId), Boolean, 2000);
  const tied = await Promise.all([publication("allocation"), publication("allocation"), publication("allocation")]);
  const ids = tied.map((row) => row.publicationId);
  await pool.query(`UPDATE scheduling.outbox_publications SET available_at='2020-01-01T00:00:00Z',created_at='2020-01-01T00:00:00Z' WHERE id=ANY($1::uuid[])`, [ids]);
  expect((await outbox.ready()).filter((row) => ids.includes(row.publicationId)).map((row) => row.publicationId)).toEqual([...ids].sort());
});

it("retains unroutable work beyond four transport sends without spending consumer attempts or republishing retained successes", async () => {
  const pending = await publication("notification");
  const store = postgresOutbox(pool);
  const outbox = { ...store, ready: async () => (await store.ready()).filter((row) => row.publicationId === pending.publicationId) };
  await channel.unbindQueue("appointments.notifications", "appointments.work", "notification");
  try {
    for (let send = 1; send <= 5; send++) {
      await eventually(async () => (await outbox.ready()).length, (count) => count === 1, 2000);
      await relayReadyPublications(outbox, (delivery) => publishDelivery(channel, delivery), 20);
      expect((await pool.query("SELECT send_count,published_at,attempt FROM scheduling.outbox_publications WHERE id=$1", [pending.publicationId])).rows[0])
        .toEqual({ send_count: send, published_at: null, attempt: 0 });
    }
    expect((await pool.query("SELECT * FROM scheduling.consumer_attempts WHERE event_id=$1", [pending.eventId])).rows).toEqual([]);
    await channel.bindQueue("appointments.notifications", "appointments.work", "notification");
    await eventually(async () => (await outbox.ready()).length, (count) => count === 1, 2000);
    await relayReadyPublications(outbox, (delivery) => publishDelivery(channel, delivery), 20);
    await relayReadyPublications(outbox, (delivery) => publishDelivery(channel, delivery), 20);
    expect((await pool.query("SELECT send_count,published_at IS NOT NULL AS published,last_error FROM scheduling.outbox_publications WHERE id=$1", [pending.publicationId])).rows[0])
      .toEqual({ send_count: 6, published: true, last_error: "Publication was unroutable" });
  } finally { await channel.bindQueue("appointments.notifications", "appointments.work", "notification"); }
});
