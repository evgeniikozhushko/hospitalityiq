/**
 * Integration tests truncate and insert freely, so they must never reach a real
 * database. A name like "hiq_test" is not proof of safety (a remote database can
 * carry it), so this checks the whole URL.
 */
import { dbUrls, type DbUrls } from "./config";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

function identity(url: string): string {
  const u = new URL(url);
  return `${u.hostname}:${u.port || "5432"}${u.pathname}`;
}

/**
 * Returns the test URL if it is safe to use, else throws. Rules:
 *  - DATABASE_URL_TEST must be set explicitly
 *  - it must not point at the same host/port/database as the admin or read-only URL
 *  - the host must be loopback, unless HIQ_ALLOW_REMOTE_TEST_DB=1
 *  - the database name must end in "_test"
 */
export function assertSafeTestDatabase(
  urls: DbUrls = dbUrls(),
  e: Record<string, string | undefined> = process.env,
): string {
  const test = urls.test;
  if (!test) throw new Error("DATABASE_URL_TEST is not set; refusing to run database tests.");
  let parsed: URL;
  try {
    parsed = new URL(test);
  } catch {
    throw new Error("DATABASE_URL_TEST is not a valid URL.");
  }
  for (const [label, other] of [
    ["DATABASE_URL_ADMIN", urls.admin],
    ["DATABASE_URL_READONLY", urls.readonly],
  ] as const) {
    if (other && identity(other) === identity(test)) {
      throw new Error(`DATABASE_URL_TEST points at the same database as ${label}; refusing.`);
    }
  }
  if (!LOOPBACK.has(parsed.hostname) && e.HIQ_ALLOW_REMOTE_TEST_DB !== "1") {
    throw new Error(
      `DATABASE_URL_TEST host "${parsed.hostname}" is not local; refusing (set HIQ_ALLOW_REMOTE_TEST_DB=1 to override on a disposable instance).`,
    );
  }
  if (!parsed.pathname.replace(/^\//, "").endsWith("_test")) {
    throw new Error('DATABASE_URL_TEST database name must end in "_test".');
  }
  return test;
}
