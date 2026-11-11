/** Compare Postgres and Qdrant for one source: npm run reconcile [-- --source=google_business_profile] */
import { Client } from "pg";
import { requireUrl } from "../lib/db/config";
import { reconcile } from "../lib/db/reconcile";
import { GOOGLE_SOURCE } from "../lib/pointId";
import { qdrantIndex } from "../lib/qdrantIndex";

async function main() {
  const source = process.argv.find((a) => a.startsWith("--source="))?.slice(9) ?? GOOGLE_SOURCE;
  const client = new Client({ connectionString: requireUrl("admin") });
  await client.connect();
  try {
    const r = await reconcile(client, qdrantIndex, source);
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok) {
      console.error("Out of sync. Run `npm run ingest` to sync, or `npm run reindex -- --source=" + source + "` to rebuild.");
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
