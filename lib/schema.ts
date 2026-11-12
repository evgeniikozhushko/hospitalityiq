import { z } from "zod";

/**
 * Shape of a review as returned by the Google Business Profile API
 * (accounts.locations.reviews). Only the fields we use are listed;
 * unknown extra fields are ignored. Needs verification against Google's docs once
 * API access is approved.
 *
 * Defines the output shape:
 * QueryIntent
 * QueryFiltersSchema
 * QueryPlanSchema
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
  // Month the review was written (1-12, UTC). Lets "winter" filter across years.
  month: z.number().int().min(1).max(12),
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

// ---------------------------------------------------------------------------
// Question answering
// ---------------------------------------------------------------------------

/**
 * What the planner extracts from a question. Every filter is nullable rather
 * than optional because OpenAI strict structured output requires all keys.
 */
export const QueryIntent = z.enum([
  "review_insight", // what guests say: answered from reviews
  "campaign", // promotions, bookings, conversions: not built yet
  "financial", // revenue, spend, pricing: restricted, always declined here
  "off_topic", // anything else
]);
export type QueryIntent = z.infer<typeof QueryIntent>;

export const QueryFiltersSchema = z.object({
  propertyTypes: z.array(PropertyType).nullable(),
  propertyNames: z.array(z.string()).nullable(),
  minRating: z.number().int().min(1).max(5).nullable(),
  maxRating: z.number().int().min(1).max(5).nullable(),
  months: z.array(z.number().int().min(1).max(12)).nullable(),
  since: z.string().nullable().describe("ISO date (YYYY-MM-DD), inclusive"),
  until: z.string().nullable().describe("ISO date (YYYY-MM-DD), inclusive"),
});
export type QueryFilters = z.infer<typeof QueryFiltersSchema>;

export const QueryPlanSchema = z.object({
  intent: QueryIntent,
  mode: z
    .enum(["specific", "aggregate"])
    .describe("aggregate = comparing or ranking properties / counting mentions"),
  searchQuery: z
    .string()
    .describe("The question rewritten for semantic search, without filter words"),
  filters: QueryFiltersSchema,
});
export type QueryPlan = z.infer<typeof QueryPlanSchema>;

/**
 * The planner's request for an exact count (docs/routing-plan.md, decision 1).
 * Every key is nullable because strict structured output requires all keys.
 * Code (lib/route.ts) checks it before any SQL runs; the model never writes SQL.
 */
export const StatKind = z.enum(["mentions", "ranking", "trend"]);
export type StatKind = z.infer<typeof StatKind>;

export const StatRequestSchema = z.object({
  kind: StatKind.nullable(),
  themes: z
    .array(z.string())
    .nullable()
    .describe("Theme slugs the question asks about, one entry per theme; null for a ranking"),
  topic: z
    .string()
    .nullable()
    .describe("The subject of the question in the user's own words, whether or not it is a theme"),
  sentiment: z.enum(["positive", "negative", "neutral"]).nullable(),
  ranks: z
    .enum(["themes", "properties"])
    .nullable()
    .describe('What a "most"/ranking question compares: themes, or properties; null when it compares nothing'),
});
export type StatRequest = z.infer<typeof StatRequestSchema>;

export const Route = z.enum(["retrieval", "statistics"]);
export type Route = z.infer<typeof Route>;

/**
 * What the planner returns once routing is wired in: a QueryPlan plus the route.
 * Kept separate from QueryPlanSchema so saved answers and the wire format, which
 * parse QueryPlanSchema, are unaffected.
 */
export const PlannerOutputSchema = QueryPlanSchema.extend({
  route: Route,
  stat: StatRequestSchema.nullable(),
});
export type PlannerOutput = z.infer<typeof PlannerOutputSchema>;

export const EMPTY_FILTERS: QueryFilters = {
  propertyTypes: null,
  propertyNames: null,
  minRating: null,
  maxRating: null,
  months: null,
  since: null,
  until: null,
};

/** A retrieved review as shown to the answer model and returned to the client. */
export type Source = {
  n: number; // citation number, [n] in the answer
  reviewId: string;
  propertyName: string;
  propertyType: z.infer<typeof PropertyType>;
  rating: number;
  createdAt: string;
  text: string;
  score: number;
};

/** Fixed messages per non-answerable intent, so evals can tell them apart. */
export const DECLINE_MESSAGES: Record<Exclude<QueryIntent, "review_insight">, string> = {
  campaign:
    "Campaign and booking performance isn't available yet. For now I can answer questions about what guests say in reviews.",
  financial:
    "I can't help with financial questions such as revenue, spend or pricing. I can answer questions about what guests say in reviews.",
  off_topic:
    "That's outside what I can help with. I answer questions about what guests say in reviews of our properties.",
};

export const NO_DATA_MESSAGE =
  "I couldn't find any reviews matching that question. Try a different property, time period or wording.";
