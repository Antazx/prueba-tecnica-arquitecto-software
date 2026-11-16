import { expect, it } from "vitest";
import { decideAdmission, hasActiveDirectHold } from "../../src/scheduling/domain/waiting-list.ts";

it("checks own active hold before direct availability only for a new admission", () => {
  expect(decideAdmission({ hasActiveEntry: false, hasOwnHold: true, hasDirectCapacity: true })).toEqual({ kind: "active-hold" });
  expect(decideAdmission({ hasActiveEntry: false, hasOwnHold: false, hasDirectCapacity: true })).toEqual({ kind: "direct-capacity" });
  expect(decideAdmission({ hasActiveEntry: true, hasOwnHold: true, hasDirectCapacity: true })).toEqual({ kind: "existing-entry" });
  expect(decideAdmission({ hasActiveEntry: false, hasOwnHold: false, hasDirectCapacity: false })).toEqual({ kind: "admit" });
});
it.each([-1, 0, 1])("revalidates a direct hold at expiry %+i ms", (offset) => {
  expect(hasActiveDirectHold([{ state: "HELD", expiresAt: 1000 }], 1000 + offset)).toBe(offset < 0);
  expect(hasActiveDirectHold([{ state: "CONFIRMED", expiresAt: 2000 }], 1000 + offset)).toBe(false);
});

it("derives per-slot priority from waiting state and exclusions instead of an enduring allocation flag", async () => {
  const { waitingListHasPriority } = await import("../../src/scheduling/domain/waiting-list.ts");
  const waiting = { state: "WAITING", excludedSlotIds: ["H1"] };
  expect(waitingListHasPriority([waiting], "H1")).toBe(false);
  expect(waitingListHasPriority([waiting], "H2")).toBe(true);
  expect(waitingListHasPriority([{ state: "OFFERED", excludedSlotIds: [] }], "H2")).toBe(false);
  expect(waitingListHasPriority([{ state: "CLOSED", excludedSlotIds: [] }], "H2")).toBe(false);
});
