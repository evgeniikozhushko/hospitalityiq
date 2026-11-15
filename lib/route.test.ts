import { describe, expect, it } from "vitest";
import { FALLBACK_SUFFIX, resolveRoute, type ThemeInfo } from "./route";
import { EMPTY_FILTERS, type PlannerOutput, type QueryFilters, type StatRequest } from "./schema";

const THEMES: ThemeInfo[] = [
  { slug: "housekeeping", label: "Housekeeping" },
  { slug: "front-desk", label: "Front desk" },
  { slug: "food", label: "Food" },
  { slug: "parking", label: "Parking" },
  { slug: "other", label: "Other" },
];
const TODAY = "2026-11-10";

const stat = (s: Partial<StatRequest> = {}): StatRequest => ({
  kind: "mentions",
  themes: ["parking"],
  topic: "parking",
  sentiment: null,
  ranks: null,
  ...s,
});

const plan = (
  p: Partial<Omit<PlannerOutput, "filters">> = {},
  filters: Partial<QueryFilters> = {},
): PlannerOutput => ({
  intent: "review_insight",
  mode: "aggregate",
  searchQuery: "parking",
  filters: { ...EMPTY_FILTERS, ...filters },
  route: "statistics",
  stat: stat(),
  ...p,
});

const fallbackOf = (p: PlannerOutput) => {
  const d = resolveRoute(p, THEMES, TODAY);
  if (d.route !== "retrieval" || !d.fallback) throw new Error(`expected a fallback, got ${JSON.stringify(d)}`);
  return d.fallback;
};

describe("resolveRoute: when statistics is not involved", () => {
  it("never uses statistics for a non-review intent, whatever the route says", () => {
    for (const intent of ["campaign", "financial", "off_topic"] as const) {
      expect(resolveRoute(plan({ intent }), THEMES, TODAY)).toEqual({ route: "retrieval", fallback: null });
    }
  });

  it("keeps a retrieval plan on retrieval with no note", () => {
    expect(resolveRoute(plan({ route: "retrieval" }), THEMES, TODAY)).toEqual({ route: "retrieval", fallback: null });
  });
});

describe("resolveRoute: statistics", () => {
  it("routes a mentions question with its theme, sentiment and filters", () => {
    const d = resolveRoute(
      plan({ stat: stat({ themes: ["housekeeping"], sentiment: "negative" }) }, { propertyNames: ["Lodge"] }),
      THEMES,
      TODAY,
    );
    expect(d).toEqual({
      route: "statistics",
      query: {
        kind: "mentions",
        theme: "housekeeping",
        sentiment: "negative",
        filters: { ...EMPTY_FILTERS, propertyNames: ["Lodge"] },
      },
    });
  });

  it("leaves an open-ended mentions window open (no until is added)", () => {
    const d = resolveRoute(plan({}, { since: "2026-01-01" }), THEMES, TODAY);
    expect(d.route === "statistics" && d.query.filters.until).toBeNull();
  });

  it("routes a ranking without a theme, ignoring any themes", () => {
    const d = resolveRoute(
      plan({ stat: stat({ kind: "ranking", themes: null, topic: null, sentiment: "negative" }) }),
      THEMES,
      TODAY,
    );
    expect(d).toEqual({
      route: "statistics",
      query: { kind: "ranking", sentiment: "negative", filters: EMPTY_FILTERS },
    });
  });

  it("fills a trend's missing until with today", () => {
    const d = resolveRoute(
      plan({ stat: stat({ kind: "trend", themes: ["front-desk"] }) }, { since: "2025-11-10" }),
      THEMES,
      TODAY,
    );
    expect(d).toEqual({
      route: "statistics",
      query: {
        kind: "trend",
        theme: "front-desk",
        sentiment: null,
        filters: { ...EMPTY_FILTERS, since: "2025-11-10", until: TODAY },
      },
    });
  });

  it("keeps a trend's explicit until", () => {
    const d = resolveRoute(
      plan({ stat: stat({ kind: "trend" }) }, { since: "2025-01-01", until: "2025-06-30" }),
      THEMES,
      TODAY,
    );
    expect(d.route === "statistics" && d.query.filters.until).toBe("2025-06-30");
  });

  it("treats theme slugs case-insensitively and trims them", () => {
    const d = resolveRoute(plan({ stat: stat({ themes: [" Parking "] }) }), THEMES, TODAY);
    expect(d.route === "statistics" && d.query.kind === "mentions" && d.query.theme).toBe("parking");
  });
});

describe("resolveRoute: what a ranking ranks", () => {
  it("ranks themes when the planner says so", () => {
    const d = resolveRoute(plan({ stat: stat({ kind: "ranking", themes: null, ranks: "themes" }) }), THEMES, TODAY);
    expect(d.route === "statistics" && d.query.kind).toBe("ranking");
  });

  it("turns a property ranking for one theme into a per-property count", () => {
    const d = resolveRoute(
      plan({ stat: stat({ kind: "ranking", themes: ["housekeeping"], ranks: "properties", sentiment: "negative" }) }),
      THEMES,
      TODAY,
    );
    expect(d).toEqual({
      route: "statistics",
      query: { kind: "mentions", theme: "housekeeping", sentiment: "negative", filters: EMPTY_FILTERS },
    });
  });

  it("never answers a property question with a theme ranking", () => {
    // "Which property gets the most complaints?": the planner may say ranking or mentions.
    for (const kind of ["ranking", "mentions"] as const) {
      const f = fallbackOf(plan({ stat: stat({ kind, themes: [], topic: "complaints", ranks: "properties", sentiment: "negative" }) }));
      expect(f.code).toBe("property_needs_theme");
      expect(f.note).toMatch(/one theme at a time, for example "which property gets the most parking complaints"/);
    }
  });
});

describe("resolveRoute: honest fallbacks", () => {
  it("every fallback says the answer is a sample, not a count", () => {
    const f = fallbackOf(plan({ stat: stat({ themes: [], topic: "breakfast" }) }));
    expect(f.note.endsWith(FALLBACK_SUFFIX)).toBe(true);
    expect(FALLBACK_SUFFIX).toMatch(/sample of reviews, not an exact count/);
  });

  it("refuses more than one theme, before checking whether they are themes", () => {
    const f = fallbackOf(plan({ stat: stat({ themes: ["parking", "breakfast"], topic: "parking or breakfast" }) }));
    expect(f.code).toBe("several_themes");
    expect(f.note).toMatch(/one theme at a time/);
  });

  it("does not count a duplicated theme as two themes", () => {
    const d = resolveRoute(plan({ stat: stat({ themes: ["parking", "Parking"] }) }), THEMES, TODAY);
    expect(d.route).toBe("statistics");
  });

  it("names the user's topic when it is narrower than a theme", () => {
    const f = fallbackOf(plan({ stat: stat({ themes: [], topic: "breakfast" }) }));
    expect(f.code).toBe("not_a_theme");
    expect(f.note).toMatch(/not breakfast specifically/);
    expect(f.note).toMatch(/Housekeeping, Front desk, Food, Parking/);
    expect(f.note).not.toMatch(/Other/);
  });

  it("gives a generic note when the topic is unknown", () => {
    const f = fallbackOf(plan({ stat: stat({ themes: null, topic: null }) }));
    expect(f.code).toBe("not_a_theme");
    expect(f.note).not.toMatch(/specifically/);
    expect(f.note).toMatch(/Housekeeping, Front desk, Food, Parking/);
  });

  it("never counts an unknown theme or Other", () => {
    for (const themes of [["thermal-pool"], ["other"]]) {
      expect(fallbackOf(plan({ stat: stat({ themes, topic: "the thermal pool" }) })).code).toBe("not_a_theme");
    }
  });

  it("falls back when the planner chose statistics but gave no kind", () => {
    expect(fallbackOf(plan({ stat: null })).code).toBe("no_kind");
    expect(fallbackOf(plan({ stat: stat({ kind: null }) })).code).toBe("no_kind");
  });

  it("asks for a period when a trend has no window", () => {
    const f = fallbackOf(plan({ stat: stat({ kind: "trend" }) }));
    expect(f.code).toBe("no_window");
    expect(f.note).toMatch(/period/);
  });

  it("asks for a period when a trend has an end but no start", () => {
    expect(fallbackOf(plan({ stat: stat({ kind: "trend" }) }, { until: "2026-06-30" })).code).toBe("no_window");
  });

  it("refuses a seasonal trend, even when it has a window", () => {
    for (const filters of [{ months: [12, 1, 2] }, { months: [12, 1, 2], since: "2024-01-01" }]) {
      const f = fallbackOf(plan({ stat: stat({ kind: "trend" }) }, filters));
      expect(f.code).toBe("seasonal_trend");
    }
  });

  it("allows a months filter on a plain count", () => {
    expect(resolveRoute(plan({}, { months: [12, 1, 2] }), THEMES, TODAY).route).toBe("statistics");
  });
});
