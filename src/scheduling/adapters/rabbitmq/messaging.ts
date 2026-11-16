import { setTimeout as delay } from "node:timers/promises";
import type { Channel, ChannelModel, ConfirmChannel, Message } from "amqplib";
import type { Delivery } from "../../application/messages.ts";

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
export function publishConfirmed(channel: ConfirmChannel, exchange: string, routingKey: string, delivery: Delivery): Promise<void> {
  return new Promise((resolve, reject) => {
    let returned = false;
    let confirmed = false;
    let drained = true;
    let settled = false;
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
    const onDrain = () => { drained = true; finish(); };
    const timer = setTimeout(() => {
      finish(new Error("Publisher confirmation timed out"));
      // Isolate late responses from the next generation; pending SQL remains untouched.
      void channel.close().catch(() => {});
    }, 5000);
    channel.on("return", onReturn); channel.once("close", onClose); channel.once("error", onError); channel.once("drain", onDrain);
    try {
      drained = channel.publish(exchange, routingKey, Buffer.from(JSON.stringify(delivery)), {
        persistent: true, mandatory: true, contentType: "application/json", type: "appointment-work.v1", messageId: delivery.publicationId,
      }, (error: Error | null) => {
        confirmed = true;
        finish(error ?? (returned ? new Error("Publication was unroutable") : undefined));
      });
    } catch (error) { finish(error instanceof Error ? error : new Error("Publication failed")); }
  });
}

export function parseDelivery(content: Buffer): Delivery {
  const value: unknown = JSON.parse(content.toString("utf8"));
  if (!value || typeof value !== "object") throw new Error("Invalid work envelope");
  const row = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (row.version !== 1 || typeof row.publicationId !== "string" || !uuid.test(row.publicationId) ||
    typeof row.eventId !== "string" || !uuid.test(row.eventId) || typeof row.consumer !== "string" || !["allocation", "notification"].includes(row.consumer) ||
    !Number.isSafeInteger(row.cycle) || Number(row.cycle) < 0 || !Number.isInteger(row.attempt) || Number(row.attempt) < 0 || Number(row.attempt) > 3) {
    throw new Error("Invalid work envelope");
  }
  return { version: 1, publicationId: row.publicationId, eventId: row.eventId,
    consumer: row.consumer as Delivery["consumer"], cycle: Number(row.cycle), attempt: Number(row.attempt) };
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
        // Durable logical retries are added by the retry delivery. Until then retain work,
        // rate limit failures and let the independent physical broker protection apply.
        await delay(1000);
        try { channel.reject(message, true); } catch { /* A closed channel leaves delivery unacknowledged. */ }
      }
    })();
  }, { noAck: false });
  return channel;
}
