import { afterAll, beforeAll, expect, it } from "vitest";
import { connect, type ChannelModel, type ConfirmChannel } from "amqplib";
import { randomUUID } from "node:crypto";
import { assertTopology, publishConfirmed } from "../../src/scheduling/adapters/rabbitmq/messaging.ts";
import { eventually } from "../helpers/concurrency.ts";

const rabbitmqUrl = process.env.TEST_RABBITMQ_URL;
if (!rabbitmqUrl) throw new Error("TEST_RABBITMQ_URL is required");
let connection: ChannelModel;
let channel: ConfirmChannel;
beforeAll(async () => { connection = await connect(rabbitmqUrl); channel = await connection.createConfirmChannel(); await assertTopology(channel); });
afterAll(async () => { await channel?.close(); await connection?.close(); });

it("requires a real broker confirm and rejects mandatory returns even with a positive confirm", async () => {
  const body = { version: 1, publicationId: randomUUID(), eventId: randomUUID(), consumer: "allocation", cycle: 0, attempt: 0 } as const;
  await expect(publishConfirmed(channel, "appointments.work", "missing-route", body)).rejects.toThrow("unroutable");
  await expect(publishConfirmed(channel, "appointments.work", "allocation", body)).resolves.toBeUndefined();
  const received = await channel.get("appointments.allocation", { noAck: false });
  expect(received).toBeTruthy();
  if (!received) throw new Error("Expected publication");
  expect(received.properties.deliveryMode).toBe(2);
  expect(JSON.parse(received.content.toString())).toEqual(body);
  channel.ack(received);
});

it("applies delivery-limit 20 with basic.reject and protects the DLQ against further failed deliveries", async () => {
  const body = { version: 1, publicationId: randomUUID(), eventId: randomUUID(), consumer: "allocation", cycle: 0, attempt: 0 } as const;
  await publishConfirmed(channel, "appointments.work", "allocation", body);
  const counts: number[] = [];
  for (let failure = 0; failure <= 20; failure++) {
    const received = await eventually(() => channel.get("appointments.allocation", { noAck: false }), Boolean, 5000);
    if (!received) throw new Error("Expected physical delivery");
    expect(JSON.parse(received.content.toString()).publicationId).toBe(body.publicationId);
    const count = Number(received.properties.headers?.["x-delivery-count"] ?? 0);
    counts.push(count);
    expect(count).toBe(failure);
    channel.reject(received, true);
  }
  const dead = await eventually(() => channel.get("appointments.allocation.dlq", { noAck: false }), Boolean, 8000);
  if (!dead) throw new Error("Expected dead letter");
  expect(dead.properties.headers?.["x-death"]?.[0]).toMatchObject({ reason: "delivery_limit", queue: "appointments.allocation" });
  channel.reject(dead, true);
  for (let failure = 0; failure < 22; failure++) {
    const copy = await eventually(() => channel.get("appointments.allocation.dlq", { noAck: false }), Boolean, 5000);
    if (!copy) throw new Error("DLQ lost retained work");
    expect(JSON.parse(copy.content.toString()).attempt).toBe(0);
    if (failure === 21) channel.ack(copy); else channel.reject(copy, true);
  }
  process.stdout.write(`Observed physical failure counts ${JSON.stringify(counts)} and 22 protected DLQ redeliveries\n`);
}, 20000);

it("retains a broker dead letter while its DLQ has no route and delivers it after repair", async () => {
  const body = { version: 1, publicationId: randomUUID(), eventId: randomUUID(), consumer: "allocation", cycle: 0, attempt: 0 } as const;
  await channel.unbindQueue("appointments.allocation.dlq", "appointments.dead", "allocation.dead");
  try {
    await publishConfirmed(channel, "appointments.work", "allocation", body);
    const received = await eventually(() => channel.get("appointments.allocation", { noAck: false }), Boolean, 5000);
    if (!received) throw new Error("Expected original work");
    channel.reject(received, false);
    // A mandatory send independently proves the destination is still inaccessible.
    await expect(publishConfirmed(channel, "appointments.dead", "allocation.dead", body)).rejects.toThrow("unroutable");
    expect((await channel.checkQueue("appointments.allocation.dlq")).messageCount).toBe(0);
  } finally { await channel.bindQueue("appointments.allocation.dlq", "appointments.dead", "allocation.dead"); }
  // RabbitMQ 4.4 defaults its internal DLX confirm/retry timer to 180 seconds.
  // Leave that broker setting intact; it is separate from SQL's 5/30/120s budget.
  const dead = await eventually(() => channel.get("appointments.allocation.dlq", { noAck: false }), Boolean, 205000);
  if (!dead) throw new Error("Expected retained broker dead letter");
  expect(JSON.parse(dead.content.toString())).toEqual(body);
  expect(dead.properties.headers?.["x-death"]?.[0]).toMatchObject({ reason: "rejected", queue: "appointments.allocation" });
  channel.ack(dead);
}, 210000);
