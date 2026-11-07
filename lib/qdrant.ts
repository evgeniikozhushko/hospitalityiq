import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "node:crypto";
import { env } from "./env";
import { EMBEDDING_DIMENSIONS } from "./openai";
import type { RetrieveDeps } from "./retrieve";

export const qdrant = new QdrantClient({
  url: env.QDRANT_URL,
  apiKey: env.QDRANT_API_KEY || undefined,
});

export const COLLECTION = env.QDRANT_COLLECTION;

/**
 * Payload indexes make metadata filters fast. createPayloadIndex is
 * idempotent, so this runs on every ingest: existing collections pick up
 * indexes added later without being recreated.
 */
const PAYLOAD_INDEXES: Array<{
  field_name: string;
  field_schema: "keyword" | "integer" | "datetime";
}> = [
  { field_name: "locationId", field_schema: "keyword" },
  { field_name: "propertyName", field_schema: "keyword" },
  { field_name: "propertyType", field_schema: "keyword" },
  { field_name: "rating", field_schema: "integer" },
  { field_name: "month", field_schema: "integer" },
  { field_name: "createdAt", field_schema: "datetime" },
];

/** Create the reviews collection if missing, and make sure all indexes exist. */
export async function ensureCollection() {
  const { exists } = await qdrant.collectionExists(COLLECTION);
  if (!exists) {
    await qdrant.createCollection(COLLECTION, {
      vectors: { size: EMBEDDING_DIMENSIONS, distance: "Cosine" },
    });
  }
  for (const index of PAYLOAD_INDEXES) {
    await qdrant.createPayloadIndex(COLLECTION, { ...index, wait: true });
  }
}

let propertiesCache: string[] | null = null;

/**
 * Distinct property names in the index (via the propertyName keyword index).
 * Cached per process; restart after ingesting new properties.
 */
export async function listProperties(): Promise<string[]> {
  if (propertiesCache) return propertiesCache;
  const { hits } = await qdrant.facet(COLLECTION, { key: "propertyName", limit: 1000 });
  propertiesCache = hits.map((h) => String(h.value)).sort();
  return propertiesCache;
}

/** Vector search used by retrieve(); query() replaced search() in client v1.20. */
export const searchReviews: RetrieveDeps["search"] = async ({ vector, filter, limit }) => {
  const { points } = await qdrant.query(COLLECTION, {
    query: vector,
    filter,
    limit,
    with_payload: true,
  });
  return points.map((p) => ({
    score: p.score,
    payload: (p.payload ?? {}) as Record<string, unknown>,
  }));
};

/**
 * Qdrant point IDs must be integers or UUIDs. Google review IDs are neither,
 * so derive a stable UUID from the review ID. Same review -> same point ID,
 * which makes re-running ingestion safe (it overwrites instead of duplicating).
 */
export function pointIdFor(reviewId: string): string {
  const h = createHash("sha1").update(reviewId).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}
