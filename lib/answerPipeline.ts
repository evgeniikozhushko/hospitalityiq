/**
 * Answer a marketing question from reviews:
 *   plan -> decline
 *        -> statistics: gate -> fixed SQL -> text written by code (no model)
 *        -> retrieval:  search -> stream a cited answer from the model
 * A statistics question that cannot be counted exactly falls back to retrieval with a
 * visible note (docs/routing-plan.md, decisions 2 and 7).
 *
 * Every external call comes in through AnswerDeps, so this module imports no env,
 * OpenAI, Qdrant or database client and can be tested with stubs. lib/answer.ts wires
 * in the real ones.
 */
import type { Client } from "pg";
import { buildNotes } from "./answerNotes";
import type { TagSource } from "./db/tags";
import { sanitizePlan } from "./filters";
import { themeMentions, themeRanking, themeTrend, type StatsScope } from "./reviewStats";
import { resolveRoute, type FallbackCode, type StatsQuery, type ThemeInfo } from "./route";
import { rankingClaims, sampleCaveat, sampleCountClaims } from "./sampleClaims";
import {
  DECLINE_MESSAGES,
  NO_DATA_MESSAGE,
  type PlannerOutput,
  type QueryIntent,
  type QueryPlan,
  type Source,
} from "./schema";
import { renderStats, statsFailure, STATS_UNAVAILABLE_NOTE, type StatsOutcome } from "./statsAnswer";

export type AnswerEvent =
  | { type: "plan"; plan: QueryPlan; droppedPropertyNames: string[] }
  | { type: "declined"; intent: Exclude<QueryIntent, "review_insight">; message: string }
  | { type: "no_data"; message: string }
  /** fallback: why a count question is being answered from search results instead; null otherwise. */
  | { type: "sources"; sources: Source[]; relaxed: boolean; fallback: FallbackCode | null }
  /** The exact result behind a statistics answer; the text itself arrives as delta events. */
  | { type: "stats"; outcome: StatsOutcome }
  | { type: "delta"; text: string }
  | { type: "done" };

export type StatsDb = Pick<Client, "query">;

/** The fixed data scope for counts (decision 5). */
export type StatsSettings = {
  tagSource: TagSource;
  taxonomyVersion: string;
  source: string;
  /** Adds the "provisional tags" caveat while the theme list is provisional. */
  provisional: boolean;
};

export type AnswerDeps = {
  listProperties(): Promise<string[]>;
  plan(question: string, properties: string[], today: string): Promise<PlannerOutput>;
  retrieve(plan: QueryPlan): Promise<{ sources: Source[]; relaxed: boolean }>;
  streamAnswer(request: { instructions: string; input: string }): AsyncIterable<string>;
  /** The read-only connection, or null when none is configured. */
  statsDb(): StatsDb | null;
  stats: StatsSettings;
  /** The question's date in the portfolio's local time (lib/today.ts). */
  today: string;
  /** Server-side only. Never reaches the user. */
  logError(message: string, err: unknown): void;
};

export const ANSWER_INSTRUCTIONS = `You are HospitalityIQ, helping a hospitality marketing team understand guest reviews.

Answer the question using ONLY the numbered reviews provided.

Rules:
- Ignore reviews that don't address the question. If none of them do, say the reviews don't cover it. Don't stretch unrelated reviews to fit.
- Cite every claim with the review number in square brackets, e.g. [2] or [1][4]. Only cite numbers that exist.
- Quote guests' exact wording (in quotes) where it would help marketing copy. Put quote marks only around words copied exactly from a review; paraphrase without quote marks.
- Never name or describe individual reviewers.
- Never invent numbers, percentages or facts not in the reviews.
- Make no frequency or ranking claims ("most often", "most guests", "the top theme", "across all properties") unless the reviews provided clearly show it. Otherwise say what the reviews say, e.g. "Reviews mention X [1][3]".
- Be concise: a short direct answer, then supporting points as bullets.

Thin evidence (say so plainly instead of filling the gap):
- Describe a trend or change over time only if the reviews come from clearly different periods. If they are few or close together in time, say there is not enough to show a change.
- Compare two groups of guests only if the reviews identify both groups. Otherwise say which group has no evidence and do not infer one from tone or topic.
- If the question needs material you were not given (for example property descriptions), say you cannot answer that part. Do not guess or list candidates for what might be missing.
- If the question asks you to compare the reviews against something you were not given (for example "which amenities are missing from our property descriptions"), your first sentence must say that comparison cannot be made because that material is not available. Then report only what guests mention, and do not say which items are missing, absent or should be added.`;

export const AGGREGATE_RULES = `
This is a comparison/aggregate question. You see a sample of the most relevant reviews, not all reviews.
- State the sample size (e.g. "Among the 23 most relevant reviews...").
- Group findings by property.
- Never claim exact totals or rankings as fact; describe what the sample suggests.`;

/**
 * Both modes: what the reviews are, and what cannot be said from them. Counts never pass
 * through the model (docs/adr/0001), so it must not word a handful of search results as
 * a count. lib/sampleClaims.ts checks the answer for the same wordings.
 */
export const SAMPLE_RULES = `

What you are given (search results, not every review):
- The reviews below are the ones a search found closest to the question. They may or may not be every review on the topic, so they cannot show how many reviews mention something, or that nothing else does.
- Report what the reviews you cite say. Leave the reviews you do not use out of the answer: do not mention, count or cite them, and do not say what they lack.
- Do not write "the only review", "the only complaint", "only one review", "only two reviews", "no other review" or "the other reviews do not mention it". Write what a review says instead: "A review says the shuttle ran late [2]."
- When you need to describe the reviews as a group (for example because none of them covers the question, or they are too few to show a pattern), call them "the N reviews shown", using the number given above the reviews: "None of the 6 reviews shown mentions the shuttle."`;

/** The context heading states how many reviews follow, so the model never counts them itself. */
export function reviewsHeading(count: number): string {
  return `Reviews (the ${count} ${count === 1 ? "review" : "reviews"} shown; a search found ${count === 1 ? "it" : "them"} closest to the question):`;
}

/** Every answer-side prompt text, for the eval's check on questions quoted in prompts. */
export function answerPromptText(): string {
  return [
    ANSWER_INSTRUCTIONS,
    SAMPLE_RULES,
    AGGREGATE_RULES,
    reviewsHeading(8),
    buildNotes({ relaxed: true, dropped: ["a property"], portfolioAlias: "the company", ranksProperties: true }),
  ].join("\n");
}

function buildContext(sources: Source[], mode: QueryPlan["mode"]): string {
  const line = (s: Source) =>
    `[${s.n}] ${s.propertyName} (${s.propertyType}) · ${s.rating}★ · ${s.createdAt.slice(0, 10)}\n${s.text}`;

  if (mode === "specific") return sources.map(line).join("\n\n");

  const byProperty = new Map<string, Source[]>();
  for (const s of sources) {
    byProperty.set(s.propertyName, [...(byProperty.get(s.propertyName) ?? []), s]);
  }
  return [...byProperty.entries()]
    .map(([name, xs]) => `## ${name}: ${xs.length} of ${sources.length} reviews\n\n${xs.map(line).join("\n\n")}`)
    .join("\n\n");
}

async function loadThemes(db: StatsDb): Promise<ThemeInfo[]> {
  const { rows } = await db.query<ThemeInfo>("SELECT slug, label FROM themes ORDER BY id");
  return rows;
}

async function runStats(db: StatsDb, query: StatsQuery, s: StatsSettings): Promise<StatsOutcome> {
  const scope: StatsScope = {
    tagSource: s.tagSource,
    taxonomyVersion: s.taxonomyVersion,
    source: s.source,
    filters: query.filters,
  };
  switch (query.kind) {
    case "mentions":
      return { kind: "mentions", query, result: await themeMentions(db, scope, query) };
    case "ranking":
      return { kind: "ranking", query, result: await themeRanking(db, scope, { sentiment: query.sentiment }) };
    case "trend":
      return { kind: "trend", query, result: await themeTrend(db, scope, query) };
  }
}

type StatsAttempt =
  | { kind: "answered"; events: AnswerEvent[] }
  | { kind: "fallback"; note: string | null; code: FallbackCode | null };

/**
 * Try the statistics route. Returns the events to emit, or the note to show above
 * a retrieval answer. Input errors are answered directly; anything else falls back.
 */
async function tryStatistics(raw: PlannerOutput, deps: AnswerDeps): Promise<StatsAttempt> {
  const db = deps.statsDb();
  if (!db) {
    deps.logError("statistics unavailable: DATABASE_URL_READONLY is not set", null);
    return { kind: "fallback", note: STATS_UNAVAILABLE_NOTE, code: null };
  }
  try {
    const themes = await loadThemes(db);
    const decision = resolveRoute(raw, themes, deps.today);
    if (decision.route === "retrieval") {
      return { kind: "fallback", note: decision.fallback?.note ?? null, code: decision.fallback?.code ?? null };
    }

    const outcome = await runStats(db, decision.query, deps.stats);
    const text = renderStats(outcome, { themes, provisional: deps.stats.provisional });
    return { kind: "answered", events: [{ type: "stats", outcome }, { type: "delta", text }] };
  } catch (err) {
    const failure = statsFailure(err);
    if (failure.kind === "input") return { kind: "answered", events: [{ type: "delta", text: failure.message }] };
    deps.logError("statistics query failed", err);
    return { kind: "fallback", note: failure.note, code: null };
  }
}

export async function* answerWith(question: string, deps: AnswerDeps): AsyncGenerator<AnswerEvent> {
  const properties = await deps.listProperties();
  const raw = await deps.plan(question, properties, deps.today);
  // Retrieval drops unknown property names; statistics uses the raw names (decision 4).
  const { plan: sanitized, droppedPropertyNames, portfolioAlias } = sanitizePlan(raw, properties, question);
  // The event carries the route too, so the CLI and eval can see which path was taken.
  const eventPlan: PlannerOutput = { ...sanitized, route: raw.route, stat: raw.stat };
  yield { type: "plan", plan: eventPlan, droppedPropertyNames };

  if (raw.intent !== "review_insight") {
    yield { type: "declined", intent: raw.intent, message: DECLINE_MESSAGES[raw.intent] };
    yield { type: "done" };
    return;
  }

  let plan: QueryPlan = sanitized;
  let note: string | null = null;
  let fallback: FallbackCode | null = null;
  if (raw.route === "statistics") {
    const attempt = await tryStatistics(raw, deps);
    if (attempt.kind === "answered") {
      yield* attempt.events;
      yield { type: "done" };
      return;
    }
    note = attempt.note;
    fallback = attempt.code;
    // A question that wanted a count spans many reviews: use the larger sample.
    plan = { ...sanitized, mode: "aggregate" };
  }

  const { sources, relaxed } = await deps.retrieve(plan);
  if (sources.length === 0) {
    yield { type: "no_data", message: NO_DATA_MESSAGE };
    yield { type: "done" };
    return;
  }
  yield { type: "sources", sources, relaxed, fallback };
  if (note) yield { type: "delta", text: `${note}\n\n` };

  // A question that ranks properties but names no theme cannot be answered from search results.
  const ranksProperties = fallback === "property_needs_theme";
  const stream = deps.streamAnswer({
    instructions: ANSWER_INSTRUCTIONS + SAMPLE_RULES + (plan.mode === "aggregate" ? AGGREGATE_RULES : ""),
    input: `Question: ${question}${buildNotes({ relaxed, dropped: droppedPropertyNames, portfolioAlias, ranksProperties })}\n\n${reviewsHeading(sources.length)}\n\n${buildContext(sources, plan.mode)}`,
  });
  let written = "";
  for await (const text of stream) {
    written += text;
    yield { type: "delta", text };
  }
  // The text is already on screen, so this discloses the limit rather than correcting the claim.
  const counts = sampleCountClaims(written);
  const rankings = ranksProperties ? rankingClaims(written) : [];
  if (counts.length > 0 || rankings.length > 0) {
    deps.logError("answer words search results as a count or ranking", {
      claims: [...counts.map((c) => c.sentence), ...rankings],
    });
    yield { type: "delta", text: `\n\n${sampleCaveat(sources.length)}` };
  }
  yield { type: "done" };
}
