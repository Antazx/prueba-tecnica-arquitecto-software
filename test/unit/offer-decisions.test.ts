import { expect, it } from "vitest";
import { decideOfferRejection } from "../../src/scheduling/domain/offers.ts";
import { decideWaitingWithdrawal } from "../../src/scheduling/domain/waiting-list.ts";

it.each([-1, 0, 1])("rejects an offer using the protected time at expiry %+i ms", (offset) => {
  expect(decideOfferRejection({ state: "OFFERED", expiresAt: 1000 }, 1000 + offset)).toEqual(offset < 0
    ? { allowed: true, state: "CANCELLED", returnToWaiting: true, reason: "OFFER_REJECTED" }
    : { allowed: false, state: "EXPIRED", returnToWaiting: false, reason: "EXPIRED", code: "RESERVATION_EXPIRED" });
});

it("preserves a completed rejection even past the original deadline and rejects unrelated states", () => {
  expect(decideOfferRejection({ state: "CANCELLED", expiresAt: 1000, closureReason: "OFFER_REJECTED" }, 2000))
    .toMatchObject({ allowed: true, state: "CANCELLED", returnToWaiting: false });
  for (const state of ["HELD", "CONFIRMED", "CANCELLED"] as const) expect(decideOfferRejection({ state, expiresAt: 1000 }, 2000))
    .toMatchObject({ allowed: false, state, code: "RESERVATION_STATE_CONFLICT" });
});

it.each([-1, 0, 1])("withdraws an offered entry with its real closure at expiry %+i ms", (offset) => {
  expect(decideWaitingWithdrawal({ state: "OFFERED" }, { expiresAt: 1000 }, 1000 + offset)).toEqual(offset < 0
    ? { state: "CLOSED", closureReason: "WITHDRAWN", reservationState: "CANCELLED" }
    : { state: "CLOSED", closureReason: "EXPIRED", reservationState: "EXPIRED" });
});

it.each(["ACCEPTED", "EXPIRED", "WITHDRAWN"] as const)("preserves a closed participation's %s cause", (closureReason) => {
  expect(decideWaitingWithdrawal({ state: "CLOSED", closureReason }, undefined, 2000)).toEqual({ state: "CLOSED", closureReason });
});
