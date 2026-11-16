import { expect, it } from "vitest";
import { planFailure } from "../../src/scheduling/domain/message-retries.ts";

it("allows four logical attempts with 5s, 30s and 2min from the preceding failure", () => {
  expect(planFailure(0, false, 1000)).toEqual({ kind: "retry", attempt: 1, notBefore: 6000 });
  expect(planFailure(1, false, 7000)).toEqual({ kind: "retry", attempt: 2, notBefore: 37000 });
  expect(planFailure(2, false, 40000)).toEqual({ kind: "retry", attempt: 3, notBefore: 160000 });
  expect(planFailure(3, false, 170000)).toEqual({ kind: "park", reason: "exhausted" });
});

it("parks permanent failure immediately without spending the remaining attempts", () => {
  expect(planFailure(0, true, 1000)).toEqual({ kind: "park", reason: "permanent" });
});
