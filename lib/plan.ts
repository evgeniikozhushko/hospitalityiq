/**
 * Step 1 of answering, as two model calls run in parallel:
 *  - planQuery: intent, mode, search query and metadata filters. Its prompt and schema
 *    are exactly as before statistics routing: adding routing to this one call shifted
 *    retrieval plans (aggregate became specific, a spa filter was lost) in the eval.
 *  - routeQuery: whether the question wants an exact count, and of what (route + stat).
 *    Only a suggestion: lib/route.ts checks it before any SQL runs.
 * planAndRoute merges the two.
 */
import { zodTextFormat } from "openai/helpers/zod";
import { env } from "./env";
import { COMPANY_ALIASES } from "./filters";
import { openai } from "./openai";
import {
  PlannerOutputSchema,
  PropertyType,
  QueryPlanSchema,
  type PlannerOutput,
  type QueryPlan,
} from "./schema";
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

mode
- aggregate: comparing or ranking properties, "which property most/least", counting mentions, trends over time.
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
- since / until (YYYY-MM-DD): only for explicit time ranges ("last year", "since March", "in 2025"), resolved against today's date.`;
}

// It sends the question plus the list of known properties to OpenAI, and the answer comes back as a Zod-checked plan. plannerPrompt() above it holds the actual routing rules.
export async function planQuery(
  question: string,
  properties: string[],
  // Injectable so evals resolve "last year" the same way on every run. Local, not UTC.
  today: string = localToday(),
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

/** The routing call's output: everything PlannerOutput adds to a QueryPlan. */
const RouteOutputSchema = PlannerOutputSchema.pick({ route: true, stat: true });
type RouteOutput = Pick<PlannerOutput, "route" | "stat">;

function routePrompt(): string {
  return `You decide whether a marketing question about guest reviews of our hospitality properties wants an exact count, and of what. Another step handles everything else (search terms, filters, dates).

route (use retrieval for anything that is not about what guests say in reviews: revenue, bookings, campaigns, off-topic)
- Decide the route from the FORM of the question, not from whether its topic is on the theme list. "How many reviews mention the thermal pool?" is statistics even though the thermal pool is not a theme (stat.themes is then an empty list); code explains that it can only count themes.
- statistics: the question asks for a number: "how many", counts, "most/least", rankings, "top themes", "which property gets the most X", or how something "changed over time". Also "what do guests complain about MOST" and "what do guests praise most about our restaurants" (rankings of complaints or praise, with or without a property type), and a question that asks both for a count and for what guests say ("how many complain about parking, and what do they say?").
- retrieval: everything else: what guests say, praise, love or complain about without a counting or ranking word ("what do our five-star reviewers love?", "what do guests say about parking?"), quotes, reusable phrases, descriptions and comparisons in words.
- Always retrieval, even when the question says "most": writing tasks (a blurb, ad copy, a description "using what guests love most"), and questions that compare reviews with material you were not given ("which amenities do guests mention that our descriptions leave out"). These need guests' words, not a count. So do comparisons between groups of guests ("what do families say compared with couples").

stat (null when route is retrieval)
- kind: mentions = how many reviews mention one theme, overall or per property ("how many mention parking", "which properties get the most cleanliness complaints"). ranking = which THEMES come up most ("top themes", "what do guests complain about most"). A ranking ranks themes, never properties: a question about which PROPERTY gets the most of something is never a ranking. trend = how mentions of one theme changed over a period ("has check-in feedback changed over the last year").
- themes: slugs from the theme list below, one entry per theme the question asks about. Use a slug ONLY when the question's topic is that theme or one of its listed synonyms. A narrower or different topic (for example "breakfast", "the thermal pool", "noise") is not a theme: use an empty list. Never use "other". Use null for a ranking. "Which property gets the most complaints" asks about properties and names no theme: kind mentions with an empty themes list (not a ranking).
- topic: the subject of the question in the user's own words ("breakfast", "check-in", "parking or value"); null for a ranking.
- sentiment: negative for complaints or problems, positive for praise, null for mentions in general or "good or bad".
- ranks: what a "most" or ranking question compares. themes = which topics come up most ("what do guests complain about most"). properties = which property, hotel or restaurant has the most of something ("which property gets the most complaints", "which properties get the most cleanliness mentions"). null when nothing is compared ("how many mention parking").

Themes:
${themeGuideText()}`;
}

export async function routeQuery(question: string): Promise<RouteOutput> {
  const res = await openai.responses.parse({
    model: env.OPENAI_PLANNER_MODEL || env.OPENAI_CHAT_MODEL,
    instructions: routePrompt(),
    input: question,
    text: { format: zodTextFormat(RouteOutputSchema, "route_plan") },
  });
  if (!res.output_parsed) throw new Error("Router returned no parsed output");
  return res.output_parsed;
}

/** Both planning calls at once: no added wait. */
export async function planAndRoute(
  question: string,
  properties: string[],
  today: string = localToday(),
): Promise<PlannerOutput> {
  const [plan, route] = await Promise.all([planQuery(question, properties, today), routeQuery(question)]);
  return { ...plan, ...route };
}
