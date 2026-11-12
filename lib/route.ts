/**
 * The gate between the planner and SQL (docs/routing-plan.md, decision 2).
 * Pure: no database, no OpenAI. The planner suggests a route; this decides it.
 * It never guesses a nearest theme, and every fallback says the answer is a sample.
 */
import type { Sentiment } from "./db/tags";
import type { PlannerOutput, QueryFilters } from "./schema";

export type ThemeInfo = { slug: string; label: string };

/** A checked request for one of the fixed queries in lib/reviewStats.ts. */
export type StatsQuery =
  | { kind: "mentions"; theme: string; sentiment: Sentiment | null; filters: QueryFilters }
  | { kind: "ranking"; sentiment: Sentiment | null; filters: QueryFilters }
  /** filters.since and filters.until are always set. */
  | { kind: "trend"; theme: string; sentiment: Sentiment | null; filters: QueryFilters };

export type FallbackCode =
  | "no_kind"
  | "several_themes"
  | "not_a_theme"
  | "property_needs_theme"
  | "seasonal_trend"
  | "no_window";
export type Fallback = { code: FallbackCode; note: string };

export type RouteDecision =
  | { route: "statistics"; query: StatsQuery }
  /** fallback is null when the question was never a statistics question. */
  | { route: "retrieval"; fallback: Fallback | null };

/** The theme that holds mentions fitting no listed theme. Never counted on its own. */
export const OTHER_THEME = "other";

export const FALLBACK_SUFFIX = "This answer is based on a sample of reviews, not an exact count.";

const fallback = (code: FallbackCode, reason: string): RouteDecision => ({
  route: "retrieval",
  fallback: { code, note: `${reason} ${FALLBACK_SUFFIX}` },
});

const countable = (themes: ThemeInfo[]) => themes.filter((t) => t.slug !== OTHER_THEME);

export function resolveRoute(plan: PlannerOutput, knownThemes: ThemeInfo[], today: string): RouteDecision {
  if (plan.intent !== "review_insight" || plan.route !== "statistics") return { route: "retrieval", fallback: null };

  const stat = plan.stat;
  if (!stat?.kind) {
    return fallback("no_kind", "I couldn't tell what to count.");
  }
  const sentiment = stat.sentiment;
  const filters = plan.filters;

  // A ranking ranks themes. "Which property gets the most X" ranks properties: that is
  // a per-property count of one theme, never a theme ranking.
  const ranksProperties = stat.ranks === "properties";
  if (stat.kind === "ranking" && !ranksProperties) {
    return { route: "statistics", query: { kind: "ranking", sentiment, filters } };
  }

  const requested = [...new Set((stat.themes ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean))];
  if (requested.length > 1) {
    return fallback("several_themes", "I can count one theme at a time; try asking about each separately.");
  }

  if (ranksProperties && requested.length === 0) {
    return fallback(
      "property_needs_theme",
      'I can rank properties for one theme at a time, for example "which property gets the most parking complaints".',
    );
  }

  const labels = countable(knownThemes).map((t) => t.label);
  const theme = countable(knownThemes).find((t) => t.slug === requested[0]);
  if (!theme) {
    const topic = stat.topic?.trim();
    const listed = labels.length > 0 ? ` (${labels.join(", ")})` : "";
    return fallback(
      "not_a_theme",
      topic
        ? `I can only count broad themes${listed}, not ${topic} specifically.`
        : `I can only count broad themes${listed}.`,
    );
  }

  if (stat.kind === "mentions" || stat.kind === "ranking") {
    return { route: "statistics", query: { kind: "mentions", theme: theme.slug, sentiment, filters } };
  }

  // Trend. A seasonal filter has no single previous period, whatever the window.
  if (filters.months && filters.months.length > 0) {
    return fallback(
      "seasonal_trend",
      "I can't compare a season such as winter with a previous period; ask about one continuous date range instead.",
    );
  }
  if (!filters.since) {
    return fallback("no_window", 'Tell me which period to compare, for example "over the last year".');
  }
  return {
    route: "statistics",
    query: {
      kind: "trend",
      theme: theme.slug,
      sentiment,
      filters: { ...filters, until: filters.until ?? today },
    },
  };
}
