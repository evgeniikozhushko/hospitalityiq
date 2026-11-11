import { createHash } from "node:crypto";

/**
 * Qdrant point IDs must be integers or UUIDs. Google review IDs are neither,
 * so derive a stable UUID from the review ID. Same review -> same point ID,
 * which makes re-running ingestion safe (it overwrites instead of duplicating).
 */
export function pointIdFor(reviewId: string): string {
  const h = createHash("sha1").update(reviewId).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export const GOOGLE_SOURCE = "google_business_profile";

/**
 * Point ID for a review of a given source. Google keeps the original mapping
 * (hash of the bare review ID) so existing points, search and evals are
 * unaffected; every other source is namespaced so IDs cannot collide.
 */
export function pointIdForReview(source: string, sourceReviewId: string): string {
  return source === GOOGLE_SOURCE
    ? pointIdFor(sourceReviewId)
    : pointIdFor(`${source}:${sourceReviewId}`);
}
