/**
 * Load the synthetic practice data (data/synthetic) into the DEV Postgres, as source
 * "synthetic", so you can try the stats CLI. It never touches Qdrant: synthetic
 * reviews are not embedded, so search and evals are unaffected.
 *   npm run seed:synthetic
 */
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import { requireUrl } from "../lib/db/config";
import { importLocations } from "../lib/db/import";
import { loadManualTags, readManualTagsFile } from "../lib/db/manualTags";
import { LocationReviewsSchema } from "../lib/schema";

async function main() {
  const locations = z
    .array(LocationReviewsSchema)
    .parse(JSON.parse(await readFile("data/synthetic/reviews.json", "utf8")));
  const tags = await readManualTagsFile("data/synthetic/tags.json");
  const client = new Client({ connectionString: requireUrl("admin") });
  await client.connect();
  try {
    const res = await importLocations(client, locations, { source: "synthetic" });
    for (const r of res) {
      if (r.status === "failed") throw new Error(`${r.propertyName}: ${r.error}`);
    }
    const { loaded } = await loadManualTags(client, tags);
    console.log(`Seeded ${res.length} synthetic properties and ${loaded} tag sets (source "synthetic", not indexed).`);
    console.log('Try: npm run stats -- mentions --theme parking --source synthetic');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
