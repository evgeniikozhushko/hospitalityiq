import { z } from "zod";

/**
 * Shape of a review as returned by the Google Business Profile API
 * (accounts.locations.reviews). Only the fields we use are listed;
 * unknown extra fields are ignored. Verify against Google's docs once
 * API access is approved.
 */
export const StarRating = z.enum([
  "STAR_RATING_UNSPECIFIED",
  "ONE",
  "TWO",
  "THREE",
  "FOUR",
  "FIVE",
]);

export const GbpReviewSchema = z.object({
  reviewId: z.string(),
  reviewer: z
    .object({
      displayName: z.string().optional(),
      profilePhotoUrl: z.string().optional(),
      isAnonymous: z.boolean().optional(),
    })
    .optional(),
  starRating: StarRating,
  comment: z.string().optional(), // rating-only reviews have no comment
  createTime: z.string(),
  updateTime: z.string().optional(),
  reviewReply: z
    .object({ comment: z.string(), updateTime: z.string().optional() })
    .optional(),
});
export type GbpReview = z.infer<typeof GbpReviewSchema>;

/** Our own metadata about each location, kept alongside its reviews. */
export const PropertyType = z.enum([
  "hotel",
  "restaurant",
  "spa",
  "theatre",
  "rental",
]);

export const LocationReviewsSchema = z.object({
  locationId: z.string(),
  propertyName: z.string(),
  propertyType: PropertyType,
  reviews: z.array(GbpReviewSchema),
});
export type LocationReviews = z.infer<typeof LocationReviewsSchema>;

/**
 * What we actually store in Qdrant: sanitized text plus filterable metadata.
 * Note there is no reviewer field: guest identity never enters the index.
 */
export const ReviewRecordSchema = z.object({
  reviewId: z.string(),
  locationId: z.string(),
  propertyName: z.string(),
  propertyType: PropertyType,
  rating: z.number().int().min(1).max(5),
  text: z.string().min(1),
  ownerReply: z.string().optional(),
  createdAt: z.string(),
  source: z.literal("google_business_profile"),
});
export type ReviewRecord = z.infer<typeof ReviewRecordSchema>;

const RATING_TO_NUMBER: Record<string, number> = {
  ONE: 1,
  TWO: 2,
  THREE: 3,
  FOUR: 4,
  FIVE: 5,
};

export function ratingToNumber(r: z.infer<typeof StarRating>): number | null {
  return RATING_TO_NUMBER[r] ?? null;
}
