/**
 * Undo one migration with its hand-written down script (db/rollback/<name>.down.sql):
 *
 *   node --env-file=.env.local --import tsx scripts/rollback.ts 0003_tag_sets
 *
 * Back up the database first. Run `npm run db:setup` afterwards to restore grants.
 */
import { Client } from "pg";
import { requireUrl } from "../lib/db/config";
import { rollbackMigration } from "../lib/db/rollback";

async function main() {
  const name = process.argv[2];
  if (!name) throw new Error("Usage: scripts/rollback.ts <migration name, e.g. 0003_tag_sets>");
  const client = new Client({ connectionString: requireUrl("admin") });
  await client.connect();
  try {
    await rollbackMigration(client, name);
    console.log(`Rolled back ${name}.`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
