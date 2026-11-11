/** Apply pending SQL migrations: npm run db:migrate */
import path from "node:path";
import { Client } from "pg";
import { requireUrl } from "../lib/db/config";
import { runMigrations } from "../lib/db/migrate";

async function main() {
  const client = new Client({ connectionString: requireUrl("admin") });
  await client.connect();
  try {
    const applied = await runMigrations(client, path.join(process.cwd(), "db/migrations"));
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
