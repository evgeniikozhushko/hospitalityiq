/**
 * The app's read-only connection for statistics (docs/routing-plan.md, decision 7).
 * Built lazily from DATABASE_URL_READONLY and cached on globalThis, so Next dev
 * reloads reuse one pool instead of leaking connections. Returns null when the
 * variable is missing: the statistics route is then unavailable and questions fall
 * back to retrieval.
 */
import { Pool } from "pg";
import { dbUrls } from "./config";

const holder = globalThis as typeof globalThis & { __hiqReadonlyPool?: Pool };

export function readonlyPool(): Pool | null {
  if (holder.__hiqReadonlyPool) return holder.__hiqReadonlyPool;
  const url = dbUrls().readonly;
  if (!url) return null;
  const pool = new Pool({
    connectionString: url,
    max: 5,
    // Fail fast: a slow or missing database falls back to retrieval instead of hanging.
    connectionTimeoutMillis: 3_000,
    statement_timeout: 5_000,
    idleTimeoutMillis: 10_000,
  });
  // An idle client losing its connection must not crash the server; the next query
  // fails and falls back.
  pool.on("error", (err) => console.error("read-only pool error", err));
  holder.__hiqReadonlyPool = pool;
  return pool;
}

/** For scripts: let the process exit once the work is done. */
export async function closeReadonlyPool(): Promise<void> {
  const pool = holder.__hiqReadonlyPool;
  holder.__hiqReadonlyPool = undefined;
  await pool?.end();
}
