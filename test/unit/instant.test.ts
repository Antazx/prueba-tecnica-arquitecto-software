import { describe, expect, it } from "vitest";
import { parseExternalInstant } from "../../src/scheduling/domain/instant.ts";

describe("external instants", () => {
  it("normalizes an explicit offset to UTC milliseconds", () => {
    expect(parseExternalInstant("2030-05-10T14:00:00.12+02:00").toISOString())
      .toBe("2030-05-10T12:00:00.120Z");
  });

  it.each([
    "2030-05-10T12:00:00", "2030-05-10", "2030-05-10T12:00:00.1234Z",
    "2030-02-30T12:00:00Z", "2030-05-10T24:00:00Z", "not-a-date",
  ])("rejects an ambiguous, invalid or overly precise instant: %s", (value) => {
    expect(() => parseExternalInstant(value)).toThrow("Invalid instant");
  });
});
