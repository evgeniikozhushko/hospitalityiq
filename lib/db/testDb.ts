/**
 * Helpers for integration tests that need the disposable Postgres instance.
 * Everything here goes through assertSafeTestDatabase first.
 */
import path from "node:path";
import { Client } from "pg";
import { dbUrls } from "./config";
import { runMigrations } from "./migrate";
import { setupRoles } from "./setup";
import { assertSafeTestDatabase } from "./testGuard";

export const READONLY_TEST_USER = "hiq_app_ro";
export const READONLY_TEST_PASSWORD = "hiq_test_readonly";

/** Load .env.local for DATABASE_URL_TEST when running under plain `vitest run`. */
function loadLocalEnv() {
  if (process.env.DATABASE_URL_TEST) return;
  try {
    process.loadEnvFile(path.join(process.cwd(), ".env.local"));
  } catch {
    /* no .env.local: tests will skip */
  }
}

/**
 * The safe test URL, or null when none is configured (tests skip with a hint).
 * A URL that is configured but unsafe throws: that must never be silently skipped.
 */
export function testDatabaseUrl(): string | null {
  loadLocalEnv();
  if (!dbUrls().test) return null;
  return assertSafeTestDatabase();
}

export function readonlyTestUrl(testUrl: string): string {
  const u = new URL(testUrl);
  u.username = READONLY_TEST_USER;
  u.password = READONLY_TEST_PASSWORD;
  return u.toString();
}

/** Wipe the test database, apply all migrations, and set up the read-only role. */
export async function resetTestDatabase(testUrl: string): Promise<void> {
  const url = assertSafeTestDatabase({ ...dbUrls(), test: testUrl });
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    await client.query("DROP SCHEMA IF EXISTS public CASCADE");
    await client.query("CREATE SCHEMA public");
    await runMigrations(client, path.join(process.cwd(), "db/migrations"));
  } finally {
    await client.end();
  }
  await setupRoles(url, readonlyTestUrl(url));
}
