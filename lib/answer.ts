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
- Quote guests' exact wording (in quotes) where it would help marketing copy. Put quote marks only around words copied exactly from a review; paraphrase without quote marks.
- Never name or describe individual reviewers.
- Never invent numbers, percentages or facts not in the reviews.
- Make no frequency or ranking claims ("most often", "most guests", "the top theme", "across all properties") unless the reviews provided clearly show it. Otherwise say what the reviews say, e.g. "Reviews mention X [1][3]".
- Be concise: a short direct answer, then supporting points as bullets.

Thin evidence (say so plainly instead of filling the gap):
- Describe a trend or change over time only if the reviews come from clearly different periods. If they are few or close together in time, say there is not enough to show a change.
- Compare two groups of guests only if the reviews identify both groups. Otherwise say which group has no evidence and do not infer one from tone or topic.
- If the question needs material you were not given (for example property descriptions), say you cannot answer that part. Do not guess or list candidates for what might be missing.`;

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
      "The requested time period or rating filter matched no reviews, so these results ignore it. Your first sentence must say there are no reviews for that period or rating and that the answer uses reviews from other dates or ratings.",
    );
  }
  if (dropped.length) {
    notes.push(
      `The question mentions ${dropped.join(", ")}, which has no reviews in our data. Your first sentence must say there are no reviews for ${dropped.join(", ")}. Then answer only if the reviews below are still useful, and say they are from other properties.`,
    );
  }
  return notes.length ? `\n\nNotes:\n- ${notes.join("\n- ")}` : "";
}

export async function* answerQuestion(
  question: string,
  opts: { today?: string } = {},
): AsyncGenerator<AnswerEvent> {
  const properties = await listProperties();
  const { plan, droppedPropertyNames } = sanitizePlan(
    await planQuery(question, properties, opts.today),
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
