import { describe, expect, it } from "vitest";
import { parseWireEvent, SourceWireSchema } from "./askWire";
import { EMPTY_FILTERS, type QueryPlan, type Source } from "./schema";
import { source } from "./testFixtures";

const plan: QueryPlan = {
  intent: "review_insight",
  mode: "aggregate",
  searchQuery: "cold rooms",
  filters: { ...EMPTY_FILTERS, minRating: 1 },
};

const coverage = { totalReviews: 17, textReviews: 16, currentTagged: 15, stale: 0, untagged: 1 };
const mentions = {
  theme: "parking",
  sentiment: null,
  scopeLabel: "All properties",
  rows: [{ propertyId: 1, propertyName: "Lodge", count: 7, coverage }],
  total: { count: 9, coverage },
};
const statsMentions = {
  type: "stats",
  outcome: {
    kind: "mentions",
    query: { kind: "mentions", theme: "parking", sentiment: null, filters: EMPTY_FILTERS },
    result: mentions,
  },
};
const statsTrend = {
  type: "stats",
  outcome: {
    kind: "trend",
    query: { kind: "trend", theme: "parking", sentiment: "negative", filters: { ...EMPTY_FILTERS, since: "2025-11-10", until: "2026-11-10" } },
    result: {
      theme: "parking",
      sentiment: "negative",
      current: { ...mentions, window: { since: "2025-11-10", until: "2026-11-10" } },
      previous: { ...mentions, window: { since: "2024-11-10", until: "2025-11-09" } },
      change: { absolute: 0, percent: null },
    },
  },
};

const valid: Record<string, unknown> = {
  plan: { type: "plan", plan, droppedPropertyNames: ["Nope"] },
  declined: { type: "declined", intent: "campaign", message: "not yet" },
  no_data: { type: "no_data", message: "nothing" },
  sources: { type: "sources", sources: [source], relaxed: false },
  "stats (mentions)": statsMentions,
  "stats (trend)": statsTrend,
  delta: { type: "delta", text: "hi" },
  done: { type: "done" },
  error: { type: "error", message: "bad" },
};

describe("parseWireEvent", () => {
  for (const [type, raw] of Object.entries(valid)) {
    it(`accepts a valid ${type} event`, () => {
      expect(parseWireEvent(raw)).toEqual({ kind: "event", event: raw });
    });
  }

  it("accepts a plan event carrying the route, which the client does not need", () => {
    const raw = { type: "plan", plan: { ...plan, route: "statistics", stat: null }, droppedPropertyNames: [] };
    expect(parseWireEvent(raw)).toEqual({ kind: "event", event: { ...raw, plan } });
  });

  it("reports an unrecognised type as unknown, not invalid", () => {
    expect(parseWireEvent({ type: "heartbeat" })).toEqual({ kind: "unknown", type: "heartbeat" });
    expect(parseWireEvent({ type: "constructor" })).toEqual({ kind: "unknown", type: "constructor" });
    expect(parseWireEvent({ type: "__proto__" }).kind).toBe("unknown");
  });

  it.each([
    ["null", null],
    ["a string", "delta"],
    ["an array", []],
    ["no type", { text: "x" }],
    ["a numeric type", { type: 5 }],
  ])("rejects %s", (_name, raw) => {
    expect(parseWireEvent(raw).kind).toBe("invalid");
  });

  it.each([
    ["delta with numeric text", { type: "delta", text: 5 }],
    ["delta without text", { type: "delta" }],
    ["sources that is not an array", { type: "sources", sources: "x", relaxed: false }],
    ["sources without relaxed", { type: "sources", sources: [] }],
    ["a source missing text", { type: "sources", relaxed: false, sources: [{ ...source, text: undefined }] }],
    ["plan missing intent", { type: "plan", plan: { ...plan, intent: undefined }, droppedPropertyNames: [] }],
    ["plan without droppedPropertyNames", { type: "plan", plan }],
    ["declined with review_insight intent", { type: "declined", intent: "review_insight", message: "x" }],
    ["no_data without message", { type: "no_data" }],
    ["error without message", { type: "error" }],
    ["stats without an outcome", { type: "stats" }],
    ["stats with an unknown kind", { type: "stats", outcome: { ...statsMentions.outcome, kind: "median" } }],
    ["stats with a string count", { type: "stats", outcome: { ...statsMentions.outcome, result: { ...mentions, total: { count: "9", coverage } } } }],
  ])("rejects a known event with a bad payload: %s", (_name, raw) => {
    expect(parseWireEvent(raw).kind).toBe("invalid");
  });
});

describe("SourceWireSchema coverage", () => {
  const keys = ["n", "reviewId", "propertyName", "propertyType", "rating", "createdAt", "text", "score"];

  it("accepts a full Source", () => {
    expect(SourceWireSchema.safeParse(source).success).toBe(true);
  });

  it("rejects a Source with any required field removed", () => {
    for (const key of keys) {
      const rest: Partial<Source> = { ...source };
      delete rest[key as keyof Source];
      expect(SourceWireSchema.safeParse(rest).success, `without ${key}`).toBe(false);
    }
  });

  it("covers exactly the fields of Source (a new field must be added to the schema)", () => {
    expect(Object.keys(SourceWireSchema.shape).sort()).toEqual([...keys].sort());
    expect(Object.keys(source).sort()).toEqual([...keys].sort());
  });
});
