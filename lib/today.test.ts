import { describe, expect, it } from "vitest";
import { localToday, PORTFOLIO_TIMEZONE } from "./today";

describe("localToday", () => {
  it("uses the portfolio timezone, not UTC", () => {
    expect(PORTFOLIO_TIMEZONE).toBe("America/Edmonton");
    // Late evening in Banff on 10 Nov is already 11 Nov in UTC. Alberta stopped
    // changing clocks on 1 Nov 2026 (UTC-6 all year), but a runtime with older
    // timezone data still says UTC-7, so the instant is late evening under both.
    const lateEvening = new Date("2026-11-11T05:30:00Z");
    expect(lateEvening.toISOString().slice(0, 10)).toBe("2026-11-11");
    expect(localToday(lateEvening)).toBe("2026-11-10");
  });

  it("agrees with UTC in the middle of the local day", () => {
    expect(localToday(new Date("2026-11-11T18:00:00Z"))).toBe("2026-11-11");
  });

  it("is UTC-6 in summer", () => {
    // 11:30pm on 30 June in Banff is 05:30 on 1 July UTC.
    expect(localToday(new Date("2026-07-01T05:30:00Z"))).toBe("2026-06-30");
  });

  it("accepts another timezone", () => {
    expect(localToday(new Date("2026-11-11T06:00:00Z"), "UTC")).toBe("2026-11-11");
  });
});
