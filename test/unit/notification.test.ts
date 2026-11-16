import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
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

it("pauses a stalled shared sink without buffering more notices and resumes after it drains", async () => {
  vi.useFakeTimers();
  let completeWrite: (() => void) | undefined;
  const lines: string[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) {
    lines.push(chunk.toString());
    completeWrite = callback;
  } });
  const write = structuredNotificationWriter(output);
  const notice = { event: "offer_notification", eventId: "event", reservationId: "reservation", slotId: "slot", patientId: "patient", expiresAt: "2030-01-01T00:00:00.000Z" } as const;
  try {
    const stalled = write(notice).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await stalled).toBeInstanceOf(ConsumptionPaused);
    const buffered = output.writableLength;
    for (let index = 0; index < 10; index++) {
      await expect(write({ ...notice, eventId: `other-${index}` })).rejects.toBeInstanceOf(ConsumptionPaused);
    }
    expect(lines).toHaveLength(1);
    expect(output.writableLength).toBe(buffered);
    completeWrite!();
    const resumed = write(notice);
    completeWrite!();
    await expect(resumed).resolves.toBeUndefined();
    expect(lines).toHaveLength(2);
  } finally {
    output.destroy();
    vi.useRealTimers();
  }
});
