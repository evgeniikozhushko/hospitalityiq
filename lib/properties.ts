/**
 * The property names the planner may filter on: properties with at least one
 * searchable review. Read from Postgres (the source of truth), with the Qdrant index
 * as the fallback when no database is configured or it cannot be reached.
 *
 * Why not Qdrant alone, as before: every question starts here, so a Qdrant hiccup
 * failed count questions and declines that never touch Qdrant, and a list cached for
 * the life of the process hid newly ingested properties until a restart.
 *
 * Pure: both sources are passed in, so the rules below are tested without a database.
 *  - A non-empty list is cached for `ttlMs`. An empty list is never cached, so an app
 *    started before the first ingest picks the properties up on the next question.
 *  - If no source answers, the last good list is used; with none, an empty list. The
 *    question then fails or succeeds on its own path instead of here.
 *  - Names are sorted by code unit, the order the Qdrant list always had, so the
 *    planner prompt does not change with the source.
 */
import { INDEXABLE_SQL } from "./db/payload";

export type PropertySource = () => Promise<string[]>;

export type PropertyListerDeps = {
  /** Postgres. Null when no database is configured. */
  primary: PropertySource | null;
  /** The vector index. */
  fallback: PropertySource;
  ttlMs?: number;
  now?: () => number;
  /** Server-side only. */
  logError?: (message: string, err: unknown) => void;
};

export const PROPERTY_LIST_TTL_MS = 5 * 60_000;

const normalize = (names: string[]) => [...new Set(names)].sort();

export function createPropertyLister(deps: PropertyListerDeps): () => Promise<string[]> {
  const ttlMs = deps.ttlMs ?? PROPERTY_LIST_TTL_MS;
  const now = deps.now ?? Date.now;
  const logError = deps.logError ?? (() => {});
  let cached: { names: string[]; at: number } | null = null;
  let inFlight: Promise<string[]> | null = null;

  async function load(): Promise<string[]> {
    let answered = false;
    for (const [label, source] of [
      ["database", deps.primary],
      ["index", deps.fallback],
    ] as const) {
      if (!source) continue;
      try {
        const names = normalize(await source());
        answered = true;
        // An empty database does not prove there is nothing to search: ask the index too.
        if (names.length > 0) {
          cached = { names, at: now() };
          return names;
        }
      } catch (err) {
        logError(`property list unavailable from the ${label}`, err);
      }
    }
    // A source answered "none": believe it. Otherwise keep the last good list.
    if (answered) return [];
    return cached?.names ?? [];
  }

  return async () => {
    if (cached && now() - cached.at < ttlMs) return cached.names;
    // Questions arriving together share one lookup.
    inFlight ??= load().finally(() => {
      inFlight = null;
    });
    return inFlight;
  };
}

type Db = { query<R>(sql: string, params: unknown[]): Promise<{ rows: R[] }> };

/**
 * Properties with at least one searchable review of this source: exactly the reviews
 * the index holds (INDEXABLE_SQL), so both sources name the same properties. Limiting
 * to one source keeps the synthetic practice properties out of the planner prompt.
 */
export async function propertiesFromDb(db: Db, source: string): Promise<string[]> {
  const { rows } = await db.query<{ name: string }>(
    `SELECT p.name FROM properties p
     WHERE EXISTS (SELECT 1 FROM reviews r WHERE r.property_id = p.id AND r.source = $1 AND ${INDEXABLE_SQL})`,
    [source],
  );
  return rows.map((r) => r.name);
}
