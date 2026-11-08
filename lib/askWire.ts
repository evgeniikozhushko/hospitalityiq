/**
 * Wire protocol for POST /api/ask: the pipeline's AnswerEvent plus the route's own
 * { type: "error" } event, validated structurally on the client.
 */
import { z } from "zod";
import type { AnswerEvent } from "./answer";
import { PropertyType, QueryIntent, QueryPlanSchema, type Source } from "./schema";

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
  delta: z.object({ type: z.literal("delta"), text: z.string() }),
  done: z.object({ type: z.literal("done") }),
  error: z.object({ type: z.literal("error"), message: z.string() }),
} as const;

export const AskEventSchema = z.discriminatedUnion("type", [
  EventSchemas.plan,
  EventSchemas.declined,
  EventSchemas.no_data,
  EventSchemas.sources,
  EventSchemas.delta,
  EventSchemas.done,
  EventSchemas.error,
]);

// Drift guards: strict two-way type equality, so a missing, extra or changed field fails `tsc`.
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Assert<T extends true> = T;
export type SourceSchemaMatchesSource = Assert<Equal<z.infer<typeof SourceWireSchema>, Source>>;
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
