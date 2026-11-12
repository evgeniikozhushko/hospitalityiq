/**
 * Small LLM judge for the two checks regex cannot do:
 *  - does the answer acknowledge a stated limitation (no coverage, ignored filter, unknown property)?
 *  - is every claim in the answer supported by the cited reviews?
 * Used only by scripts/eval.ts. A judge failure returns pass: null (unknown), never a crash.
 */
import { zodTextFormat } from "openai/helpers/zod";
import { z } from "zod";
import { env } from "./env";
import { openai } from "./openai";

const Verdict = z.object({ pass: z.boolean(), reason: z.string() });
export type JudgeResult = { pass: boolean | null; reason: string };

async function judge(instructions: string, input: string): Promise<JudgeResult> {
  try {
    const res = await openai.responses.parse({
      model: process.env.OPENAI_JUDGE_MODEL || env.OPENAI_CHAT_MODEL,
      instructions,
      input,
      text: { format: zodTextFormat(Verdict, "verdict") },
    });
    return res.output_parsed ?? { pass: null, reason: "judge returned no output" };
  } catch (err) {
    return { pass: null, reason: `judge error: ${(err as Error).message}` };
  }
}

/** Does the answer clearly state the given limitation to the reader? */
export function judgeAcknowledges(answer: string, requirement: string): Promise<JudgeResult> {
  return judge(
    "You grade answers from a review-analysis assistant. Reply pass=true only if the answer clearly tells the reader the following, in its own words. Do not reward answers that merely hint at it or that invent evidence instead. Keep reason to one sentence.",
    `Requirement: ${requirement}\n\nAnswer:\n${answer}`,
  );
}

/** Is every factual claim in the answer supported by the numbered reviews it was given? */
export function judgeGrounded(answer: string, reviews: string): Promise<JudgeResult> {
  return judge(
    "You grade whether an answer is grounded. Reply pass=true only if every factual claim in the answer is supported by the numbered reviews. Statements that the reviews do not cover something are fine. Keep reason to one sentence.",
    `Reviews:\n${reviews}\n\nAnswer:\n${answer}`,
  );
}

/**
 * Does a sample-based answer avoid stating a number as if it covered all reviews?
 * (docs/routing-plan.md, Eval). pass=true means no such claim. Only used on answers
 * built from a sample of reviews; exact counts come from the statistics route.
 */
export function judgeNoSampleCounts(answer: string): Promise<JudgeResult> {
  return judge(
    "You grade answers from a review-analysis assistant that reads only a SAMPLE of the most relevant reviews, never all of them. Reply pass=false if the answer states a number of reviews, guests or mentions as if it were a count over all reviews (for example \"only one review mentions parking\", \"most guests\", \"3 reviews complain\", \"no other reviews mention it\") without saying the number comes from the sample shown. Reply pass=true if it gives no such number, or clearly ties every number to the sample (for example \"among the 8 most relevant reviews\"). Citation numbers like [2] are not counts. Keep reason to one sentence.",
    `Answer:\n${answer}`,
  );
}
