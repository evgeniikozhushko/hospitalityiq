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
