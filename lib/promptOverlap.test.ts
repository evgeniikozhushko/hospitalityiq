/**
 * Guards the eval's "question quoted in a prompt" split: an edit to any prompt, including
 * the answer-side blocks and notes, must not quote an eval question it did not quote before.
 * The expected set is the one saved in evals/baselines/post-audit-fixes.json.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { answerPromptText } from "./answerPipeline";
import { quotedInPrompts } from "./evalMetrics";

const QUOTED = ["q01", "q02", "q03", "q04", "q05", "q06", "q08", "q10", "q14", "q17", "q20", "q21", "q23", "q26", "q31", "q33", "q34", "q37"];

describe("eval questions quoted in the prompts", () => {
  it("is exactly the same set of question ids as before", async () => {
    // lib/plan.ts reads the environment on import; no request is made.
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-used");
    const { plannerPrompt, routePrompt } = await import("./plan");
    const dataset = JSON.parse(readFileSync("evals/dataset.json", "utf8")) as {
      today: string;
      cases: Array<{ id: string; question: string }>;
    };
    const promptText = [plannerPrompt([], dataset.today), routePrompt(), answerPromptText()].join("\n");
    const quoted = dataset.cases.filter((c) => quotedInPrompts(c.question, promptText)).map((c) => c.id);
    expect(quoted).toEqual(QUOTED);
  });

  it("covers the new answer-side text", () => {
    const text = answerPromptText();
    expect(text).toContain("search results, not every review");
    expect(text).toContain("cannot show which property has the most");
    expect(text).toContain("Reviews (the 8 reviews shown");
  });
});
