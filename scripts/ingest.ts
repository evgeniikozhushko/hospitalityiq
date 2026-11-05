/**
 * Ingestion pipeline: load reviews -> validate -> sanitize -> embed -> upsert.
 *
 * Usage: npm run ingest            (uses data/sample-reviews.json)
 *        npm run ingest -- path/to/reviews.json
 */
import { readFile } from "node:fs/promises";
import { z } from "zod";
import {
  LocationReviewsSchema,
  ReviewRecordSchema,
  ratingToNumber,
  type ReviewRecord,
} from "../lib/schema";
import { sanitize } from "../lib/sanitize";
import { embed } from "../lib/openai";
import { qdrant, COLLECTION, ensureCollection, pointIdFor } from "../lib/qdrant";

const BATCH_SIZE = 100;

async function main() {
  const file = process.argv[2] ?? "data/sample-reviews.json";
  const raw = JSON.parse(await readFile(file, "utf8"));
  const locations = z.array(LocationReviewsSchema).parse(raw);

  // 1. Normalize + sanitize. Skip rating-only reviews (nothing to embed).
  const records: ReviewRecord[] = [];
  let skipped = 0;
  for (const loc of locations) {
    for (const r of loc.reviews) {
      const rating = ratingToNumber(r.starRating);
      const text = r.comment ? sanitize(r.comment) : "";
      if (!text || rating === null) {
        skipped++;
        continue;
      }
      records.push(
        ReviewRecordSchema.parse({
          reviewId: r.reviewId,
          locationId: loc.locationId,
          propertyName: loc.propertyName,
          propertyType: loc.propertyType,
          rating,
          text,
          ownerReply: r.reviewReply?.comment
            ? sanitize(r.reviewReply.comment)
            : undefined,
          createdAt: r.createTime,
          source: "google_business_profile",
        }),
      );
    }
  }
  console.log(`Prepared ${records.length} reviews (skipped ${skipped} without text).`);

  // 2. Make sure the collection exists.
  await ensureCollection();

  // 3. Embed + upsert in batches.
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const vectors = await embed(batch.map((r) => r.text));
    await qdrant.upsert(COLLECTION, {
      wait: true,
      points: batch.map((r, j) => ({
        id: pointIdFor(r.reviewId),
        vector: vectors[j],
        payload: r,
      })),
    });
    console.log(`Upserted ${i + batch.length}/${records.length}`);
  }

  const { count } = await qdrant.count(COLLECTION, { exact: true });
  console.log(`Done. Collection "${COLLECTION}" now has ${count} points.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
