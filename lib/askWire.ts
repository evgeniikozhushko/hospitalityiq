/**
 * Wire protocol for POST /api/ask: the pipeline's AnswerEvent plus the route's own
 * { type: "error" } event, validated structurally on the client.
 */
import { z } from "zod";
import type { AnswerEvent } from "./answer";
import { PropertyType, QueryFiltersSchema, QueryIntent, QueryPlanSchema, type Source } from "./schema";
import type { StatsOutcome } from "./statsAnswer";

export type AskEvent = AnswerEvent | { type: "error"; message: string };

/** `Source` is a plain type in lib/schema.ts, so the client defines its schema here. */
export const SourceWireSchema = z.object({
  n: z.number().int().positive(),
  reviewId: z.string(),
  propertyName: z.string(),
  propertyType: PropertyType,
  rating: z.number(),
  createdAt: z.string(),
  text: z.string(),
  score: z.number(),
});

/** The structured result behind a statistics answer (lib/statsAnswer.ts StatsOutcome). */
const SentimentWire = z.enum(["positive", "negative", "neutral"]).nullable();
const CoverageWire = z.object({
  totalReviews: z.number(),
  textReviews: z.number(),
  currentTagged: z.number(),
  stale: z.number(),
  untagged: z.number(),
});
const ThemeMentionsWire = z.object({
  theme: z.string(),
  sentiment: SentimentWire,
  scopeLabel: z.string(),
  rows: z.array(
    z.object({ propertyId: z.number(), propertyName: z.string(), count: z.number(), coverage: CoverageWire }),
  ),
  total: z.object({ count: z.number(), coverage: CoverageWire }),
});
const PeriodWire = ThemeMentionsWire.extend({ window: z.object({ since: z.string(), until: z.string() }) });

export const StatsOutcomeWireSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("mentions"),
    query: z.object({ kind: z.literal("mentions"), theme: z.string(), sentiment: SentimentWire, filters: QueryFiltersSchema }),
    result: ThemeMentionsWire,
  }),
  z.object({
    kind: z.literal("ranking"),
    query: z.object({ kind: z.literal("ranking"), sentiment: SentimentWire, filters: QueryFiltersSchema }),
    result: z.object({
      sentiment: SentimentWire,
      scopeLabel: z.string(),
      themes: z.array(z.object({ theme: z.string(), count: z.number() })),
      coverage: CoverageWire,
    }),
  }),
  z.object({
    kind: z.literal("trend"),
    query: z.object({ kind: z.literal("trend"), theme: z.string(), sentiment: SentimentWire, filters: QueryFiltersSchema }),
    result: z.object({
      theme: z.string(),
      sentiment: SentimentWire,
      current: PeriodWire,
      previous: PeriodWire,
      change: z.object({ absolute: z.number(), percent: z.number().nullable() }),
    }),
  }),
]);

const EventSchemas = {
  plan: z.object({
    type: z.literal("plan"),
    plan: QueryPlanSchema,
    droppedPropertyNames: z.array(z.string()),
  }),
  declined: z.object({
    type: z.literal("declined"),
    intent: QueryIntent.exclude(["review_insight"]),
    message: z.string(),
  }),
  no_data: z.object({ type: z.literal("no_data"), message: z.string() }),
  sources: z.object({
    type: z.literal("sources"),
    sources: z.array(SourceWireSchema),
    relaxed: z.boolean(),
  }),
  stats: z.object({ type: z.literal("stats"), outcome: StatsOutcomeWireSchema }),
  delta: z.object({ type: z.literal("delta"), text: z.string() }),
  done: z.object({ type: z.literal("done") }),
  error: z.object({ type: z.literal("error"), message: z.string() }),
} as const;

export const AskEventSchema = z.discriminatedUnion("type", [
  EventSchemas.plan,
  EventSchemas.declined,
  EventSchemas.no_data,
  EventSchemas.sources,
  EventSchemas.stats,
  EventSchemas.delta,
  EventSchemas.done,
  EventSchemas.error,
]);

// Drift guards: strict two-way type equality, so a missing, extra or changed field fails `tsc`.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type SourceSchemaMatchesSource = Assert<Equal<z.infer<typeof SourceWireSchema>, Source>>;
export type StatsSchemaMatchesStatsOutcome = Assert<Equal<z.infer<typeof StatsOutcomeWireSchema>, StatsOutcome>>;
export type EventSchemaMatchesAskEvent = Assert<Equal<z.infer<typeof AskEventSchema>, AskEvent>>;

export type WireParse =
  | { kind: "event"; event: AskEvent }
  | { kind: "unknown"; type: string }
  | { kind: "invalid"; reason: string };

export function parseWireEvent(raw: unknown): WireParse {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { kind: "invalid", reason: "event is not an object" };
  }
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string") return { kind: "invalid", reason: "event has no string type" };
  if (!Object.hasOwn(EventSchemas, type)) return { kind: "unknown", type };

  const schema = EventSchemas[type as keyof typeof EventSchemas];
  const result = schema.safeParse(raw);
  if (!result.success) {
    return { kind: "invalid", reason: `${type}: ${result.error.issues[0]?.message ?? "invalid"}` };
  }
  return { kind: "event", event: result.data as AskEvent };
}
