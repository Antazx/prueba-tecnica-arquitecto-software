import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { parseDelivery } from "../../src/scheduling/adapters/rabbitmq/messaging.ts";

it("requires the consumer enum to be a string without coercion", () => {
  const envelope = { version: 1, publicationId: randomUUID(), eventId: randomUUID(), consumer: ["allocation"], cycle: 0, attempt: 0 };
  expect(() => parseDelivery(Buffer.from(JSON.stringify(envelope)))).toThrow("Invalid work envelope");
});
