import { describe, expect, it } from "vitest";
import { addDays, assertDate, previousWindow, StatsInputError } from "./reviewStats";

describe("date windows", () => {
  it("the previous window is the equal-length range immediately before", () => {
    expect(previousWindow({ since: "2026-02-01", until: "2026-02-28" })).toEqual({
      since: "2026-01-04",
      until: "2026-01-31",
    });
  });

  it("a one-day window has a one-day predecessor", () => {
    expect(previousWindow({ since: "2026-03-09", until: "2026-03-09" })).toEqual({
      since: "2026-03-08",
      until: "2026-03-08",
    });
  });

  it("crosses month and year boundaries", () => {
    expect(previousWindow({ since: "2026-01-01", until: "2026-01-31" })).toEqual({
      since: "2025-12-01",
      until: "2025-12-31",
    });
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("rejects malformed and impossible dates", () => {
    expect(() => assertDate("since", "2026-2-1")).toThrow(StatsInputError);
    expect(() => assertDate("since", "2026-02-30")).toThrow(StatsInputError);
    expect(() => assertDate("since", "2026-02-28")).not.toThrow();
  });
});
