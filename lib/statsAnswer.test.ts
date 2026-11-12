import { describe, expect, it } from "vitest";
import { tokenizeAnswer } from "./answerText";
import type { ThemeInfo } from "./route";
import {
  ComparisonError,
  StatsInputError,
  UnknownPropertyError,
  UnknownThemeError,
  type Coverage,
  type PropertyCount,
  type ThemeMentions,
  type ThemeRanking,
  type ThemeTrend,
} from "./reviewStats";
import { EMPTY_FILTERS, type QueryFilters } from "./schema";
import {
  MIN_TREND_MENTIONS,
  PROVISIONAL_CAVEAT,
  renderStats,
  statsFailure,
  STATS_UNAVAILABLE_NOTE,
} from "./statsAnswer";

const THEMES: ThemeInfo[] = [
  { slug: "parking", label: "Parking" },
  { slug: "front-desk", label: "Front desk" },
  { slug: "housekeeping", label: "Housekeeping" },
];
const ctx = { themes: THEMES, provisional: false };

const cov = (c: Partial<Coverage> = {}): Coverage => ({
  totalReviews: 8,
  textReviews: 8,
  currentTagged: 8,
  stale: 0,
  untagged: 0,
  ...c,
});

const row = (propertyName: string, count: number, c: Partial<Coverage> = {}): PropertyCount => ({
  propertyId: propertyName.length,
  propertyName,
  count,
  coverage: cov(c),
});

const mentionsResult = (m: Partial<ThemeMentions> = {}): ThemeMentions => ({
  theme: "parking",
  sentiment: null,
  scopeLabel: "All properties",
  rows: [row("Sample Mountain Lodge", 2)],
  total: { count: 2, coverage: cov() },
  ...m,
});

const mentions = (m: Partial<ThemeMentions> = {}, filters: Partial<QueryFilters> = {}) =>
  renderStats(
    {
      kind: "mentions",
      query: {
        kind: "mentions",
        theme: m.theme ?? "parking",
        sentiment: m.sentiment ?? null,
        filters: { ...EMPTY_FILTERS, ...filters },
      },
      result: mentionsResult(m),
    },
    ctx,
  );

describe("renderStats: mentions", () => {
  it("states the count against reviews with current tags, with the full coverage breakdown", () => {
    const text = mentions({
      total: { count: 2, coverage: cov({ totalReviews: 50, textReviews: 48, currentTagged: 8, stale: 3, untagged: 37 }) },
    });
    expect(text).toContain(
      "2 of 8 tagged reviews mention Parking (50 reviews in scope: 8 tagged, 3 with outdated tags, 37 not yet tagged, 2 rating-only).",
    );
  });

  it("says 'all tagged' when every review in scope has current tags", () => {
    expect(mentions()).toContain("2 of 8 tagged reviews mention Parking (8 reviews in scope, all tagged).");
  });

  it("agrees in number for a single review", () => {
    const text = mentions({ total: { count: 1, coverage: cov({ totalReviews: 1, textReviews: 1, currentTagged: 1 }) } });
    expect(text).toContain("1 of 1 tagged review mentions Parking (1 review in scope, all tagged).");
  });

  it("uses the glossary's words for sentiment", () => {
    expect(mentions({ sentiment: "negative" })).toContain("2 of 8 tagged reviews complain about Parking");
    expect(mentions({ sentiment: "positive" })).toContain("2 of 8 tagged reviews praise Parking");
    expect(mentions({ sentiment: "neutral" })).toContain("2 of 8 tagged reviews mention Parking neutrally");
    expect(mentions({ sentiment: "negative", total: { count: 1, coverage: cov() } })).toContain(
      "1 of 8 tagged reviews complains about Parking",
    );
  });

  it("gives no count when nothing in scope has current tags", () => {
    const text = mentions({
      total: { count: 0, coverage: cov({ totalReviews: 50, textReviews: 50, currentTagged: 0, untagged: 50 }) },
    });
    expect(text).toContain("None of the 50 reviews in scope are tagged yet, so I can't count Parking mentions.");
    expect(text).not.toMatch(/0 of 0/);
  });

  it("says so when there are no reviews in scope at all", () => {
    const text = mentions({ total: { count: 0, coverage: cov({ totalReviews: 0, textReviews: 0, currentTagged: 0 }) } });
    expect(text).toContain("There are no reviews in scope, so there is nothing to count.");
  });

  it("names the theme, the scope and the filters it counted", () => {
    const text = mentions(
      { scopeLabel: "All properties (BCP)" },
      { since: "2026-01-01", until: "2026-06-30", months: [12, 1, 2], minRating: 4, maxRating: 5, propertyTypes: ["hotel"] },
    );
    const header = text.split("\n")[0];
    expect(header).toBe(
      "**Parking mentions · All properties (BCP) · hotel properties · 2026-01-01 to 2026-06-30 · in Dec, Jan, Feb · rated 4–5 stars**",
    );
  });

  it("orders properties by count and shows each property's share of tagged reviews", () => {
    const text = mentions({
      rows: [
        row("Spa", 1, { totalReviews: 2, textReviews: 2, currentTagged: 2 }),
        row("Lodge", 12, { totalReviews: 320, textReviews: 300, currentTagged: 300 }),
        row("Bistro", 0, { totalReviews: 3, textReviews: 3, currentTagged: 0, untagged: 3 }),
      ],
      total: { count: 13, coverage: cov({ totalReviews: 325, textReviews: 305, currentTagged: 302, untagged: 3 }) },
    });
    const lines = text.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toEqual([
      "- Lodge: 12 of 300 tagged reviews (4%)",
      "- Spa: 1 of 2 tagged reviews (50%)",
      "- Bistro: no tagged reviews yet (3 in scope)",
    ]);
  });

  it("lists no rows for a single property", () => {
    expect(mentions().split("\n").some((l) => l.startsWith("- "))).toBe(false);
  });

  it("ends with the follow-up question for what guests say", () => {
    expect(mentions({ theme: "front-desk" })).toMatch(/For what guests say, ask: "What do guests say about front desk\?"$/);
  });

  it("adds the provisional caveat only when asked", () => {
    expect(mentions()).not.toContain(PROVISIONAL_CAVEAT);
    const text = renderStats(
      {
        kind: "mentions",
        query: { kind: "mentions", theme: "parking", sentiment: null, filters: EMPTY_FILTERS },
        result: mentionsResult(),
      },
      { ...ctx, provisional: true },
    );
    expect(text).toContain(PROVISIONAL_CAVEAT);
  });
});

describe("renderStats: ranking", () => {
  const ranking = (r: Partial<ThemeRanking> = {}) =>
    renderStats(
      {
        kind: "ranking",
        query: { kind: "ranking", sentiment: r.sentiment ?? null, filters: EMPTY_FILTERS },
        result: {
          sentiment: null,
          scopeLabel: "All properties",
          themes: [
            { theme: "front-desk", count: 3 },
            { theme: "parking", count: 1 },
          ],
          coverage: cov(),
          ...r,
        },
      },
      ctx,
    );

  it("lists themes by label with counts against tagged reviews, and says Other is not ranked", () => {
    const text = ranking();
    expect(text.split("\n")[0]).toBe("**Top themes · All properties**");
    expect(text).toContain("1. Front desk: 3 of 8 tagged reviews\n2. Parking: 1 of 8 tagged reviews");
    expect(text).toContain("Mentions outside the listed themes are not ranked.");
    expect(text).toContain("Counted over 8 tagged reviews (8 reviews in scope, all tagged).");
  });

  it("titles a complaint ranking as complaints", () => {
    expect(ranking({ sentiment: "negative" }).split("\n")[0]).toBe("**Top complaint themes · All properties**");
  });

  it("follows up on the top theme", () => {
    expect(ranking()).toMatch(/ask: "What do guests say about front desk\?"$/);
  });

  it("gives no ranking when nothing is tagged", () => {
    const text = ranking({ themes: [], coverage: cov({ currentTagged: 0, untagged: 8 }) });
    expect(text).toContain("None of the 8 reviews in scope are tagged yet, so I can't rank themes.");
    expect(text).not.toMatch(/ask:/);
  });

  it("says so when tagged reviews mention no listed theme", () => {
    expect(ranking({ themes: [] })).toContain("None of the 8 tagged reviews mention a listed theme.");
  });

  it("words an empty ranking by its sentiment, so praise is not reported as no mention", () => {
    // Tagged reviews praise Parking but contain no complaints: the complaint ranking is empty.
    const complaints = ranking({ sentiment: "negative", themes: [] });
    expect(complaints).toContain("None of the 8 tagged reviews complain about a listed theme.");
    expect(complaints).not.toMatch(/mention a listed theme/);
    expect(ranking({ sentiment: "positive", themes: [] })).toContain("None of the 8 tagged reviews praise a listed theme.");
    expect(ranking({ sentiment: "neutral", themes: [] })).toContain(
      "None of the 8 tagged reviews mention a listed theme neutrally.",
    );
  });

  it("agrees in number for an empty ranking over one tagged review", () => {
    expect(
      ranking({ sentiment: "negative", themes: [], coverage: cov({ totalReviews: 1, textReviews: 1, currentTagged: 1 }) }),
    ).toContain("None of the 1 tagged review complains about a listed theme.");
  });
});

describe("renderStats: trend", () => {
  const period = (since: string, until: string, count: number, c: Partial<Coverage> = {}) => ({
    ...mentionsResult({ theme: "front-desk", total: { count, coverage: cov(c) } }),
    window: { since, until },
  });
  const trend = (
    current: number,
    previous: number,
    percent: number | null = null,
    coverage: { current?: Partial<Coverage>; previous?: Partial<Coverage> } = {},
  ) => {
    const t: ThemeTrend = {
      theme: "front-desk",
      sentiment: null,
      current: period("2025-11-11", "2026-11-10", current, {
        totalReviews: 40,
        textReviews: 40,
        currentTagged: 40,
        ...coverage.current,
      }),
      previous: period("2024-11-11", "2025-11-10", previous, {
        totalReviews: 30,
        textReviews: 30,
        currentTagged: 25,
        untagged: 5,
        ...coverage.previous,
      }),
      change: { absolute: current - previous, percent },
    };
    return renderStats(
      {
        kind: "trend",
        query: {
          kind: "trend",
          theme: "front-desk",
          sentiment: null,
          filters: { ...EMPTY_FILTERS, since: "2025-11-11", until: "2026-11-10" },
        },
        result: t,
      },
      ctx,
    );
  };

  it("shows each period with its own window, count and coverage", () => {
    const text = trend(2, 0);
    expect(text.split("\n")[0]).toBe(
      "**Front desk mentions · All properties · 2025-11-11 to 2026-11-10 compared with 2024-11-11 to 2025-11-10**",
    );
    expect(text).toContain("2025-11-11 to 2026-11-10: 2 of 40 tagged reviews mention Front desk (40 reviews in scope, all tagged).");
    expect(text).toContain(
      "2024-11-11 to 2025-11-10: 0 of 25 tagged reviews mention Front desk (30 reviews in scope: 25 tagged, 5 not yet tagged).",
    );
  });

  it("refuses to show a change when either period has too few mentions", () => {
    expect(MIN_TREND_MENTIONS).toBe(10);
    for (const [cur, prev] of [[2, 0], [12, 9], [9, 12]]) {
      const text = trend(cur, prev, 50);
      expect(text).toContain("Too few mentions to show a reliable change.");
      expect(text).not.toMatch(/%/);
    }
  });

  it("shows the change and percent when both periods have enough mentions", () => {
    expect(trend(15, 10, 50)).toContain("Change: +5 mentions (+50%).");
    expect(trend(10, 15, -33.33)).toContain("Change: -5 mentions (-33%).");
    expect(trend(10, 10, 0)).toContain("Change: no change (0%).");
  });

  it("leaves out the follow-up when neither period has tagged reviews", () => {
    const untagged = { currentTagged: 0, untagged: 40 };
    const text = trend(0, 0, null, { current: untagged, previous: { ...untagged, totalReviews: 30, textReviews: 30, untagged: 30 } });
    expect(text).toContain("None of the 40 reviews in scope are tagged yet");
    expect(text).toContain("None of the 30 reviews in scope are tagged yet");
    expect(text).not.toMatch(/ask:/);
  });

  it("keeps the follow-up when either period has tagged reviews, even with zero mentions", () => {
    const none = { currentTagged: 0, untagged: 40 };
    expect(trend(0, 0, null, { current: none })).toMatch(/ask: "What do guests say about front desk\?"$/);
    expect(trend(0, 0, null, { previous: { currentTagged: 0, untagged: 30 } })).toMatch(/ask:/);
  });
});

describe("statsFailure", () => {
  it("turns input errors into fixed messages without retrieval", () => {
    expect(statsFailure(new UnknownPropertyError(["Moon Hotel"], ["Lodge", "Spa"]))).toEqual({
      kind: "input",
      message: "I don't know a property named Moon Hotel. Known properties: Lodge, Spa.",
    });
    expect(statsFailure(new ComparisonError("internal detail"))).toEqual({
      kind: "input",
      message: "To compare periods I need one continuous date range, for example \"over the last year\".",
    });
    for (const err of [new UnknownThemeError("internal detail"), new StatsInputError("since is after until.")]) {
      const f = statsFailure(err);
      expect(f.kind).toBe("input");
      expect(f.kind === "input" && f.message).not.toMatch(/internal detail|since is after/);
    }
  });

  it("treats anything else as infrastructure, never showing its message", () => {
    for (const err of [new Error("connect ECONNREFUSED 127.0.0.1:5433"), "boom", null]) {
      expect(statsFailure(err)).toEqual({ kind: "infrastructure", note: STATS_UNAVAILABLE_NOTE });
    }
    expect(STATS_UNAVAILABLE_NOTE).not.toMatch(/ECONNREFUSED/);
    expect(STATS_UNAVAILABLE_NOTE).toMatch(/sample of reviews/);
  });
});

describe("renderStats: layout", () => {
  const outcome = (coverage: Coverage) => ({
    kind: "mentions" as const,
    query: { kind: "mentions" as const, theme: "parking", sentiment: null, filters: EMPTY_FILTERS },
    result: mentionsResult({ total: { count: 2, coverage } }),
  });

  it("puts the caveat after the counts and before the follow-up", () => {
    const blocks = renderStats(outcome(cov()), { ...ctx, provisional: true }).split("\n\n");
    expect(blocks.at(-2)).toBe(PROVISIONAL_CAVEAT);
    expect(blocks.at(-1)).toMatch(/^For what guests say/);
  });

  it("ends with the caveat when there is no count to follow up", () => {
    const text = renderStats(outcome(cov({ currentTagged: 0, untagged: 8 })), { ...ctx, provisional: true });
    expect(text.split("\n\n").at(-1)).toBe(PROVISIONAL_CAVEAT);
    expect(text).not.toMatch(/ask:/);
  });

  it("renders as separate paragraphs and lists in the chat UI", () => {
    const text = renderStats(
      {
        ...outcome(cov()),
        result: mentionsResult({ rows: [row("Lodge", 2), row("Spa", 0)] }),
      },
      { ...ctx, provisional: true },
    );
    const blocks = tokenizeAnswer(text, [], { streaming: false });
    expect(blocks.map((b) => b.kind)).toEqual(["paragraph", "paragraph", "list", "paragraph", "paragraph"]);
    expect(blocks[0]).toEqual({
      kind: "paragraph",
      children: [{ kind: "bold", children: [{ kind: "text", text: "Parking mentions · All properties" }] }],
    });
  });
});
