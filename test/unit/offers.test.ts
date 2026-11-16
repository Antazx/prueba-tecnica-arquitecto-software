import { expect, it } from "vitest";
import { offerDeadline, selectOffers, evaluateEntryOffer } from "../../src/scheduling/domain/offers.ts";

it("visits all future slots chronologically and applies FIFO per eligible slot without global matching", () => {
  const slots = [{ id: "later", startsAt: 3000 }, { id: "b", startsAt: 2000 }, { id: "a", startsAt: 2000 }, { id: "started", startsAt: 1000 }];
  const entries = [
    { id: "bruno", state: "WAITING", admissionOrder: "11", excludedSlotIds: ["b", "later"] },
    { id: "ana", state: "WAITING", admissionOrder: "10", excludedSlotIds: [] },
  ];
  expect(selectOffers(slots, entries, 1000)).toEqual([{ slotId: "a", entryId: "ana" }]);
  expect(selectOffers(slots, [{ ...entries[0], excludedSlotIds: ["a", "b"] }], 1000))
    .toEqual([{ slotId: "later", entryId: "bruno" }]);
});

it("identifies unavailable offer actions at equality without inventing expiry for an entry waiting without an offer", () => {
  expect(evaluateEntryOffer("WAITING", undefined, 2000)).toEqual({ temporal: { expired: false, closurePending: false },
    actions: { canWithdraw: true, canAcceptOffer: false, canRejectOffer: false } });
  expect(evaluateEntryOffer("OFFERED", { expiresAt: 1000, startsAt: 2000 }, 999)).toMatchObject({
    temporal: { expired: false }, actions: { canAcceptOffer: true, canRejectOffer: true, canWithdraw: true },
  });
  for (const time of [1000, 1001]) expect(evaluateEntryOffer("OFFERED", { expiresAt: 1000, startsAt: 2000 }, time)).toEqual({
    temporal: { expired: true, closurePending: true }, actions: { canWithdraw: false, canAcceptOffer: false, canRejectOffer: false },
  });
});

it("caps offers at two hours or the slot start and excludes equality", () => {
  expect(offerDeadline(10_000_000, 0)).toBe(7_200_000);
  expect(offerDeadline(10_000_000, 0, 9_000_000)).toBe(9_000_000);
  expect(offerDeadline(1000, 0)).toBe(1000);
  expect(offerDeadline(1000, 999, 500)).toBe(1000);
  expect(offerDeadline(1000, 1000)).toBeNull();
  expect(offerDeadline(1000, 1001)).toBeNull();
});
