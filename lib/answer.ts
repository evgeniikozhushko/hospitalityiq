/**
 * Answer a marketing question from reviews:
 *   plan -> (decline | retrieve) -> stream a cited answer.
 *
 * Yields events so the same pipeline drives the API route (NDJSON) and the CLI.
 */
import { env } from "./env";
import { sanitizePlan } from "./filters";
import { embed, openai } from "./openai";
import { planQuery } from "./plan";
import { listProperties, searchReviews } from "./qdrant";
import { retrieve } from "./retrieve";
import {
  DECLINE_MESSAGES,
  NO_DATA_MESSAGE,
  type QueryIntent,
  type QueryPlan,
  type Source,
} from "./schema";

export type AnswerEvent =
  | { type: "plan"; plan: QueryPlan; droppedPropertyNames: string[] }
  | { type: "declined"; intent: Exclude<QueryIntent, "review_insight">; message: string }
  | { type: "no_data"; message: string }
  | { type: "sources"; sources: Source[]; relaxed: boolean }
  | { type: "delta"; text: string }
  | { type: "done" };

const ANSWER_INSTRUCTIONS = `You are HospitalityIQ, helping a hospitality marketing team understand guest reviews.

Answer the question using ONLY the numbered reviews provided.

Rules:
- Ignore reviews that don't address the question. If none of them do, say the reviews don't cover it. Don't stretch unrelated reviews to fit.
- Cite every claim with the review number in square brackets, e.g. [2] or [1][4]. Only cite numbers that exist.
- Quote guests' exact wording (in quotes) where it would help marketing copy.
- Never name or describe individual reviewers.
- Never invent numbers, percentages or facts not in the reviews.
- Be concise: a short direct answer, then supporting points as bullets.`;

const AGGREGATE_RULES = `
This is a comparison/aggregate question. You see a sample of the most relevant reviews, not all reviews.
- State the sample size (e.g. "Among the 23 most relevant reviews...").
- Group findings by property.
- Never claim exact totals or rankings as fact; describe what the sample suggests.`;

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

function buildNotes(relaxed: boolean, dropped: string[]): string {
  const notes: string[] = [];
  if (relaxed) {
    notes.push(
      "The requested time period or rating filter matched no reviews, so these results ignore it. Say so briefly at the start.",
    );
  }
  if (dropped.length) {
    notes.push(
      `The question mentions ${dropped.join(", ")}, which has no reviews in our data. Say so at the start, then answer only if the reviews below are still useful.`,
    );
  }
  return notes.length ? `\n\nNotes:\n- ${notes.join("\n- ")}` : "";
}

export async function* answerQuestion(question: string): AsyncGenerator<AnswerEvent> {
  const properties = await listProperties();
  const { plan, droppedPropertyNames } = sanitizePlan(
    await planQuery(question, properties),
    properties,
  );
  yield { type: "plan", plan, droppedPropertyNames };

  if (plan.intent !== "review_insight") {
    yield { type: "declined", intent: plan.intent, message: DECLINE_MESSAGES[plan.intent] };
    yield { type: "done" };
    return;
  }

  const { sources, relaxed } = await retrieve(plan, { embed, search: searchReviews });
  if (sources.length === 0) {
    yield { type: "no_data", message: NO_DATA_MESSAGE };
    yield { type: "done" };
    return;
  }
  yield { type: "sources", sources, relaxed };

  const stream = openai.responses.stream({
    model: env.OPENAI_CHAT_MODEL,
    instructions: ANSWER_INSTRUCTIONS + (plan.mode === "aggregate" ? AGGREGATE_RULES : ""),
    input: `Question: ${question}${buildNotes(relaxed, droppedPropertyNames)}\n\nReviews:\n\n${buildContext(sources, plan.mode)}`,
  });
  for await (const event of stream) {
    if (event.type === "response.output_text.delta") {
      yield { type: "delta", text: event.delta };
    }
  }
  yield { type: "done" };
}
