/** Load hand-made tags into Postgres: npm run tags:load [-- path/to/tags.json] (default data/manual-tags.json) */
import { Client } from "pg";
import { requireUrl } from "../lib/db/config";
import { loadManualTags, readManualTagsFile } from "../lib/db/manualTags";

async function main() {
  const file = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "data/manual-tags.json";
  const tags = await readManualTagsFile(file);
  const client = new Client({ connectionString: requireUrl("admin") });
  await client.connect();
  try {
    const { loaded } = await loadManualTags(client, tags);
    console.log(`Loaded ${loaded} manual tag sets (source ${tags.source}, taxonomy ${tags.taxonomyVersion}).`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
