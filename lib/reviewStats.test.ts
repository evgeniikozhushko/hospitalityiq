import { describe, expect, it } from "vitest";
import { addDays, assertDate, previousWindow, StatsInputError, trendChange } from "./reviewStats";

describe("trendChange", () => {
  it("compares shares of tagged reviews, not only raw counts", () => {
    // Twice the mentions, half the share.
    expect(trendChange({ count: 20, tagged: 200 }, { count: 10, tagged: 50 })).toEqual({
      absolute: 10,
      percent: 100,
      currentShare: 0.1,
      previousShare: 0.2,
      sharePoints: -10,
    });
  });

  it("has no share for a period without tagged reviews, and no percent from zero", () => {
    expect(trendChange({ count: 0, tagged: 0 }, { count: 3, tagged: 12 })).toEqual({
      absolute: -3,
      percent: -100,
      currentShare: null,
      previousShare: 0.25,
      sharePoints: null,
    });
    const fromZero = trendChange({ count: 2, tagged: 8 }, { count: 0, tagged: 8 });
    expect(fromZero.percent).toBeNull();
    expect(fromZero.sharePoints).toBe(25);
  });
});

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
