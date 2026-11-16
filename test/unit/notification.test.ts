import { Writable } from "node:stream";
import { expect, it } from "vitest";
import { structuredNotificationWriter } from "../../src/scheduling/adapters/notification.ts";
import { ConsumptionPaused } from "../../src/scheduling/application/messages.ts";

it("returns an output error without leaving the stream error unhandled", async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("Synthetic write failure")); } });
  await expect(structuredNotificationWriter(output)({ event: "offer_notification", eventId: "event", reservationId: "reservation", slotId: "slot", patientId: "patient", expiresAt: "2030-01-01T00:00:00.000Z" }))
    .rejects.toThrow("Synthetic write failure");
});

it.each(["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"])("pauses a globally broken notification sink (%s)", async (code) => {
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(Object.assign(new Error("Synthetic unavailable output"), { code })); } });
  await expect(structuredNotificationWriter(output)({ event: "offer_notification", eventId: "event", reservationId: "reservation", slotId: "slot", patientId: "patient", expiresAt: "2030-01-01T00:00:00.000Z" }))
    .rejects.toBeInstanceOf(ConsumptionPaused);
});
