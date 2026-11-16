import { Writable } from "node:stream";
import { expect, it } from "vitest";
import { structuredNotificationWriter } from "../../src/scheduling/adapters/notification.ts";

it("returns an output error without leaving the stream error unhandled", async () => {
  const output = new Writable({ write(_chunk, _encoding, callback) { callback(new Error("Synthetic write failure")); } });
  await expect(structuredNotificationWriter(output)({ event: "offer_notification", eventId: "event", reservationId: "reservation", slotId: "slot", patientId: "patient", expiresAt: "2030-01-01T00:00:00.000Z" }))
    .rejects.toThrow("Synthetic write failure");
});
