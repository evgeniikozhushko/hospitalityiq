/**
 * Runs a hand-written down migration from db/rollback/ in one transaction. The
 * migration runner only goes forward; this exists for the rare migration that has to
 * be undone on a database whose data matters. Each down script removes its own
 * schema_migrations row, so `db:migrate` would apply the migration again.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Client } from "pg";

export async function rollbackMigration(
  client: Client,
  name: string,
  dir = path.join(process.cwd(), "db/rollback"),
): Promise<void> {
  if (!/^\d{4}_[a-z0-9_]+$/.test(name)) throw new Error(`Not a migration name: ${name}`);
  const sql = await readFile(path.join(dir, `${name}.down.sql`), "utf8");
  await client.query("BEGIN");
  try {
    await client.query(sql);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
