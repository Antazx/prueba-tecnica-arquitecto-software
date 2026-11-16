import type { ChannelModel } from "amqplib";
import type { Delivery } from "../../application/messages.ts";
import type { RecoveryRequest, RecoveryResult } from "../../application/recovery.ts";
import { parseDelivery, queues } from "./messaging.ts";
import { closeRabbitMq } from "./connection.ts";

export function recoveryOrigin(delivery: Delivery, fields: { exchange: string; routingKey: string }, headers: Record<string, unknown>): RecoveryRequest["source"] {
  if (fields.exchange !== "appointments.dead" || fields.routingKey !== `${delivery.consumer}.dead`) {
    throw new Error("DLQ delivery has unexpected routing provenance");
  }
  if (delivery.destination === "dead") return "application_dlq";
  const deaths: unknown = headers["x-death"];
  const physical = Array.isArray(deaths) && deaths.some((death: unknown) => {
    if (!death || typeof death !== "object") return false;
    const row = death as Record<string, unknown>;
    return row.queue === queues[delivery.consumer] && row.exchange === "appointments.work" && row.reason === "delivery_limit" &&
      typeof row.count === "number" && row.count > 0 && Array.isArray(row["routing-keys"]) && row["routing-keys"].includes(delivery.consumer);
  });
  if (!physical) throw new Error("DLQ delivery lacks delivery-limit provenance");
  return "broker_dlq";
}

// Use a dedicated connection from connectToRabbitMq: a stalled channel handshake
// retires that owned connection as well. Unacknowledged deliveries stay in the DLQ.
export async function recoverDlq(connection: ChannelModel, selection: {
  consumer: Delivery["consumer"]; publicationId: string; scanLimit: number; operator: string; reason: string;
}, recover: (request: RecoveryRequest) => Promise<RecoveryResult>): Promise<RecoveryResult> {
  if (!Number.isSafeInteger(selection.scanLimit) || selection.scanLimit < 1 || selection.scanLimit > 1000) throw new Error("DLQ scan limit must be between 1 and 1000");
  const channel = await connection.createChannel();
  channel.on("error", () => {});
  try {
    const queue = `${queues[selection.consumer]}.dlq`;
    const { messageCount } = await channel.checkQueue(queue);
    for (let index = 0; index < Math.min(messageCount, selection.scanLimit); index++) {
      const message = await channel.get(queue, { noAck: false });
      if (!message) break;
      if (message.properties.messageId !== selection.publicationId) continue;
      const delivery = parseDelivery(message.content);
      if (delivery.publicationId !== selection.publicationId || delivery.consumer !== selection.consumer ||
        message.properties.type !== "appointment-work.v1" || message.properties.contentType !== "application/json") {
        throw new Error("DLQ envelope does not match selected publication");
      }
      const source = recoveryOrigin(delivery, message.fields, message.properties.headers ?? {});
      const result = await recover({ delivery, source, operator: selection.operator, reason: selection.reason });
      channel.ack(message);
      return result;
    }
    throw new Error("Selected publication was not found within the bounded DLQ scan; no delivery acknowledged");
  } finally {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const closed = await Promise.race([
      Promise.resolve().then(() => channel.close()).then(() => true, () => false),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), 500); }),
    ]);
    clearTimeout(timer);
    if (!closed) await closeRabbitMq(connection);
  }
}
