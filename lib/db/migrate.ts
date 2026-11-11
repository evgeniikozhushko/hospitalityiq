/**
 * Plain-SQL migration runner. Files in db/migrations apply in filename order,
 * one transaction each; filename + checksum are recorded in schema_migrations.
 * An already-applied file that changed is an error, and an advisory lock stops
 * two runners from migrating at once.
 */
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";

export type MigrationFile = { name: string; sql: string };

// Arbitrary constant identifying "hospitalityiq migrations" for pg_advisory_lock.
const LOCK_KEY = 7_265_001;

/** Line endings are normalized so a checkout on another OS keeps the same checksum. */
export function checksum(sql: string): string {
  return createHash("sha256").update(sql.replace(/\r\n/g, "\n")).digest("hex");
}

/**
 * Pure: decide which files still need to run. Throws if an applied migration
 * changed or has disappeared from disk.
 */
export function planMigrations(
  files: MigrationFile[],
  applied: Map<string, string>,
): MigrationFile[] {
  const onDisk = new Set(files.map((f) => f.name));
  for (const name of applied.keys()) {
    if (!onDisk.has(name)) {
      throw new Error(`Applied migration ${name} is missing from the migrations folder.`);
    }
  }
  const pending: MigrationFile[] = [];
  for (const f of [...files].sort((a, b) => a.name.localeCompare(b.name))) {
    const prior = applied.get(f.name);
    if (prior === undefined) pending.push(f);
    else if (prior !== checksum(f.sql)) {
      throw new Error(
        `Migration ${f.name} was changed after it was applied. Add a new migration instead of editing it.`,
      );
    }
  }
  return pending;
}

export async function readMigrationFiles(dir: string): Promise<MigrationFile[]> {
  const names = (await readdir(dir)).filter((n) => n.endsWith(".sql")).sort();
  return Promise.all(
    names.map(async (name) => ({ name, sql: await readFile(path.join(dir, name), "utf8") })),
  );
}

/** Apply pending migrations on a connected client. Returns the names applied. */
export async function runMigrations(client: Client, dir: string): Promise<string[]> {
  await client.query("SELECT pg_advisory_lock($1)", [LOCK_KEY]);
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const { rows } = await client.query<{ filename: string; checksum: string }>(
      "SELECT filename, checksum FROM schema_migrations",
    );
    const applied = new Map(rows.map((r) => [r.filename, r.checksum]));
    const pending = planMigrations(await readMigrationFiles(dir), applied);

    for (const m of pending) {
      await client.query("BEGIN");
      try {
        await client.query(m.sql);
        await client.query("INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)", [
          m.name,
          checksum(m.sql),
        ]);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${m.name} failed: ${(err as Error).message}`);
      }
    }
    return pending.map((m) => m.name);
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]);
  }
}
