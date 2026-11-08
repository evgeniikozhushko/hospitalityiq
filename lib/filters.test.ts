import { describe, it, expect } from "vitest";
import {
  buildFilter,
  COMPANY_ALIASES,
  hasNonPropertyFilters,
  findCompanyAlias,
  isCompanyAlias,
  propertyOnly,
  sanitizePlan,
} from "./filters";
import { EMPTY_FILTERS, type QueryPlan } from "./schema";

const plan = (filters: Partial<QueryPlan["filters"]> = {}): QueryPlan => ({
  intent: "review_insight",
  mode: "specific",
  searchQuery: "cold rooms",
  filters: { ...EMPTY_FILTERS, ...filters },
});

describe("buildFilter", () => {
  it("returns undefined when no filters are set", () => {
    expect(buildFilter(EMPTY_FILTERS)).toBeUndefined();
  });

  it("treats empty arrays as no filter", () => {
    expect(buildFilter({ ...EMPTY_FILTERS, months: [], propertyTypes: [] })).toBeUndefined();
  });

  it("maps types, names and months to match.any", () => {
    expect(
      buildFilter({
        ...EMPTY_FILTERS,
        propertyTypes: ["hotel"],
        propertyNames: ["Sample Mountain Lodge"],
        months: [12, 1, 2],
      }),
    ).toEqual({
      must: [
        { key: "propertyType", match: { any: ["hotel"] } },
        { key: "propertyName", match: { any: ["Sample Mountain Lodge"] } },
        { key: "month", match: { any: [12, 1, 2] } },
      ],
    });
  });

  it("builds an open-ended rating range", () => {
    expect(buildFilter({ ...EMPTY_FILTERS, maxRating: 2 })).toEqual({
      must: [{ key: "rating", range: { gte: undefined, lte: 2 } }],
    });
  });

  it("makes date ranges inclusive of whole days", () => {
    expect(buildFilter({ ...EMPTY_FILTERS, since: "2025-11-01", until: "2026-10-31" })).toEqual({
      must: [
        {
          key: "createdAt",
          range: { gte: "2025-11-01T00:00:00Z", lte: "2026-10-31T23:59:59.999Z" },
        },
      ],
    });
  });
});

describe("hasNonPropertyFilters / propertyOnly", () => {
  it("ignores property filters", () => {
    expect(hasNonPropertyFilters({ ...EMPTY_FILTERS, propertyTypes: ["spa"] })).toBe(false);
    expect(hasNonPropertyFilters({ ...EMPTY_FILTERS, months: [1] })).toBe(true);
  });

  it("keeps only property filters", () => {
    expect(
      propertyOnly({ ...EMPTY_FILTERS, propertyTypes: ["spa"], minRating: 4, since: "2026-01-01" }),
    ).toEqual({ ...EMPTY_FILTERS, propertyTypes: ["spa"] });
  });
});

describe("sanitizePlan", () => {
  const known = ["Sample Mountain Lodge", "Sample Alpine Bistro"];

  it("keeps known names, canonicalizing case", () => {
    const { plan: p, droppedPropertyNames } = sanitizePlan(
      plan({ propertyNames: ["sample alpine bistro "] }),
      known,
    );
    expect(p.filters.propertyNames).toEqual(["Sample Alpine Bistro"]);
    expect(droppedPropertyNames).toEqual([]);
  });

  it("drops unknown names and reports them", () => {
    const { plan: p, droppedPropertyNames } = sanitizePlan(
      plan({ propertyNames: ["Grand Plaza", "Sample Mountain Lodge"] }),
      known,
    );
    expect(p.filters.propertyNames).toEqual(["Sample Mountain Lodge"]);
    expect(droppedPropertyNames).toEqual(["Grand Plaza"]);
  });

  it("removes the filter entirely when every name is unknown", () => {
    const { plan: p } = sanitizePlan(plan({ propertyNames: ["Grand Plaza"] }), known);
    expect(p.filters.propertyNames).toBeNull();
  });

  it("reports no portfolio alias for ordinary plans", () => {
    const { portfolioAlias } = sanitizePlan(plan({ propertyNames: ["Sample Alpine Bistro"] }), known);
    expect(portfolioAlias).toBeNull();
  });

  it("treats a company alias as the whole portfolio, not a dropped property", () => {
    const { plan: p, droppedPropertyNames, portfolioAlias } = sanitizePlan(
      plan({ propertyNames: ["BCP"] }),
      known,
    );
    expect(p.filters.propertyNames).toBeNull();
    expect(droppedPropertyNames).toEqual([]);
    expect(portfolioAlias).toBe("BCP");
  });

  it("keeps a real property and reports nothing dropped for [alias, known]", () => {
    const { plan: p, droppedPropertyNames } = sanitizePlan(
      plan({ propertyNames: ["BCP", "Sample Mountain Lodge"] }),
      known,
    );
    expect(p.filters.propertyNames).toEqual(["Sample Mountain Lodge"]);
    expect(droppedPropertyNames).toEqual([]);
  });

  it("searches all properties but still reports an unknown name for [alias, unknown]", () => {
    const { plan: p, droppedPropertyNames, portfolioAlias } = sanitizePlan(
      plan({ propertyNames: ["BCP", "Grand Lakeside Resort"] }),
      known,
    );
    expect(p.filters.propertyNames).toBeNull();
    expect(droppedPropertyNames).toEqual(["Grand Lakeside Resort"]);
    expect(portfolioAlias).toBe("BCP");
  });

  it("never drops a real property whose name starts like the company", () => {
    const withLodge = [...known, "Banff Caribou Lodge"];
    const { plan: p, droppedPropertyNames, portfolioAlias } = sanitizePlan(
      plan({ propertyNames: ["Banff Caribou Lodge"] }),
      withLodge,
    );
    expect(p.filters.propertyNames).toEqual(["Banff Caribou Lodge"]);
    expect(droppedPropertyNames).toEqual([]);
    expect(portfolioAlias).toBeNull();
  });

  it("does not swallow an unknown 'Banff Caribou ...' name (reports it as dropped)", () => {
    const { droppedPropertyNames, portfolioAlias } = sanitizePlan(
      plan({ propertyNames: ["Banff Caribou Lodge"] }),
      known,
    );
    expect(droppedPropertyNames).toEqual(["Banff Caribou Lodge"]);
    expect(portfolioAlias).toBeNull();
  });
});

describe("findCompanyAlias (whole words or phrases in free text)", () => {
  it.each([
    ["What do guests praise most at BCP?", "bcp"],
    ["what do guests praise across b.c.p.", "bcp"],
    ["How is BCP’s reputation?", "bcp"],
    ["How is BCP's reputation?", "bcp"],
    ["Summarize reviews for Banff Caribou Properties", "banff caribou properties"],
    ["summarize reviews for BANFF   CARIBOU\nPROPERTIES, please", "banff caribou properties"],
  ])("finds the alias in %j", (q, want) => {
    expect(findCompanyAlias(q)).toBe(want);
  });

  it.each([
    "What do guests say about Banff Caribou Lodge?",
    "Reviews for Banff Caribou",
    "What do guests say about the bcpx hotel?", // not a standalone word
    "abcp reviews",
    "What do guests say across all our properties?",
    "",
  ])("finds nothing in %j", (q) => {
    expect(findCompanyAlias(q)).toBeNull();
  });
});

describe("sanitizePlan with the question text", () => {
  const known = ["Sample Mountain Lodge", "Banff Caribou Lodge"];

  it("reports the portfolio scope when the question names the company but the planner returned no names", () => {
    const { portfolioAlias, droppedPropertyNames } = sanitizePlan(
      plan({ propertyNames: null }),
      known,
      "What do guests praise most across BCP?",
    );
    expect(portfolioAlias).toBe("bcp");
    expect(droppedPropertyNames).toEqual([]);
  });

  it("does not claim portfolio scope when a property filter is active", () => {
    const { plan: p, portfolioAlias } = sanitizePlan(
      plan({ propertyNames: ["Sample Mountain Lodge"] }),
      known,
      "BCP: what do guests say about Sample Mountain Lodge?",
    );
    expect(p.filters.propertyNames).toEqual(["Sample Mountain Lodge"]);
    expect(portfolioAlias).toBeNull();
  });

  it("does not trigger on Banff Caribou Lodge", () => {
    const { portfolioAlias } = sanitizePlan(
      plan({ propertyNames: ["Banff Caribou Lodge"] }),
      known,
      "What do guests say about Banff Caribou Lodge?",
    );
    expect(portfolioAlias).toBeNull();
  });

  it("does not claim portfolio scope when the alias is part of an unknown property name", () => {
    const { portfolioAlias, droppedPropertyNames } = sanitizePlan(
      plan({ propertyNames: ["BCP Lodge"] }),
      known,
      "What do guests say about BCP Lodge?",
    );
    expect(droppedPropertyNames).toEqual(["BCP Lodge"]);
    expect(portfolioAlias).toBeNull();
  });

  it("is unchanged when no question is passed", () => {
    expect(sanitizePlan(plan({ propertyNames: null }), known).portfolioAlias).toBeNull();
  });
});

describe("isCompanyAlias", () => {
  it.each([
    "BCP",
    "bcp",
    "  BCP  ",
    "B.C.P.",
    "BCP's", // straight apostrophe
    "BCP’s", // curly apostrophe
    "Banff Caribou Properties",
    "banff  caribou   properties",
    "Banff Caribou Properties Ltd",
    "Banff Caribou Properties, Inc.",
    "Banff Caribou Properties’ ", // trailing possessive on a plural
  ])("matches %j", (name) => {
    expect(isCompanyAlias(name)).toBe(true);
  });

  it.each([
    "Banff Caribou Lodge",
    "Banff Caribou",
    "Banff Caribou Properties Lodge",
    "BCP Lodge",
    "Sample Mountain Lodge",
    "",
    "   ",
    "Ltd",
  ])("does not match %j", (name) => {
    expect(isCompanyAlias(name)).toBe(false);
  });

  it("keeps the alias list lowercase and normalized", () => {
    for (const a of COMPANY_ALIASES) expect(a).toBe(a.toLowerCase().trim());
  });
});
