import { describe, it, expect } from "vitest";
import {
  checkCitations,
  checkTargets,
  citedNumbers,
  filterMismatches,
  forbiddenHits,
  kFor,
  leakedNames,
  mean,
  outcomeOf,
  recallAtK,
  reciprocalRank,
  sourcesCorrect,
  unmatchedQuotes,
  type RunTrace,
} from "./evalMetrics";
import { EMPTY_FILTERS } from "./schema";

const trace = (over: Partial<RunTrace>): RunTrace => ({
  intent: "review_insight",
  mode: "specific",
  filters: EMPTY_FILTERS,
  droppedPropertyNames: [],
  declinedIntent: null,
  noData: false,
  relaxed: false,
  sources: [],
  answer: "",
  ...over,
});

describe("recall / MRR", () => {
  it("recallAtK counts relevant ids inside the window", () => {
    expect(recallAtK(["a", "b", "c"], ["a", "c"], 5)).toBe(1);
    expect(recallAtK(["a", "b", "c"], ["a", "c"], 2)).toBe(0.5);
    expect(recallAtK([], ["a"], 5)).toBe(0);
  });
  it("is NaN when nothing is labelled", () => {
    expect(recallAtK(["a"], [], 5)).toBeNaN();
    expect(reciprocalRank(["a"], [])).toBeNaN();
  });
  it("reciprocalRank uses the first hit", () => {
    expect(reciprocalRank(["x", "b", "a"], ["a", "b"])).toBe(0.5);
    expect(reciprocalRank(["x", "y"], ["a"])).toBe(0);
  });
  it("aggregate mode scores the whole retrieved set", () => {
    const ids = ["1", "2", "3", "4", "5", "6", "7"];
    expect(sourcesCorrect(ids, ["7"], kFor("specific"))).toBe(false);
    expect(sourcesCorrect(ids, ["7"], kFor("aggregate"))).toBe(true);
  });
});

describe("outcomeOf", () => {
  it("separates declined, no_data and answered", () => {
    expect(outcomeOf(trace({ declinedIntent: "financial" }))).toBe("declined_financial");
    expect(outcomeOf(trace({ noData: true }))).toBe("no_data");
    expect(outcomeOf(trace({}))).toBe("answered");
  });
});

describe("filterMismatches", () => {
  const actual = { ...EMPTY_FILTERS, months: [12, 1, 2], maxRating: 2, since: "2025-11-07" };
  it("ignores keys the dataset does not specify", () => {
    expect(filterMismatches(actual, { maxRating: 2 })).toEqual([]);
  });
  it("compares arrays as sets", () => {
    expect(filterMismatches(actual, { months: [1, 2, 12] })).toEqual([]);
    expect(filterMismatches(actual, { months: [1, 2] })).toEqual(["months"]);
  });
  it("flags scalar mismatches and missing filters", () => {
    expect(filterMismatches(actual, { maxRating: 1, until: "2026-01-01" })).toEqual([
      "maxRating",
      "until",
    ]);
    expect(filterMismatches(null, { maxRating: 2 })).toEqual(["maxRating"]);
  });
});

describe("citations", () => {
  it("parses adjacent citations", () => {
    expect(citedNumbers("Cold [2][4]. Warm [1].")).toEqual([2, 4, 1]);
  });
  it("flags numbers with no matching source", () => {
    expect(checkCitations("a [1] b [5] c [0]", 3, true).invalid).toEqual([5, 0]);
  });
  it("flags answers that cite nothing when sources exist", () => {
    expect(checkCitations("No cites", 3, true).missing).toBe(true);
    expect(checkCitations("No cites", 3, false).missing).toBe(false);
    expect(checkCitations("No cites", 0, true).missing).toBe(false);
  });
});

describe("quotes, names, forbidden text", () => {
  const texts = ["Stunning mountain views from our room and the hot tub."];
  it("accepts verbatim quotes, including curly quotes and trailing punctuation", () => {
    expect(unmatchedQuotes('Guests say "Stunning mountain views" [1].', texts)).toEqual([]);
    expect(unmatchedQuotes("Guests say “the hot tub.” [1]", texts)).toEqual([]);
  });
  it("ignores markdown emphasis and checks ellipsis fragments separately", () => {
    expect(unmatchedQuotes('Guests love \u201C**Stunning mountain views**\u201D [1]', texts)).toEqual([]);
    expect(unmatchedQuotes('"Stunning mountain views\u2026 the hot tub" [1]', texts)).toEqual([]);
    expect(unmatchedQuotes('"Stunning mountain views... free champagne" [1]', texts)).toEqual([
      "free champagne",
    ]);
  });
  it("treats bracketed editorial insertions as fragment breaks", () => {
    expect(unmatchedQuotes('"Stunning mountain views [that] the hot tub" [1]', texts)).toEqual([]);
  });
  it("ignores phrases echoed from the question", () => {
    expect(
      unmatchedQuotes('The "most complaints" go to X [1]', texts, "Which property gets the most complaints?"),
    ).toEqual([]);
  });
  it("flags invented quotes", () => {
    expect(unmatchedQuotes('They said "absolutely magical sunsets" [1]', texts)).toEqual([
      "absolutely magical sunsets",
    ]);
  });
  it("detects leaked reviewer names and forbidden strings", () => {
    expect(leakedNames("Jane Fixture loved it", ["Jane Fixture", "Test Guest"])).toEqual([
      "Jane Fixture",
    ]);
    expect(forbiddenHits("PWNED", ["PWNED", "You are HospitalityIQ"])).toEqual(["PWNED"]);
    expect(forbiddenHits("fine", undefined)).toEqual([]);
  });
});

describe("targets", () => {
  it("passes at the thresholds", () => {
    const r = checkTargets([1, 1, 1, 1, 0], [true, true, true, true, false]);
    expect(r.every((x) => x.pass)).toBe(true);
  });
  it("fails below them", () => {
    const r = checkTargets([1, 0], [true, false]);
    expect(r.every((x) => !x.pass)).toBe(true);
  });
  it("fails when nothing was measured", () => {
    expect(checkTargets([], []).every((x) => !x.pass)).toBe(true);
  });
  it("mean skips NaN", () => {
    expect(mean([1, NaN, 0])).toBe(0.5);
  });
});
