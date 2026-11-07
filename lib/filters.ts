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
 * Drop property names the planner invented: an unknown name would filter
 * everything out and produce a false "no data" answer. Matching ignores case
 * and maps to the canonical spelling.
 */
export function sanitizePlan(
  plan: QueryPlan,
  knownProperties: string[],
): { plan: QueryPlan; droppedPropertyNames: string[] } {
  const byLower = new Map(knownProperties.map((p) => [p.toLowerCase(), p]));
  const kept: string[] = [];
  const dropped: string[] = [];
  for (const n of plan.filters.propertyNames ?? []) {
    const canonical = byLower.get(n.trim().toLowerCase());
    if (canonical) kept.push(canonical);
    else dropped.push(n);
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
  };
}
