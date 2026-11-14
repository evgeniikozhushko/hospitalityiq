import { QdrantClient } from "@qdrant/js-client-rest";
import { env } from "./env";
import { EMBEDDING_DIMENSIONS } from "./openai";
import type { RetrieveDeps } from "./retrieve";

/** The client default is 5 minutes: far longer than a question should wait. */
export const QDRANT_TIMEOUT_MS = 15_000;

export const qdrant = new QdrantClient({
  url: env.QDRANT_URL,
  apiKey: env.QDRANT_API_KEY || undefined,
  timeout: QDRANT_TIMEOUT_MS,
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

/**
 * Distinct property names in the index (via the propertyName keyword index).
 * Not cached here: lib/properties.ts decides what is cached and for how long.
 */
export async function indexedProperties(): Promise<string[]> {
  const { hits } = await qdrant.facet(COLLECTION, { key: "propertyName", limit: 1000 });
  return hits.map((h) => String(h.value));
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

export { pointIdFor } from "./pointId";
