/**
 * Ingestion pipeline: load reviews -> validate -> sanitize -> Postgres -> embed -> Qdrant.
 * Postgres is written first (one transaction per property); Qdrant is then brought in
 * line, retrying anything that failed before. Reconciliation runs at the end.
 *
 * Usage: npm run ingest                         (uses data/sample-reviews.json)
 *        npm run ingest -- path/to/reviews.json
 *        npm run ingest -- file.json --complete-snapshot          (preview missing reviews)
 *        npm run ingest -- file.json --complete-snapshot --apply  (soft-delete them)
 *
 * --complete-snapshot is a promise that the file lists EVERY review of each property in it.
 * Partial exports (the default) never delete anything.
 */
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import { requireUrl } from "../lib/db/config";
import { importLocations } from "../lib/db/import";
import { reconcile } from "../lib/db/reconcile";
import { syncIndex } from "../lib/db/qdrantSync";
import { embed } from "../lib/openai";
import { GOOGLE_SOURCE } from "../lib/pointId";
import { ensureCollection } from "../lib/qdrant";
import { qdrantIndex } from "../lib/qdrantIndex";
import { LocationReviewsSchema } from "../lib/schema";

async function main() {
  const args = process.argv.slice(2);
  const flags = new Set(args.filter((a) => a.startsWith("--")));
  const file = args.find((a) => !a.startsWith("--")) ?? "data/sample-reviews.json";
  const completeSnapshot = flags.has("--complete-snapshot");
  const apply = flags.has("--apply");
  if (apply && !completeSnapshot) {
    throw new Error("--apply only makes sense with --complete-snapshot.");
  }

  // Validate the whole file before touching any database.
  const raw = JSON.parse(await readFile(file, "utf8"));
  const locations = z.array(LocationReviewsSchema).parse(raw);

  const client = new Client({ connectionString: requireUrl("admin") });
  await client.connect();
  try {
    const results = await importLocations(client, locations, {
      source: GOOGLE_SOURCE,
      completeSnapshot,
      apply,
    });
    let failed = 0;
    for (const r of results) {
      if (r.status === "failed") {
        failed++;
        console.error(`FAILED ${r.propertyName}: ${r.error} (nothing was changed or deleted)`);
        continue;
      }
      console.log(
        `${r.propertyName}: ${r.inserted} new, ${r.updated} updated, ${r.unchanged} unchanged` +
          (r.textChanged ? `, ${r.textChanged} text changed (tags marked stale)` : "") +
          (r.restored ? `, ${r.restored} restored` : ""),
      );
      if (completeSnapshot) {
        if (r.missing.length === 0) console.log(`  complete snapshot: no missing reviews`);
        else if (apply) console.log(`  soft-deleted ${r.deleted} missing: ${r.missing.join(", ")}`);
        else console.log(`  PREVIEW, would delete ${r.missing.length} missing: ${r.missing.join(", ")} (re-run with --apply)`);
      }
    }

    await ensureCollection();
    const sync = await syncIndex(client, qdrantIndex, embed, GOOGLE_SOURCE);
    console.log(
      `Qdrant: ${sync.embedded} embedded, ${sync.payloadRefreshed} payloads refreshed, ${sync.removed} removed.`,
    );

    const rec = await reconcile(client, qdrantIndex, GOOGLE_SOURCE);
    console.log(
      `Reconcile: ${rec.postgresActive} live in Postgres, ${rec.qdrantInScope} in Qdrant, ` +
        `${rec.missing.length} missing, ${rec.extra.length} extra, ${rec.hashMismatch.length} hash mismatches` +
        (rec.outOfScope ? ` (${rec.outOfScope} points of other sources ignored)` : ""),
    );
    if (failed > 0 || !rec.ok) process.exitCode = 1;
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
