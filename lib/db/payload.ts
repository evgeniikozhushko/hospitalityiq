/**
 * The Qdrant payload for a review, built from Postgres rows. Same fields as
 * ReviewRecord (so search, filters and evals keep working) plus textHash, which
 * lets reconciliation compare content across the two stores.
 */
import { createHash } from "node:crypto";

export type IndexRow = {
  source: string;
  source_review_id: string;
  location_id: string;
  property_name: string;
  property_type: string;
  rating: number;
  text: string;
  owner_reply: string | null;
  created_at: Date;
  text_hash: string;
};

export type IndexPayload = {
  reviewId: string;
  locationId: string;
  propertyName: string;
  propertyType: string;
  rating: number;
  month: number;
  text: string;
  ownerReply?: string;
  createdAt: string;
  source: string;
  textHash: string;
};

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
export const hashText = (text: string | null | undefined) => sha256(text ?? "");

export function buildPayload(row: IndexRow): IndexPayload {
  const payload: IndexPayload = {
    reviewId: row.source_review_id,
    locationId: row.location_id,
    propertyName: row.property_name,
    propertyType: row.property_type,
    rating: row.rating,
    // Same definition as before: UTC month of creation (see docs/sql-plan.md on the local-time mismatch).
    month: row.created_at.getUTCMonth() + 1,
    text: row.text,
    createdAt: row.created_at.toISOString(),
    source: row.source,
    textHash: row.text_hash,
  };
  if (row.owner_reply) payload.ownerReply = row.owner_reply;
  return payload;
}

/** Stable hash: keys sorted, so field order never changes it. */
export function hashPayload(payload: IndexPayload): string {
  const sorted = Object.fromEntries(Object.entries(payload).sort(([a], [b]) => a.localeCompare(b)));
  return sha256(JSON.stringify(sorted));
}

/** Rows that belong in Qdrant: live, with text, and with a rating (the payload requires one). */
export const INDEXABLE_SQL = "r.deleted_at IS NULL AND r.has_text AND r.rating IS NOT NULL";

/** Rows whose point (if any) must be removed from Qdrant. */
export const NOT_INDEXABLE_SQL = "(r.deleted_at IS NOT NULL OR NOT r.has_text OR r.rating IS NULL)";

export const INDEX_ROWS_SQL = `
  SELECT r.source, r.source_review_id, p.location_id, p.name AS property_name,
         p.type AS property_type, r.rating::int AS rating, r.text, r.owner_reply,
         r.created_at, r.text_hash, r.indexed_text_hash, r.indexed_payload_hash, r.id
  FROM reviews r JOIN properties p ON p.id = r.property_id
  WHERE r.source = $1 AND ${INDEXABLE_SQL}
  ORDER BY r.id`;
