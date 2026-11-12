/**
 * The answer pipeline (lib/answerPipeline.ts) wired to the real planner, Qdrant,
 * OpenAI and the read-only database. Used by the API route, the CLI and the eval.
 */
import { answerWith, type AnswerEvent } from "./answerPipeline";
import { readonlyPool } from "./db/readonlyPool";
import { env } from "./env";
import { embed, openai } from "./openai";
import { planQuery } from "./plan";
import { listProperties, searchReviews } from "./qdrant";
import { retrieve } from "./retrieve";
import { statsSettings } from "./statsSettings";
import { localToday } from "./today";

export type { AnswerEvent } from "./answerPipeline";

export function answerQuestion(question: string, opts: { today?: string } = {}): AsyncGenerator<AnswerEvent> {
  return answerWith(question, {
    listProperties,
    plan: planQuery,
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
    logError: (message, err) => console.error(message, err ?? ""),
  });
}
