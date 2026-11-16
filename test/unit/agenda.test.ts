import { describe, expect, it } from "vitest";
import { validateAgenda } from "../../src/scheduling/domain/agenda.ts";

describe("agenda validation", () => {
  it("rejects an interval that becomes empty at millisecond precision", () => {
    expect(() => validateAgenda([
      { id: "slot-1", resourceId: "resource-1", startsAt: 1000.1, endsAt: 1000.9 },
    ])).toThrow("Slot slot-1 has an empty interval");
  });

  it("rejects overlapping intervals of the same resource regardless of input order", () => {
    expect(() => validateAgenda([
      { id: "slot-2", resourceId: "resource-1", startsAt: 1500, endsAt: 2500 },
      { id: "slot-1", resourceId: "resource-1", startsAt: 1000, endsAt: 2000 },
    ])).toThrow("Slots slot-1 and slot-2 overlap");
  });

  it("allows contiguous slots and simultaneous slots of different resources", () => {
    expect(() => validateAgenda([
      { id: "slot-1", resourceId: "resource-1", startsAt: 1000.1, endsAt: 2000.9 },
      { id: "slot-2", resourceId: "resource-1", startsAt: 2000.2, endsAt: 3000 },
      { id: "slot-3", resourceId: "resource-2", startsAt: 1000, endsAt: 2000 },
    ])).not.toThrow();
  });
});
