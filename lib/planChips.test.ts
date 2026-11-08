import { describe, expect, it } from "vitest";
import { planChips } from "./planChips";
import { EMPTY_FILTERS } from "./schema";

describe("planChips", () => {
  it("returns no chips for empty filters", () => {
    expect(planChips(EMPTY_FILTERS)).toEqual([]);
  });

  it("describes ratings", () => {
    expect(planChips({ ...EMPTY_FILTERS, minRating: 4 })).toEqual(["Rating: 4★ and up"]);
    expect(planChips({ ...EMPTY_FILTERS, maxRating: 2 })).toEqual(["Rating: 2★ and below"]);
    expect(planChips({ ...EMPTY_FILTERS, minRating: 1, maxRating: 2 })).toEqual(["Rating: 1–2★"]);
    expect(planChips({ ...EMPTY_FILTERS, minRating: 3, maxRating: 3 })).toEqual(["Rating: 3★"]);
  });

  it("describes properties, months and dates", () => {
    expect(
      planChips({
        ...EMPTY_FILTERS,
        propertyTypes: ["hotel"],
        propertyNames: ["Banff Caribou Lodge"],
        months: [12, 1],
        since: "2025-01-01",
        until: "2025-06-30",
      }),
    ).toEqual([
      "Property type: hotel",
      "Property: Banff Caribou Lodge",
      "Months: Dec, Jan",
      "Since 2025-01-01",
      "Until 2025-06-30",
    ]);
  });

  it("ignores out-of-range months", () => {
    expect(planChips({ ...EMPTY_FILTERS, months: [13] })).toEqual([]);
  });
});
