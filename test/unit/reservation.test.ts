import { describe, expect, it } from "vitest";
import { decideDirectHold, evaluateReservation, decideConfirmation, decideCancellation } from "../../src/scheduling/domain/reservation.ts";

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

describe("direct reservation confirmation", () => {
  it.each(["HELD", "OFFERED"] as const)("confirms the same %s until one millisecond before its deadline", (state) => {
    expect(decideConfirmation({ state, expiresAt: 1000, startsAt: 2000 }, 999))
      .toEqual({ state: "CONFIRMED", allowed: true });
  });
});

it.each(["HELD", "OFFERED"] as const)("expires late %s confirmations at equality and one millisecond later", (state) => {
  for (const time of [1000, 1001]) expect(decideConfirmation({ state, expiresAt: 1000, startsAt: 2000 }, time))
    .toEqual({ state: "EXPIRED", allowed: false, code: "RESERVATION_EXPIRED" });
});

it("repeats confirmation by current state and preserves terminal reservations", () => {
  expect(decideConfirmation({ state: "CONFIRMED", expiresAt: 1000, startsAt: 2000 }, 3000)).toEqual({ state: "CONFIRMED", allowed: true });
  expect(decideConfirmation({ state: "CANCELLED", expiresAt: 1000, startsAt: 2000 }, 3000)).toEqual({ state: "CANCELLED", allowed: false, code: "RESERVATION_STATE_CONFLICT" });
  expect(decideConfirmation({ state: "EXPIRED", expiresAt: 1000, startsAt: 2000 }, 3000)).toEqual({ state: "EXPIRED", allowed: false, code: "RESERVATION_EXPIRED" });
});

describe("direct reservation cancellation", () => {
  it("cancels a live hold but expires it at equality and one millisecond later", () => {
    const reservation = { state: "HELD", expiresAt: 1000, startsAt: 2000 } as const;
    expect(decideCancellation(reservation, 999)).toEqual({ state: "CANCELLED", allowed: true });
    for (const time of [1000, 1001]) expect(decideCancellation(reservation, time))
      .toEqual({ state: "EXPIRED", allowed: false, code: "RESERVATION_EXPIRED" });
  });
});

it("cancels a confirmed appointment only before start and repeats valid cancellation even later", () => {
  const confirmed = { state: "CONFIRMED", expiresAt: 1000, startsAt: 2000 } as const;
  expect(decideCancellation(confirmed, 1999)).toEqual({ state: "CANCELLED", allowed: true });
  for (const time of [2000, 2001]) expect(decideCancellation(confirmed, time))
    .toEqual({ state: "CONFIRMED", allowed: false, code: "APPOINTMENT_STARTED" });
  expect(decideCancellation({ ...confirmed, state: "CANCELLED", closureReason: "CANCELLED" }, 3000)).toEqual({ state: "CANCELLED", allowed: true });
  expect(decideCancellation({ ...confirmed, state: "EXPIRED" }, 3000)).toEqual({ state: "EXPIRED", allowed: false, code: "RESERVATION_EXPIRED" });
});

it("requires the offer operations and never treats cancellation as offer rejection", () => {
  for (const time of [999, 1000, 1001]) expect(decideCancellation({ state: "OFFERED", expiresAt: 1000, startsAt: 2000 }, time))
    .toEqual({ state: "OFFERED", allowed: false, code: "RESERVATION_STATE_CONFLICT" });
  expect(decideCancellation({ state: "CANCELLED", closureReason: "OFFER_REJECTED", expiresAt: 1000, startsAt: 2000 }, 3000))
    .toEqual({ state: "CANCELLED", allowed: false, code: "RESERVATION_STATE_CONFLICT" });
});

it("can shorten the configured hold TTL without extending the ten-minute policy", () => {
  expect(decideDirectHold({ startsAt: 2000, occupied: false }, 0, 500)).toEqual({ allowed: true, createdAt: 0, expiresAt: 500 });
  expect(decideDirectHold({ startsAt: 300, occupied: false }, 0, 500)).toEqual({ allowed: true, createdAt: 0, expiresAt: 300 });
  expect(() => decideDirectHold({ startsAt: 1000000, occupied: false }, 0, 600001)).toThrow();
  expect(() => decideDirectHold({ startsAt: 1000000, occupied: false }, 0, 0)).toThrow();
});
