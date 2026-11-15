/**
 * The answer pipeline (lib/answerPipeline.ts) wired to the real planner, Qdrant,
 * OpenAI and the read-only database. Used by the API route, the CLI and the eval.
 */
import { answerWith, type AnswerEvent } from "./answerPipeline";
import { readonlyPool } from "./db/readonlyPool";
import { env } from "./env";
import { embed, openai } from "./openai";
import { planAndRoute } from "./plan";
import { createPropertyLister, propertiesFromDb } from "./properties";
import { indexedProperties, searchReviews } from "./qdrant";
import { retrieve } from "./retrieve";
import { statsSettings } from "./statsSettings";
import { localToday } from "./today";

export type { AnswerEvent } from "./answerPipeline";

const logError = (message: string, err: unknown) => console.error(message, err ?? "");

/** One list per process, shared by every question (see lib/properties.ts for the caching rules). */
const listProperties = createPropertyLister({
  primary: () => {
    const db = readonlyPool();
    if (!db) throw new Error("DATABASE_URL_READONLY is not set");
    return propertiesFromDb(db, statsSettings().source);
  },
  fallback: indexedProperties,
  logError,
});

export function answerQuestion(question: string, opts: { today?: string } = {}): AsyncGenerator<AnswerEvent> {
  return answerWith(question, {
    listProperties,
    plan: planAndRoute,
    retrieve: (plan) => retrieve(plan, { embed, search: searchReviews }),
    async *streamAnswer({ instructions, input }) {
      const stream = openai.responses.stream({ model: env.OPENAI_CHAT_MODEL, instructions, input });
      for await (const event of stream) {
        if (event.type === "response.output_text.delta") yield event.delta;
      }
    },
    statsDb: readonlyPool,
    stats: statsSettings(),
    // One date per question, in the portfolio's local time.
    today: opts.today ?? localToday(),
    logError,
  });
}
