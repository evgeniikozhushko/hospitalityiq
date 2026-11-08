/**
 * Pure helpers that turn planner output into Qdrant filters.
 * No env or client imports, so they are cheap to unit-test.
 */
import type { Schemas } from "@qdrant/js-client-rest";
import type { QueryFilters, QueryPlan } from "./schema";

type Filter = Schemas["Filter"];
type Condition = Schemas["FieldCondition"];

const nonEmpty = <T>(xs: T[] | null | undefined): xs is T[] => !!xs && xs.length > 0;

/** Convert extracted filters to a Qdrant filter, or undefined when there are none. */
export function buildFilter(f: QueryFilters): Filter | undefined {
  const must: Condition[] = [];

  if (nonEmpty(f.propertyTypes)) {
    must.push({ key: "propertyType", match: { any: f.propertyTypes } });
  }
  if (nonEmpty(f.propertyNames)) {
    must.push({ key: "propertyName", match: { any: f.propertyNames } });
  }
  if (f.minRating != null || f.maxRating != null) {
    must.push({
      key: "rating",
      range: { gte: f.minRating ?? undefined, lte: f.maxRating ?? undefined },
    });
  }
  if (nonEmpty(f.months)) {
    must.push({ key: "month", match: { any: f.months } });
  }
  if (f.since || f.until) {
    must.push({
      key: "createdAt",
      range: {
        gte: f.since ? `${f.since}T00:00:00Z` : undefined,
        lte: f.until ? `${f.until}T23:59:59.999Z` : undefined,
      },
    });
  }

  return must.length > 0 ? { must } : undefined;
}

/** True when filters other than property type/name are set (rating, months, dates). */
export function hasNonPropertyFilters(f: QueryFilters): boolean {
  return (
    f.minRating != null ||
    f.maxRating != null ||
    nonEmpty(f.months) ||
    !!f.since ||
    !!f.until
  );
}

/** Keep only the property filters; used for the one-time relaxed retry. */
export function propertyOnly(f: QueryFilters): QueryFilters {
  return {
    propertyTypes: f.propertyTypes,
    propertyNames: f.propertyNames,
    minRating: null,
    maxRating: null,
    months: null,
    since: null,
    until: null,
  };
}

/**
 * Names that mean "the whole company", not one property (the parent owns the
 * properties but has no reviews of its own). Normalized form: lowercase, no
 * punctuation. Matched against whole names only, see isCompanyAlias.
 */
export const COMPANY_ALIASES: ReadonlySet<string> = new Set([
  "bcp",
  "banff caribou properties",
]);

const CORPORATE_SUFFIXES = new Set(["ltd", "inc", "llc", "corp"]);

/** Lowercase, drop a trailing possessive and punctuation, collapse spaces, drop a trailing "Ltd"/"Inc". */
function normalizeName(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    // Possessive first (straight or curly), or "BCP's" would become "bcps".
    .replace(/['’]s?$/, "")
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
  const words = base.split(" ");
  while (words.length > 1 && CORPORATE_SUFFIXES.has(words[words.length - 1])) words.pop();
  return words.join(" ");
}

/**
 * True only when the whole normalized name equals an alias. Never a substring
 * match: "Banff Caribou Lodge" is a real property and must not be swallowed.
 */
export function isCompanyAlias(name: string): boolean {
  const n = normalizeName(name);
  return n !== "" && COMPANY_ALIASES.has(n);
}

/**
 * Find a company alias written in free text (the user's question). Whole words or
 * phrases only: "bcp" matches as a standalone word, "banff caribou properties"
 * as a full phrase, and "Banff Caribou Lodge" or "bcpx" match nothing.
 * Returns the normalized alias, or null.
 */
export function findCompanyAlias(text: string): string | null {
  const words = ` ${text
    .toLowerCase()
    .replace(/['’]s\b/g, "") // possessive before punctuation, or "BCP's" -> "bcps"
    .replace(/[.'’]/g, "") // B.C.P. -> bcp
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()} `;
  for (const alias of COMPANY_ALIASES) {
    if (words.includes(` ${alias} `)) return alias;
  }
  return null;
}

/**
 * Clean the planner's property names before they become a Qdrant filter.
 * - Known names are kept, mapped to the canonical spelling (case-insensitive).
 *   A known name always wins, even if it looks like an alias.
 * - A company alias (BCP) means the whole portfolio: it is not a property, so it
 *   is not "dropped". If no specific property remains, `portfolioAlias` reports it
 *   so the answer can say it searched all properties.
 * - Anything else is an invented/unknown name: dropped, because it would filter
 *   everything out and produce a false "no data" answer.
 *
 * With `question`, the portfolio scope is also detected from the question text, so
 * it does not depend on whether the planner or this function handled the alias.
 * It only applies when no property filter remains and the alias is not part of a
 * dropped name (so "BCP Lodge" never counts as portfolio-wide).
 */
export function sanitizePlan(
  plan: QueryPlan,
  knownProperties: string[],
  question?: string,
): { plan: QueryPlan; droppedPropertyNames: string[]; portfolioAlias: string | null } {
  const byLower = new Map(knownProperties.map((p) => [p.toLowerCase(), p]));
  const kept: string[] = [];
  const dropped: string[] = [];
  let alias: string | null = null;
  for (const n of plan.filters.propertyNames ?? []) {
    const canonical = byLower.get(n.trim().toLowerCase());
    if (canonical) kept.push(canonical);
    else if (isCompanyAlias(n)) alias ??= n.trim();
    else dropped.push(n);
  }

  if (kept.length === 0 && !alias && question && !dropped.some((d) => findCompanyAlias(d))) {
    alias = findCompanyAlias(question);
  }

  return {
    plan: {
      ...plan,
      filters: {
        ...plan.filters,
        propertyNames: kept.length > 0 ? [...new Set(kept)] : null,
      },
    },
    droppedPropertyNames: dropped,
    // Only when no specific property remains; otherwise the search is not portfolio-wide.
    portfolioAlias: kept.length === 0 ? alias : null,
  };
}
