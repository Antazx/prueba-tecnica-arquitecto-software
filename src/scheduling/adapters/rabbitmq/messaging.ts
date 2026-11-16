import { setTimeout as delay } from "node:timers/promises";
import type { Channel, ChannelModel, ConfirmChannel, Message } from "amqplib";
import { ConsumptionDeferred, ConsumptionPaused, type Delivery } from "../../application/messages.ts";
import { DependencyUnavailable } from "../../application/scheduling.ts";
import type { PublicationResult } from "../../application/outbox.ts";

export const queues = { allocation: "appointments.allocation", notification: "appointments.notifications" } as const;

export async function assertTopology(channel: Channel) {
  await channel.assertExchange("appointments.work", "direct", { durable: true });
  await channel.assertExchange("appointments.dead", "direct", { durable: true });
  for (const consumer of ["allocation", "notification"] as const) {
    await channel.assertQueue(queues[consumer], { durable: true, arguments: { "x-queue-type": "quorum", "x-quorum-initial-group-size": 1 } });
    await channel.assertQueue(`${queues[consumer]}.dlq`, { durable: true, arguments: {
      "x-queue-type": "quorum", "x-quorum-initial-group-size": 1, "x-delivery-limit": -1, "x-overflow": "reject-publish",
    } });
    await channel.bindQueue(queues[consumer], "appointments.work", consumer);
    await channel.bindQueue(`${queues[consumer]}.dlq`, "appointments.dead", `${consumer}.dead`);
  }
}

// The relay awaits each invocation: returns and confirms concern exactly one publication.
export class UnroutablePublicationError extends Error {}

export function publishConfirmed(channel: ConfirmChannel, exchange: string, routingKey: string, delivery: Delivery, timeoutMs = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    let returned = false;
    let confirmed = false;
    let drained = true;
    let settled = false;
    let confirmationError: Error | undefined;
    const finish = (error?: Error) => {
      if (settled || (!error && (!confirmed || !drained))) return;
      settled = true;
      clearTimeout(timer);
      channel.off("return", onReturn); channel.off("close", onClose); channel.off("error", onError); channel.off("drain", onDrain);
      if (error) reject(error); else resolve();
    };
    const onReturn = (message: Message) => { if (message.properties.messageId === delivery.publicationId) returned = true; };
    const onClose = () => finish(new Error("Publisher channel closed before confirmation"));
    const onError = (error: Error) => finish(error);
    const complete = () => { if (confirmed && drained) finish(confirmationError); };
    const onDrain = () => { drained = true; complete(); };
    const timer = setTimeout(() => {
      finish(new Error("Publisher confirmation timed out"));
      // Isolate late responses from the next generation; pending SQL remains untouched.
      void channel.close().catch(() => {});
    }, timeoutMs);
    channel.on("return", onReturn); channel.once("close", onClose); channel.once("error", onError); channel.once("drain", onDrain);
    try {
      drained = channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(delivery)), {
        persistent: true, mandatory: true, contentType: "application/json", type: "appointment-work.v1", messageId: delivery.publicationId,
      }, (error: Error | null) => {
        if (error) { finish(error); return; }
        confirmed = true;
        confirmationError = returned ? new UnroutablePublicationError("Publication was unroutable") : undefined;
        complete();
      });
    } catch (error) { finish(error instanceof Error ? error : new Error("Publication failed")); }
  });
}

export async function publishDelivery(channel: ConfirmChannel, delivery: Delivery, timeoutMs = 5000): Promise<PublicationResult> {
  try {
    await publishConfirmed(channel, delivery.destination === "dead" ? "appointments.dead" : "appointments.work",
      delivery.destination === "dead" ? `${delivery.consumer}.dead` : delivery.consumer, delivery, timeoutMs);
    return { accepted: true };
  } catch (error) {
    if (error instanceof UnroutablePublicationError) return { accepted: false, error: error.message };
    throw error;
  }
}

export function parseDelivery(content: Buffer): Delivery {
  const value: unknown = JSON.parse(content.toString("utf8"));
  if (!value || typeof value !== "object") throw new Error("Invalid work envelope");
  const row = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (row.version !== 1 || typeof row.publicationId !== "string" || !uuid.test(row.publicationId) ||
    typeof row.eventId !== "string" || !uuid.test(row.eventId) || typeof row.consumer !== "string" || !["allocation", "notification"].includes(row.consumer) ||
    !Number.isSafeInteger(row.cycle) || Number(row.cycle) < 0 || !Number.isInteger(row.attempt) || Number(row.attempt) < 0 || Number(row.attempt) > 3 ||
    (row.destination !== undefined && row.destination !== "dead")) {
    throw new Error("Invalid work envelope");
  }
  return { version: 1, publicationId: row.publicationId, eventId: row.eventId,
    consumer: row.consumer as Delivery["consumer"], cycle: Number(row.cycle), attempt: Number(row.attempt),
    ...(row.destination === "dead" ? { destination: "dead" as const } : {}) };
}

export async function consumeWork(connection: ChannelModel, consumer: Delivery["consumer"], handle: (delivery: Delivery) => Promise<void>) {
  const channel = await connection.createChannel();
  channel.on("error", () => {});
  await channel.prefetch(1);
  await channel.consume(queues[consumer], (message) => {
    if (!message) return;
    void (async () => {
      try {
        const delivery = parseDelivery(message.content);
        if (delivery.consumer !== consumer) throw new Error("Envelope consumer does not match queue");
        await handle(delivery);
        // Handler resolves only after the SQL commit (and notification write).
        channel.ack(message);
      } catch (error) {
        console.warn(JSON.stringify({ event: "message_processing_failed", consumer, message: error instanceof Error ? error.message : "Unknown error" }));
        await delay(1000);
        try {
          // An outage or early delivery pauses this prefetch=1 consumer without spending
          // either logical attempts or RabbitMQ's failed-delivery budget.
          if (error instanceof DependencyUnavailable || error instanceof ConsumptionDeferred || error instanceof ConsumptionPaused) channel.nack(message, false, true);
          else channel.reject(message, true);
        } catch { /* A closed channel leaves delivery unacknowledged. */ }
      }
    })();
  }, { noAck: false });
  return channel;
}
