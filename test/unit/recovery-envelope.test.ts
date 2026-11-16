import { expect, it } from "vitest";
import { recoveryOrigin } from "../../src/scheduling/adapters/rabbitmq/recovery.ts";
import type { Delivery } from "../../src/scheduling/application/messages.ts";

const delivery: Delivery = { version: 1, publicationId: "00000000-0000-4000-8000-000000000001", eventId: "00000000-0000-4000-8000-000000000002", consumer: "allocation", cycle: 0, attempt: 0 };
it("requires actual delivery-limit provenance for work recovered from the physical DLQ", () => {
  const fields = { exchange: "appointments.dead", routingKey: "allocation.dead", deliveryTag: 1, redelivered: false };
  expect(() => recoveryOrigin(delivery, fields, {})).toThrow("provenance");
  const headers = { "x-death": [{ queue: "appointments.allocation", exchange: "appointments.work", reason: "delivery_limit", count: 1, "routing-keys": ["allocation"] }] };
  expect(recoveryOrigin(delivery, fields, headers)).toBe("broker_dlq");
  expect(() => recoveryOrigin(delivery, fields, { "x-death": [{ ...headers["x-death"][0], queue: "appointments.notifications" }] })).toThrow("provenance");
  expect(recoveryOrigin({ ...delivery, destination: "dead" }, fields, {})).toBe("application_dlq");
});
