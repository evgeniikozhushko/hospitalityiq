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
  compareToBaseline,
  missingText,
  pathOf,
  splitNote,
  type RunTrace,
} from "./evalMetrics";
import { FALLBACK_SUFFIX } from "./route";
import { STATS_UNAVAILABLE_NOTE } from "./statsAnswer";
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
  planRoute: "retrieval",
  statsKind: null,
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
  describe("pairs opening and closing quote marks (short quotes must not shift the pairing)", () => {
    const withWarm = [
      ...texts,
      "Front desk staff were warm and quick at check-in.",
      "Massage was excellent and the quiet room overlooking the valley was a highlight.",
    ];
    // A later quote is what used to close the shifted pair and flag the prose in between.
    const prose =
      " front desk staff, and family-friendly amenities like the pool and hot tub [1][6]. Spa guests liked the ";
    const tailStraight = '"quiet room overlooking the valley" [2].';
    const tailCurly = "\u201Cquiet room overlooking the valley\u201D [2].";

    it("does not flag the prose between a short and a long straight quote", () => {
      expect(
        unmatchedQuotes(`Guests praise the "stunning mountain views," "warm"${prose}${tailStraight}`, withWarm),
      ).toEqual([]);
    });
    it("does not flag the prose between a short and a long curly quote", () => {
      expect(
        unmatchedQuotes(`Guests praise the “stunning mountain views,” “warm”${prose}`, withWarm),
      ).toEqual([]);
    });
    it("still flags a long invented quote that follows a short one", () => {
      expect(
        unmatchedQuotes('"warm" front desk and "absolutely magical sunsets" [1]', withWarm),
      ).toEqual(["absolutely magical sunsets"]);
    });
    it("verifies only quotes of 8+ characters, but a short one never consumes the next pair", () => {
      expect(unmatchedQuotes('"warm" and "the hot tub" and "ok"', withWarm)).toEqual([]);
    });
    it("ignores a stray unbalanced quote mark", () => {
      expect(unmatchedQuotes('Guests say "the hot tub" and a stray " mark', withWarm)).toEqual([]);
    });
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

describe("pathOf: the path a question actually took", () => {
  const src = { n: 1, reviewId: "r", propertyName: "P", propertyType: "hotel" as const, rating: 5, createdAt: "", text: "", score: 1 };

  it("names each path by what was observed, not by the planner's label alone", () => {
    expect(pathOf(trace({ declinedIntent: "financial", planRoute: "statistics" }))).toBe("declined");
    expect(pathOf(trace({ planRoute: "statistics", statsKind: "mentions" }))).toBe("statistics");
    expect(pathOf(trace({ planRoute: "statistics", sources: [src] }))).toBe("fallback");
    expect(pathOf(trace({ planRoute: "statistics", noData: true }))).toBe("fallback");
    expect(pathOf(trace({ planRoute: "statistics", answer: "I don't know a property named X." }))).toBe("stats_message");
    expect(pathOf(trace({ planRoute: "retrieval", sources: [src] }))).toBe("retrieval");
    expect(pathOf(trace({ planRoute: null, noData: true }))).toBe("retrieval");
  });
});

describe("splitNote: code-written fallback note vs model text", () => {
  it("splits off a gate note and the unavailable note", () => {
    const gate = `I can only count broad themes (Food), not breakfast specifically. ${FALLBACK_SUFFIX}`;
    expect(splitNote(`${gate}\n\nModel says "hi" [1].`)).toEqual({ note: gate, modelText: 'Model says "hi" [1].' });
    expect(splitNote(`${STATS_UNAVAILABLE_NOTE}\n\nModel.`)).toEqual({ note: STATS_UNAVAILABLE_NOTE, modelText: "Model." });
  });

  it("leaves an answer without a note alone", () => {
    expect(splitNote("Plain answer.\n\nMore.")).toEqual({ note: null, modelText: "Plain answer.\n\nMore." });
  });
});

describe("missingText: exact numbers in the rendered answer", () => {
  it("lists the expected snippets that are absent", () => {
    const answer = "2 of 8 tagged reviews mention Food (9 reviews in scope: 8 tagged, 1 rating-only).";
    expect(missingText(answer, ["2 of 8 tagged reviews mention Food", "1 rating-only"])).toEqual([]);
    expect(missingText(answer, ["3 of 8 tagged reviews mention Food"])).toEqual(["3 of 8 tagged reviews mention Food"]);
    expect(missingText(answer, undefined)).toEqual([]);
  });
});

describe("compareToBaseline: the regression group, case by case", () => {
  const runs = (...passes: boolean[]) => passes.map((pass) => ({ pass }));

  it("passes a case only when every run passes, as the saved run did", () => {
    const c = compareToBaseline(
      { q01: runs(true, true, true), q02: runs(true, false, true), q05: runs(false, false, false) },
      { q01: runs(true, true, true), q02: runs(true, true, true), q05: runs(false, true, false) },
      ["q01", "q02", "q05"],
      ["q05"],
    );
    expect(c.passed).toEqual(["q01"]);
    expect(c.regressions).toEqual(["q02"]);
    expect(c.scored).toEqual(["q01", "q02"]);
    expect(c.separate).toEqual([{ id: "q05", now: false, before: false }]);
  });

  it("counts a case missing from the saved run as not comparable", () => {
    const c = compareToBaseline({ q30: runs(true) }, {}, ["q30"], []);
    expect(c.notInBaseline).toEqual(["q30"]);
    expect(c.scored).toEqual([]);
  });

  it("reports a fix as an improvement, not a regression", () => {
    const c = compareToBaseline({ q07: runs(true) }, { q07: runs(false) }, ["q07"], []);
    expect(c.improvements).toEqual(["q07"]);
    expect(c.regressions).toEqual([]);
  });
});
