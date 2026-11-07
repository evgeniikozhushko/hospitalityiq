import { describe, it, expect } from "vitest";
import { buildFilter, hasNonPropertyFilters, propertyOnly, sanitizePlan } from "./filters";
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
});
