/**
 * Step 1 of answering: turn a natural-language question into an intent, a route
 * (retrieval or statistics), a mode, a search query and metadata filters
 * (structured output, Zod-checked). The route is only a suggestion: lib/route.ts
 * checks it before any SQL runs.
 */
import { zodTextFormat } from "openai/helpers/zod";
import { env } from "./env";
import { COMPANY_ALIASES } from "./filters";
import { openai } from "./openai";
import { PlannerOutputSchema, PropertyType, type PlannerOutput } from "./schema";
import { themeGuideText } from "./themeGuide";
import { localToday } from "./today";

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

route (only for review_insight; use retrieval for every other intent)
- statistics: the question asks for a number: "how many", counts, "most/least", rankings, "top themes", "which property gets the most X", or how something "changed over time". Also "what do guests complain about MOST" (a ranking of complaints), and a question that asks both for a count and for what guests say ("how many complain about parking, and what do they say?").
- retrieval: everything else: what guests say, praise or complain about (without "most"), quotes, reusable phrases, descriptions and comparisons in words.

stat (null when route is retrieval)
- kind: mentions = how many reviews mention one theme, overall or per property ("how many mention parking", "which properties get the most cleanliness complaints"). ranking = which themes come up most ("top themes", "what do guests complain about most"). trend = how mentions of one theme changed over a period ("has check-in feedback changed over the last year").
- themes: slugs from the theme list below, one entry per theme the question asks about. Use a slug ONLY when the question's topic is that theme or one of its listed synonyms. A narrower or different topic (for example "breakfast", "the thermal pool", "noise") is not a theme: use an empty list. Never use "other". Use null for a ranking. "Which property gets the most complaints" names no theme: kind mentions with an empty list.
- topic: the subject of the question in the user's own words ("breakfast", "check-in", "parking or value"); null for a ranking.
- sentiment: negative for complaints or problems, positive for praise, null for mentions in general or "good or bad".

Themes:
${themeGuideText()}

mode
- aggregate: comparing or ranking properties in words, "which property most/least", questions that span many reviews across properties.
- specific: everything else.

searchQuery
- The topic to search reviews for, phrased like review text, without property names, dates or ratings. E.g. "complaints at our hotels in winter" -> "problems and complaints during the stay".
- For questions about reusable phrases, ad copy or quotes, search for the wording guests use when they enjoyed their stay (e.g. "loved, enjoyed, highlight, perfect, wonderful experience"), not for the task itself.

filters (use null for anything the question does not clearly state; when unsure, leave it null)
- propertyTypes: only if the question names a type ("our hotels", "restaurants").
- propertyNames: only names from the known list. Match loose references ("the lodge") to the full name. If a named property isn't in the list, still copy the name as written. Whenever the question names a property, ALWAYS set propertyNames, even if you also set propertyTypes.
- Company names are NOT properties: ${[...COMPANY_ALIASES].map((a) => `"${a}"`).join(", ")} (any capitalization or punctuation), "our company" and "all our properties" mean the whole portfolio. For these leave propertyNames null, and propertyTypes null unless the question also names a type ("all our hotels" -> propertyTypes ["hotel"]). A name that merely starts like the company but is not exactly it (for example "Banff Caribou Lodge") is a property name.
- minRating / maxRating: only if the question states stars or explicitly says positive/negative reviews. "Complaints" or "praise" alone do NOT imply a rating filter.
- months: seasons map to months: winter [12,1,2], spring [3,4,5], summer [6,7,8], fall/autumn [9,10,11]. Named months map to their numbers.
- since / until (YYYY-MM-DD): only for explicit time ranges ("last year", "since March", "in 2025"), resolved against today's date. For "over the last year" set since to one year before today and leave until null.`;
}

// It sends the question plus the list of known properties to OpenAI, and the answer comes back as a Zod-checked plan. plannerPrompt() above it holds the actual routing rules.
export async function planQuery(
  question: string,
  properties: string[],
  // Injectable so evals resolve "last year" the same way on every run. Local, not UTC.
  today: string = localToday(),
): Promise<PlannerOutput> {
  const res = await openai.responses.parse({
    model: env.OPENAI_PLANNER_MODEL || env.OPENAI_CHAT_MODEL,
    instructions: plannerPrompt(properties, today),
    input: question,
    text: { format: zodTextFormat(PlannerOutputSchema, "query_plan") },
  });
  if (!res.output_parsed) throw new Error("Planner returned no parsed output");
  return res.output_parsed;
}
