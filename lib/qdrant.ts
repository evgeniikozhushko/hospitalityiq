import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "node:crypto";
import { env } from "./env";
import { EMBEDDING_DIMENSIONS } from "./openai";

export const qdrant = new QdrantClient({
  url: env.QDRANT_URL,
  apiKey: env.QDRANT_API_KEY || undefined,
});

export const COLLECTION = env.QDRANT_COLLECTION;

/** Create the reviews collection (and filter indexes) if it doesn't exist. */
export async function ensureCollection() {
  const { exists } = await qdrant.collectionExists(COLLECTION);
  if (exists) return;

  await qdrant.createCollection(COLLECTION, {
    vectors: { size: EMBEDDING_DIMENSIONS, distance: "Cosine" },
  });

  // Indexes make metadata filters fast ("only reviews for property X",
  // "only 1-2 star reviews"). Add more as filter needs grow.
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "locationId",
    field_schema: "keyword",
  });
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "propertyType",
    field_schema: "keyword",
  });
  await qdrant.createPayloadIndex(COLLECTION, {
    field_name: "rating",
    field_schema: "integer",
  });
}

/**
 * Qdrant point IDs must be integers or UUIDs. Google review IDs are neither,
 * so derive a stable UUID from the review ID. Same review -> same point ID,
 * which makes re-running ingestion safe (it overwrites instead of duplicating).
 */
export function pointIdFor(reviewId: string): string {
  const h = createHash("sha1").update(reviewId).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
