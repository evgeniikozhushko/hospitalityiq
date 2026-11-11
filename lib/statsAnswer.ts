/**
 * Deterministic answer text for statistics (docs/routing-plan.md, decision 6, and
 * docs/adr/0001-counts-never-pass-through-the-model.md). Every number a user sees on
 * the statistics route is written here, by code; the model never states a count.
 * Pure: no database, no OpenAI.
 */
import type { Sentiment } from "./db/tags";
import {
  ComparisonError,
  StatsInputError,
  UnknownPropertyError,
  type Coverage,
  type DateWindow,
  type ThemeMentions,
  type ThemeRanking,
  type ThemeTrend,
} from "./reviewStats";
import type { StatsQuery, ThemeInfo } from "./route";
import type { QueryFilters } from "./schema";

/** Below this many mentions in either period, a trend shows no change or percent. */
export const MIN_TREND_MENTIONS = 10;

export const PROVISIONAL_CAVEAT =
  "Theme tags are provisional and may change once marketing has reviewed the theme list.";

export const STATS_UNAVAILABLE_NOTE =
  "Exact counts aren't available right now, so this answer is based on a sample of reviews.";

export type StatsOutcome =
  | { kind: "mentions"; query: Extract<StatsQuery, { kind: "mentions" }>; result: ThemeMentions }
  | { kind: "ranking"; query: Extract<StatsQuery, { kind: "ranking" }>; result: ThemeRanking }
  | { kind: "trend"; query: Extract<StatsQuery, { kind: "trend" }>; result: ThemeTrend };

export type RenderContext = { themes: ThemeInfo[]; provisional: boolean };

// ---------------------------------------------------------------------------
// Wording helpers
// ---------------------------------------------------------------------------

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);
const reviews = (n: number) => `${n} ${plural(n, "review", "reviews")}`;
const taggedReviews = (n: number) => `${n} tagged ${plural(n, "review", "reviews")}`;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const labelOf = (slug: string, themes: ThemeInfo[]) => themes.find((t) => t.slug === slug)?.label ?? slug;

/** "mention Parking", "complains about Parking", ... agreeing with the count. */
function verbPhrase(count: number, label: string, sentiment: Sentiment | null): string {
  const one = count === 1;
  switch (sentiment) {
    case "negative":
      return `${one ? "complains" : "complain"} about ${label}`;
    case "positive":
      return `${one ? "praises" : "praise"} ${label}`;
    case "neutral":
      return `${one ? "mentions" : "mention"} ${label} neutrally`;
    default:
      return `${one ? "mentions" : "mention"} ${label}`;
  }
}

function mentionsTitle(label: string, sentiment: Sentiment | null): string {
  switch (sentiment) {
    case "negative":
      return `${label} complaints`;
    case "positive":
      return `${label} praise`;
    case "neutral":
      return `Neutral ${label} mentions`;
    default:
      return `${label} mentions`;
  }
}

function rankingTitle(sentiment: Sentiment | null): string {
  switch (sentiment) {
    case "negative":
      return "Top complaint themes";
    case "positive":
      return "Top praise themes";
    case "neutral":
      return "Top themes (neutral mentions)";
    default:
      return "Top themes";
  }
}

const windowText = (w: DateWindow) => `${w.since} to ${w.until}`;

/** The filters, in words, for the header line. Dates are left out when `dates` is false. */
function filterParts(f: QueryFilters, dates: boolean): string[] {
  const parts: string[] = [];
  if (f.propertyTypes && f.propertyTypes.length > 0) parts.push(`${f.propertyTypes.join(", ")} properties`);
  if (dates) {
    if (f.since && f.until) parts.push(`${f.since} to ${f.until}`);
    else if (f.since) parts.push(`since ${f.since}`);
    else if (f.until) parts.push(`until ${f.until}`);
  }
  if (f.months && f.months.length > 0) parts.push(`in ${f.months.map((m) => MONTHS[m - 1] ?? String(m)).join(", ")}`);
  if (f.minRating != null || f.maxRating != null) {
    const lo = f.minRating ?? 1;
    const hi = f.maxRating ?? 5;
    parts.push(lo === hi ? `rated ${lo} ${plural(lo, "star", "stars")}` : `rated ${lo}–${hi} stars`);
  }
  return parts;
}

/** The bold first line naming what was counted, over which scope and filters. */
const header = (...parts: string[]) => `**${parts.filter(Boolean).join(" · ")}**`;

/** "(50 reviews in scope: 8 tagged, 3 with outdated tags, 37 not yet tagged, 2 rating-only)" */
function coverageText(c: Coverage): string {
  const ratingOnly = c.totalReviews - c.textReviews;
  if (c.currentTagged === c.totalReviews) return `(${reviews(c.totalReviews)} in scope, all tagged)`;
  const parts = [`${c.currentTagged} tagged`];
  if (c.stale > 0) parts.push(`${c.stale} with outdated tags`);
  if (c.untagged > 0) parts.push(`${c.untagged} not yet tagged`);
  if (ratingOnly > 0) parts.push(`${ratingOnly} rating-only`);
  return `(${reviews(c.totalReviews)} in scope: ${parts.join(", ")})`;
}

/** The count sentence, or why there is no count. Never "0 of 0". */
function countSentence(count: number, c: Coverage, label: string, sentiment: Sentiment | null, what: string): string {
  if (c.totalReviews === 0) return "There are no reviews in scope, so there is nothing to count.";
  if (c.currentTagged === 0) {
    return `None of the ${reviews(c.totalReviews)} in scope ${plural(c.totalReviews, "is", "are")} tagged yet, so I can't count ${what}.`;
  }
  return `${count} of ${taggedReviews(c.currentTagged)} ${verbPhrase(count, label, sentiment)} ${coverageText(c)}.`;
}

const followUp = (label: string) => `For what guests say, ask: "What do guests say about ${label.toLowerCase()}?"`;

const percent = (n: number) => `${Math.round(n)}%`;

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type Rendered = { blocks: string[]; followUp: string | null };

function renderMentions(o: Extract<StatsOutcome, { kind: "mentions" }>, ctx: RenderContext): Rendered {
  const r = o.result;
  const label = labelOf(r.theme, ctx.themes);
  const what = mentionsTitle(label, r.sentiment);
  const blocks = [
    header(what, r.scopeLabel, ...filterParts(o.query.filters, true)),
    countSentence(r.total.count, r.total.coverage, label, r.sentiment, what),
  ];
  if (r.rows.length > 1) {
    const rows = [...r.rows].sort((a, b) => b.count - a.count || a.propertyName.localeCompare(b.propertyName));
    blocks.push(
      rows
        .map((p) =>
          p.coverage.currentTagged === 0
            ? `- ${p.propertyName}: no tagged reviews yet (${p.coverage.totalReviews} in scope)`
            : `- ${p.propertyName}: ${p.count} of ${taggedReviews(p.coverage.currentTagged)} (${percent((p.count / p.coverage.currentTagged) * 100)})`,
        )
        .join("\n"),
    );
  }
  return { blocks, followUp: r.total.coverage.currentTagged > 0 ? followUp(label) : null };
}

function renderRanking(o: Extract<StatsOutcome, { kind: "ranking" }>, ctx: RenderContext): Rendered {
  const r = o.result;
  const c = r.coverage;
  const blocks = [header(rankingTitle(r.sentiment), r.scopeLabel, ...filterParts(o.query.filters, true))];
  if (c.totalReviews === 0) {
    return { blocks: [...blocks, "There are no reviews in scope, so there is nothing to rank."], followUp: null };
  }
  if (c.currentTagged === 0) {
    return {
      blocks: [
        ...blocks,
        `None of the ${reviews(c.totalReviews)} in scope ${plural(c.totalReviews, "is", "are")} tagged yet, so I can't rank themes.`,
      ],
      followUp: null,
    };
  }
  if (r.themes.length === 0) {
    blocks.push(`None of the ${taggedReviews(c.currentTagged)} mention a listed theme.`);
  } else {
    blocks.push(
      r.themes
        .map((t, i) => `${i + 1}. ${labelOf(t.theme, ctx.themes)}: ${t.count} of ${taggedReviews(c.currentTagged)}`)
        .join("\n"),
    );
  }
  blocks.push("Mentions outside the listed themes are not ranked.");
  blocks.push(`Counted over ${taggedReviews(c.currentTagged)} ${coverageText(c)}.`);
  return { blocks, followUp: r.themes.length > 0 ? followUp(labelOf(r.themes[0].theme, ctx.themes)) : null };
}

function renderTrend(o: Extract<StatsOutcome, { kind: "trend" }>, ctx: RenderContext): Rendered {
  const r = o.result;
  const label = labelOf(r.theme, ctx.themes);
  const what = mentionsTitle(label, r.sentiment);
  const periodLine = (p: ThemeTrend["current"]) =>
    `- ${windowText(p.window)}: ${countSentence(p.total.count, p.total.coverage, label, r.sentiment, what)}`;

  const blocks = [
    header(
      what,
      r.current.scopeLabel,
      ...filterParts(o.query.filters, false),
      `${windowText(r.current.window)} compared with ${windowText(r.previous.window)}`,
    ),
    `${periodLine(r.current)}\n${periodLine(r.previous)}`,
  ];

  const enough = r.current.total.count >= MIN_TREND_MENTIONS && r.previous.total.count >= MIN_TREND_MENTIONS;
  if (!enough || r.change.percent === null) {
    blocks.push("Too few mentions to show a reliable change.");
  } else if (r.change.absolute === 0) {
    blocks.push("Change: no change (0%).");
  } else {
    const sign = r.change.absolute > 0 ? "+" : "-";
    const abs = Math.abs(r.change.absolute);
    blocks.push(
      `Change: ${sign}${abs} ${plural(abs, "mention", "mentions")} (${sign}${percent(Math.abs(r.change.percent))}).`,
    );
  }
  return { blocks, followUp: followUp(label) };
}

/**
 * The full statistics answer. Blocks are separated by blank lines, because the answer
 * renderer (lib/answerText.ts) joins consecutive lines into one paragraph.
 * Order: header, counts, caveat, follow-up question.
 */
export function renderStats(outcome: StatsOutcome, ctx: RenderContext): string {
  const { blocks, followUp } =
    outcome.kind === "mentions"
      ? renderMentions(outcome, ctx)
      : outcome.kind === "ranking"
        ? renderRanking(outcome, ctx)
        : renderTrend(outcome, ctx);
  if (ctx.provisional) blocks.push(PROVISIONAL_CAVEAT);
  if (followUp) blocks.push(followUp);
  return blocks.join("\n\n");
}

// ---------------------------------------------------------------------------
// Failures
// ---------------------------------------------------------------------------

export type StatsFailure =
  /** A fixed message for the user; no retrieval fallback. */
  | { kind: "input"; message: string }
  /** Database missing, down or failing: fall back to retrieval with this note. */
  | { kind: "infrastructure"; note: string };

/** Map an error from the statistics path. Raw error text never reaches the user. */
export function statsFailure(err: unknown): StatsFailure {
  if (err instanceof UnknownPropertyError) {
    const names = err.unknown.join(", ");
    return {
      kind: "input",
      message: `I don't know a property named ${names}. Known properties: ${err.known.join(", ")}.`,
    };
  }
  if (err instanceof ComparisonError) {
    return {
      kind: "input",
      message: 'To compare periods I need one continuous date range, for example "over the last year".',
    };
  }
  if (err instanceof StatsInputError) {
    return {
      kind: "input",
      message: "I couldn't count that: the theme, dates or filters in the question aren't valid. Try rephrasing it.",
    };
  }
  return { kind: "infrastructure", note: STATS_UNAVAILABLE_NOTE };
}
