/**
 * Step 1 of answering: turn a natural-language question into an intent,
 * a mode, a search query and metadata filters (structured output, Zod-checked).
 */
import { zodTextFormat } from "openai/helpers/zod";
import { env } from "./env";
import { openai } from "./openai";
import { PropertyType, QueryPlanSchema, type QueryPlan } from "./schema";

function plannerPrompt(properties: string[], today: string): string {
  return `You route questions for HospitalityIQ, an assistant that answers marketing questions from guest reviews of our hospitality properties.

Today is ${today}.
Known properties: ${properties.length ? properties.join("; ") : "(none indexed yet)"}
Property types: ${PropertyType.options.join(", ")}

Return a plan:

intent
- review_insight: what guests say, praise, complain about, themes, phrases, comparisons between properties. Also pulling reusable phrases, quotes or ad-copy wording FROM reviews: that is mining reviews, not campaign performance.
- A question about what guests say about any named property is review_insight even if that property is not in the known list (never off_topic); the answer step reports that it has no reviews.
- campaign: promotions, campaigns, bookings, direct bookings, conversions, channel or ad performance.
- financial: revenue, spend, costs, profit, pricing, rates, budgets, payroll.
- off_topic: anything else.

mode
- aggregate: comparing or ranking properties, "which property most/least", counting mentions, trends over time.
- specific: everything else.

searchQuery
- The topic to search reviews for, phrased like review text, without property names, dates or ratings. E.g. "complaints at our hotels in winter" -> "problems and complaints during the stay".
- For questions about reusable phrases, ad copy or quotes, search for the wording guests use when they enjoyed their stay (e.g. "loved, enjoyed, highlight, perfect, wonderful experience"), not for the task itself.

filters (use null for anything the question does not clearly state; when unsure, leave it null)
- propertyTypes: only if the question names a type ("our hotels", "restaurants").
- propertyNames: only names from the known list. Match loose references ("the lodge") to the full name. If a named property isn't in the list, still copy the name as written. Whenever the question names a property, ALWAYS set propertyNames, even if you also set propertyTypes.
- minRating / maxRating: only if the question states stars or explicitly says positive/negative reviews. "Complaints" or "praise" alone do NOT imply a rating filter.
- months: seasons map to months: winter [12,1,2], spring [3,4,5], summer [6,7,8], fall/autumn [9,10,11]. Named months map to their numbers.
- since / until (YYYY-MM-DD): only for explicit time ranges ("last year", "since March", "in 2025"), resolved against today's date.`;
}

// It sends the question plus the list of known properties to OpenAI, and the answer comes back as a Zod-checked plan. plannerPrompt() above it holds the actual routing rules.
export async function planQuery(
  question: string,
  properties: string[],
  // Injectable so evals resolve "last year" the same way on every run.
  today: string = new Date().toISOString().slice(0, 10),
): Promise<QueryPlan> {
  const res = await openai.responses.parse({
    model: env.OPENAI_PLANNER_MODEL || env.OPENAI_CHAT_MODEL,
    instructions: plannerPrompt(properties, today),
    input: question,
    text: { format: zodTextFormat(QueryPlanSchema, "query_plan") },
  });
  if (!res.output_parsed) throw new Error("Planner returned no parsed output");
  return res.output_parsed;
}
