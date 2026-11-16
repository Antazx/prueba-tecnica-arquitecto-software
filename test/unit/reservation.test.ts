import { describe, expect, it } from "vitest";
import { decideDirectHold, evaluateReservation } from "../../src/scheduling/domain/reservation.ts";

describe("direct hold deadline", () => {
  it("allows at most ten minutes, capped at the slot start", () => {
    expect(decideDirectHold({ startsAt: 3_600_000, occupied: false }, 0))
      .toEqual({ allowed: true, createdAt: 0, expiresAt: 600_000 });
    expect(decideDirectHold({ startsAt: 300_000, occupied: false }, 0))
      .toEqual({ allowed: true, createdAt: 0, expiresAt: 300_000 });
  });
  it("rejects creation at or after the start, including internal truncation", () => {
    expect(decideDirectHold({ startsAt: 1000.9, occupied: false }, 999.9)).toMatchObject({ allowed: true, expiresAt: 1000 });
    expect(decideDirectHold({ startsAt: 1000.9, occupied: false }, 1000)).toEqual({ allowed: false, code: "SLOT_STARTED" });
    expect(decideDirectHold({ startsAt: 1000, occupied: false }, 1001)).toEqual({ allowed: false, code: "SLOT_STARTED" });
    expect(decideDirectHold({ startsAt: 5000, occupied: true }, 0)).toEqual({ allowed: false, code: "SLOT_OCCUPIED" });
  });
});

describe("own reservation temporal evaluation", () => {
  it.each(["HELD", "OFFERED"] as const)("keeps persisted %s separate from expiry at minus one, equality and plus one millisecond", (state) => {
    expect(evaluateReservation({ state, expiresAt: 1000, startsAt: 2000 }, 999)).toMatchObject({
      expired: false, closurePending: false, canConfirm: true,
    });
    for (const time of [1000, 1001]) {
      expect(evaluateReservation({ state, expiresAt: 1000, startsAt: 2000 }, time)).toEqual({
        expired: true, closurePending: true, canConfirm: false, canCancel: false, canRejectOffer: false,
      });
    }
  });
  it("does not expire a confirmed reservation by its previous temporary deadline", () => {
    expect(evaluateReservation({ state: "CONFIRMED", expiresAt: 1000, startsAt: 2000 }, 1500)).toEqual({
      expired: false, closurePending: false, canConfirm: true, canCancel: true, canRejectOffer: false,
    });
    expect(evaluateReservation({ state: "CONFIRMED", expiresAt: 1000, startsAt: 2000 }, 2000)).toMatchObject({ canCancel: false });
    expect(evaluateReservation({ state: "EXPIRED", expiresAt: 1000, startsAt: 2000 }, 3000)).toMatchObject({ expired: false, closurePending: false, canConfirm: false });
  });
});
