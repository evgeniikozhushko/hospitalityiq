/**
 * Fixed, parameterized SQL for review statistics. The planner's filters
 * (QueryFilters) are inputs; SQL is never generated from a model. Run these on the
 * READ-ONLY connection.
 *
 * Rules (see docs/sql-plan.md):
 *  - "mentions" count DISTINCT reviews, never tag rows.
 *  - every call names ONE tag_source and ONE taxonomy_version; nothing is combined.
 *  - every result carries coverage, so untagged never reads as "no mention".
 *  - property names must match a canonical name exactly (case-insensitive); an unknown
 *    name is an error, never silently dropped or widened. A company alias such as BCP
 *    means all properties, but only when no specific property is named.
 *  - filters combine with AND. Windows are LOCAL dates in each property's timezone,
 *    half-open [since, until + 1 day), computed with AT TIME ZONE (daylight-saving safe).
 */
import type { Client } from "pg";
import { isCompanyAlias } from "./filters";
import type { QueryFilters } from "./schema";
import type { Sentiment, TagSource } from "./db/tags";

type Db = Pick<Client, "query">;

export class StatsInputError extends Error {}
export class UnknownPropertyError extends StatsInputError {
  constructor(
    public unknown: string[],
    public known: string[],
  ) {
    super(`Unknown property name(s): ${unknown.join(", ")}. Known properties: ${known.join(", ")}.`);
  }
}
export class UnknownThemeError extends StatsInputError {}
export class ComparisonError extends StatsInputError {}

export type StatsScope = {
  tagSource: TagSource;
  taxonomyVersion: string;
  filters: QueryFilters;
  /** Restrict to one review source (for example "google_business_profile"). */
  source?: string;
};

export type Coverage = {
  totalReviews: number;
  /** Rating-only reviews are in totalReviews but cannot be tagged. */
  textReviews: number;
  currentTagged: number;
  stale: number;
  untagged: number;
};

export type PropertyCount = { propertyId: number; propertyName: string; count: number; coverage: Coverage };

export type ThemeMentions = {
  theme: string;
  sentiment: Sentiment | null;
  /** "All properties", "All properties (BCP)" or the property names. */
  scopeLabel: string;
  rows: PropertyCount[];
  total: { count: number; coverage: Coverage };
};

export type ThemeRanking = {
  sentiment: Sentiment | null;
  scopeLabel: string;
  themes: Array<{ theme: string; count: number }>;
  coverage: Coverage;
};

export type DateWindow = { since: string; until: string };

export type ThemeTrend = {
  theme: string;
  sentiment: Sentiment | null;
  current: ThemeMentions & { window: DateWindow };
  previous: ThemeMentions & { window: DateWindow };
  change: { absolute: number; percent: number | null };
};

// ---------------------------------------------------------------------------
// Input handling
// ---------------------------------------------------------------------------

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function assertDate(label: string, value: string): void {
  const parsed = DATE_RE.test(value) ? new Date(`${value}T00:00:00Z`) : null;
  // Invalid dates are NaN; impossible days (Feb 30) roll over, so compare round-trip.
  const ok = parsed !== null && !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
  if (!ok) throw new StatsInputError(`${label} must be a valid YYYY-MM-DD date, got "${value}".`);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

/** The window of equal length immediately before [since, until] (inclusive dates). */
export function previousWindow(w: DateWindow): DateWindow {
  const length = daysBetween(w.since, w.until) + 1;
  return { since: addDays(w.since, -length), until: addDays(w.since, -1) };
}

type Resolved = { propertyIds: number[] | null; scopeLabel: string };

async function resolveProperties(db: Db, f: QueryFilters): Promise<Resolved> {
  const requested = (f.propertyNames ?? []).map((n) => n.trim()).filter(Boolean);
  if (requested.length === 0) return { propertyIds: null, scopeLabel: "All properties" };

  const { rows } = await db.query<{ id: string; name: string }>("SELECT id, name FROM properties ORDER BY name");
  const byLower = new Map(rows.map((r) => [r.name.toLowerCase(), r]));
  const kept: Array<{ id: string; name: string }> = [];
  const unknown: string[] = [];
  let alias: string | null = null;
  for (const n of requested) {
    const hit = byLower.get(n.toLowerCase());
    if (hit) kept.push(hit);
    else if (isCompanyAlias(n)) alias ??= n;
    else unknown.push(n);
  }
  if (unknown.length > 0) throw new UnknownPropertyError(unknown, rows.map((r) => r.name));
  if (kept.length > 0) {
    const unique = [...new Map(kept.map((k) => [k.id, k])).values()];
    return { propertyIds: unique.map((k) => Number(k.id)), scopeLabel: unique.map((k) => k.name).join(", ") };
  }
  // Only a company alias remains: explicitly all properties.
  return { propertyIds: null, scopeLabel: `All properties (${alias})` };
}

function validate(scope: StatsScope): void {
  if (!scope.taxonomyVersion?.trim()) throw new StatsInputError("taxonomyVersion is required.");
  if (scope.tagSource !== "manual" && scope.tagSource !== "llm") {
    throw new StatsInputError("tagSource must be 'manual' or 'llm'.");
  }
  const f = scope.filters;
  if (f.since) assertDate("since", f.since);
  if (f.until) assertDate("until", f.until);
  if (f.since && f.until && f.since > f.until) throw new StatsInputError("since is after until.");
  for (const m of f.months ?? []) {
    if (!Number.isInteger(m) || m < 1 || m > 12) throw new StatsInputError(`Invalid month: ${m}.`);
  }
}

async function requireTheme(db: Db, slug: string): Promise<void> {
  const { rows } = await db.query<{ slug: string }>("SELECT slug FROM themes ORDER BY slug");
  if (!rows.some((r) => r.slug === slug)) {
    throw new UnknownThemeError(`Unknown theme "${slug}". Themes: ${rows.map((r) => r.slug).join(", ")}.`);
  }
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/** $1..$10 are the shared scope parameters; queries append their own after these. */
function scopeParams(scope: StatsScope, r: Resolved): unknown[] {
  const f = scope.filters;
  const arr = <T>(x: T[] | null | undefined) => (x && x.length > 0 ? x : null);
  return [
    scope.source ?? null, // $1
    r.propertyIds, // $2
    arr(f.propertyTypes), // $3
    f.minRating, // $4
    f.maxRating, // $5
    f.since, // $6
    f.until, // $7
    arr(f.months), // $8
    scope.tagSource, // $9
    scope.taxonomyVersion, // $10
  ];
}

const SCOPE_CTES = `
  scope AS (
    SELECT r.id, r.property_id, r.has_text
    FROM reviews r JOIN properties p ON p.id = r.property_id
    WHERE r.deleted_at IS NULL
      AND ($1::text IS NULL OR r.source = $1)
      AND ($2::bigint[] IS NULL OR r.property_id = ANY($2))
      AND ($3::text[] IS NULL OR p.type = ANY($3))
      AND ($4::int IS NULL OR r.rating >= $4)
      AND ($5::int IS NULL OR r.rating <= $5)
      AND ($6::date IS NULL OR r.created_at >= (($6::date)::timestamp AT TIME ZONE p.timezone))
      AND ($7::date IS NULL OR r.created_at < ((($7::date + 1))::timestamp AT TIME ZONE p.timezone))
      AND ($8::int[] IS NULL OR EXTRACT(month FROM (r.created_at AT TIME ZONE p.timezone))::int = ANY($8))
  ),
  cov AS (
    SELECT s.property_id,
           count(*)::int AS total_reviews,
           count(*) FILTER (WHERE s.has_text)::int AS text_reviews,
           count(*) FILTER (WHERE s.has_text AND rt.review_id IS NOT NULL AND NOT rt.stale)::int AS current_tagged,
           count(*) FILTER (WHERE s.has_text AND rt.stale)::int AS stale,
           count(*) FILTER (WHERE s.has_text AND rt.review_id IS NULL)::int AS untagged
    FROM scope s
    LEFT JOIN review_tagging rt
           ON rt.review_id = s.id AND rt.tag_source = $9 AND rt.taxonomy_version = $10
    GROUP BY s.property_id
  )`;

type CovRow = {
  total_reviews: number;
  text_reviews: number;
  current_tagged: number;
  stale: number;
  untagged: number;
};

const toCoverage = (r: Partial<CovRow> | undefined): Coverage => ({
  totalReviews: r?.total_reviews ?? 0,
  textReviews: r?.text_reviews ?? 0,
  currentTagged: r?.current_tagged ?? 0,
  stale: r?.stale ?? 0,
  untagged: r?.untagged ?? 0,
});

const sumCoverage = (cs: Coverage[]): Coverage =>
  cs.reduce(
    (a, c) => ({
      totalReviews: a.totalReviews + c.totalReviews,
      textReviews: a.textReviews + c.textReviews,
      currentTagged: a.currentTagged + c.currentTagged,
      stale: a.stale + c.stale,
      untagged: a.untagged + c.untagged,
    }),
    { totalReviews: 0, textReviews: 0, currentTagged: 0, stale: 0, untagged: 0 },
  );

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

/** How many reviews mention a theme (optionally with one sentiment), per property. */
export async function themeMentions(
  db: Db,
  scope: StatsScope,
  opts: { theme: string; sentiment?: Sentiment | null },
): Promise<ThemeMentions> {
  validate(scope);
  await requireTheme(db, opts.theme);
  const resolved = await resolveProperties(db, scope.filters);
  const sentiment = opts.sentiment ?? null;

  const sql = `
    WITH ${SCOPE_CTES},
    mentions AS (
      SELECT s.property_id, count(DISTINCT th.review_id)::int AS n
      FROM scope s
      JOIN current_review_themes th
        ON th.review_id = s.id AND th.tag_source = $9 AND th.taxonomy_version = $10
      WHERE th.theme = $11 AND ($12::text IS NULL OR th.sentiment = $12)
      GROUP BY s.property_id
    )
    SELECT p.id::int AS property_id, p.name,
           coalesce(m.n, 0)::int AS n,
           c.total_reviews, c.text_reviews, c.current_tagged, c.stale, c.untagged
    FROM properties p
    LEFT JOIN cov c ON c.property_id = p.id
    LEFT JOIN mentions m ON m.property_id = p.id
    WHERE ($2::bigint[] IS NULL OR p.id = ANY($2))
      AND ($3::text[] IS NULL OR p.type = ANY($3))
      AND ($2::bigint[] IS NOT NULL OR c.property_id IS NOT NULL)
    ORDER BY p.name`;
  const { rows } = await db.query<CovRow & { property_id: number; name: string; n: number }>(sql, [
    ...scopeParams(scope, resolved),
    opts.theme,
    sentiment,
  ]);
  const out: PropertyCount[] = rows.map((r) => ({
    propertyId: r.property_id,
    propertyName: r.name,
    count: r.n,
    coverage: toCoverage(r),
  }));
  return {
    theme: opts.theme,
    sentiment,
    scopeLabel: resolved.scopeLabel,
    rows: out,
    total: { count: out.reduce((a, r) => a + r.count, 0), coverage: sumCoverage(out.map((r) => r.coverage)) },
  };
}

/** Top themes by distinct reviews, excluding "other". */
export async function themeRanking(
  db: Db,
  scope: StatsScope,
  opts: { sentiment?: Sentiment | null; limit?: number } = {},
): Promise<ThemeRanking> {
  validate(scope);
  const resolved = await resolveProperties(db, scope.filters);
  const sentiment = opts.sentiment ?? null;
  const limit = opts.limit ?? 5;
  if (!Number.isInteger(limit) || limit < 1) throw new StatsInputError("limit must be a positive integer.");

  const ranked = await db.query<{ theme: string; n: number }>(
    `WITH ${SCOPE_CTES}
     SELECT th.theme, count(DISTINCT th.review_id)::int AS n
     FROM scope s
     JOIN current_review_themes th
       ON th.review_id = s.id AND th.tag_source = $9 AND th.taxonomy_version = $10
     WHERE th.theme <> 'other' AND ($11::text IS NULL OR th.sentiment = $11)
     GROUP BY th.theme
     ORDER BY n DESC, th.theme
     LIMIT $12`,
    [...scopeParams(scope, resolved), sentiment, limit],
  );
  const cov = await db.query<CovRow>(
    `WITH ${SCOPE_CTES}
     SELECT coalesce(sum(total_reviews), 0)::int AS total_reviews,
            coalesce(sum(text_reviews), 0)::int AS text_reviews,
            coalesce(sum(current_tagged), 0)::int AS current_tagged,
            coalesce(sum(stale), 0)::int AS stale,
            coalesce(sum(untagged), 0)::int AS untagged
     FROM cov`,
    scopeParams(scope, resolved),
  );
  return {
    sentiment,
    scopeLabel: resolved.scopeLabel,
    themes: ranked.rows.map((r) => ({ theme: r.theme, count: r.n })),
    coverage: toCoverage(cov.rows[0]),
  };
}

/**
 * Current window vs the equal-length window immediately before it. Requires a
 * contiguous since..until window; a months filter is rejected because "winter"-style
 * sets have no single previous period.
 */
export async function themeTrend(
  db: Db,
  scope: StatsScope,
  opts: { theme: string; sentiment?: Sentiment | null },
): Promise<ThemeTrend> {
  const f = scope.filters;
  if (!f.since || !f.until) {
    throw new ComparisonError("A comparison needs a contiguous date window: give both since and until.");
  }
  if (f.months && f.months.length > 0) {
    throw new ComparisonError(
      "A comparison cannot use a months filter (for example 'winter'): it has no single previous period. Use a contiguous date range instead.",
    );
  }
  validate(scope);
  const window: DateWindow = { since: f.since, until: f.until };
  const prev = previousWindow(window);
  const run = async (w: DateWindow) => ({
    ...(await themeMentions(db, { ...scope, filters: { ...f, since: w.since, until: w.until } }, opts)),
    window: w,
  });
  const current = await run(window);
  const previous = await run(prev);
  const absolute = current.total.count - previous.total.count;
  return {
    theme: opts.theme,
    sentiment: opts.sentiment ?? null,
    current,
    previous,
    change: { absolute, percent: previous.total.count === 0 ? null : (absolute / previous.total.count) * 100 },
  };
}
