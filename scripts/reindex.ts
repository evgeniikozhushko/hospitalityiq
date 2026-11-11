/**
 * Rebuild Qdrant for ONE source from Postgres: npm run reindex -- --source=google_business_profile
 * Re-embeds every live review of that source, removes points for deleted reviews, and deletes
 * extra points of that source only. Other sources' points are never touched.
 */
import { Client } from "pg";
import { requireUrl } from "../lib/db/config";
import { reindex } from "../lib/db/reconcile";
import { embed } from "../lib/openai";
import { ensureCollection } from "../lib/qdrant";
import { qdrantIndex } from "../lib/qdrantIndex";

async function main() {
  const source = process.argv.find((a) => a.startsWith("--source="))?.slice(9);
  if (!source) throw new Error("Name the source to rebuild: --source=google_business_profile");
  const client = new Client({ connectionString: requireUrl("admin") });
  await client.connect();
  try {
    await ensureCollection();
    const r = await reindex(client, qdrantIndex, embed, source);
    console.log(JSON.stringify(r, null, 2));
    if (!r.reconcile.ok) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
