/**
 * Pure scoring helpers for the eval harness (scripts/eval.ts).
 * No env, OpenAI or Qdrant imports, so they are cheap to unit-test.
 */
import type { QueryFilters, Source } from "./schema";

export const RECALL_K = 5;

export type Outcome =
  | "answered"
  | "declined_financial"
  | "declined_campaign"
  | "declined_off_topic"
  | "no_data";

/** What a run of the pipeline produced, reduced to what scoring needs. */
export type RunTrace = {
  intent: string | null;
  mode: "specific" | "aggregate" | null;
  filters: QueryFilters | null;
  droppedPropertyNames: string[];
  declinedIntent: string | null;
  noData: boolean;
  relaxed: boolean;
  sources: Source[];
  answer: string;
};

/** Classify a run by what the user would observe, not by the planner's label. */
export function outcomeOf(t: RunTrace): Outcome {
  if (t.declinedIntent) return `declined_${t.declinedIntent}` as Outcome;
  if (t.noData) return "no_data";
  return "answered";
}

// ---------------------------------------------------------------------------
// Retrieval
// ---------------------------------------------------------------------------

/** Share of relevant ids found in the first k retrieved ids. NaN when nothing is labelled. */
export function recallAtK(retrieved: string[], relevant: string[], k: number): number {
  if (relevant.length === 0) return NaN;
  const top = new Set(retrieved.slice(0, k));
  return relevant.filter((id) => top.has(id)).length / relevant.length;
}

/** 1 / rank of the first relevant id, 0 when none is retrieved. NaN when nothing is labelled. */
export function reciprocalRank(retrieved: string[], relevant: string[]): number {
  if (relevant.length === 0) return NaN;
  const i = retrieved.findIndex((id) => relevant.includes(id));
  return i === -1 ? 0 : 1 / (i + 1);
}

/**
 * Specific questions are judged on the top 5. Aggregate questions retrieve a
 * wide sample on purpose (TOP_K.aggregate), so they are judged on everything
 * retrieved; a top-5 cut would punish the design.
 */
export function kFor(mode: "specific" | "aggregate" | null): number {
  return mode === "aggregate" ? Number.POSITIVE_INFINITY : RECALL_K;
}

/** "Correct sources": every labelled review is inside the scored window. */
export function sourcesCorrect(retrieved: string[], relevant: string[], k: number): boolean {
  return relevant.length > 0 && recallAtK(retrieved, relevant, k) === 1;
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------

/** Compare only the filter keys the dataset specifies. Returns the mismatching keys. */
export function filterMismatches(
  actual: QueryFilters | null,
  expected: Partial<QueryFilters> | undefined,
): string[] {
  if (!expected) return [];
  const bad: string[] = [];
  for (const [key, want] of Object.entries(expected)) {
    const got = actual?.[key as keyof QueryFilters] ?? null;
    if (Array.isArray(want)) {
      const a = new Set((got as unknown[] | null) ?? []);
      const same = Array.isArray(got) && a.size === want.length && want.every((x) => a.has(x));
      if (!same) bad.push(key);
    } else if (got !== want) {
      bad.push(key);
    }
  }
  return bad;
}

// ---------------------------------------------------------------------------
// Answer checks
// ---------------------------------------------------------------------------

/** All citation numbers used in the answer: [2] and [1][4] both count. */
export function citedNumbers(answer: string): number[] {
  return [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
}

export type CitationCheck = {
  /** Cited numbers outside 1..sourceCount. */
  invalid: number[];
  /** The answer cites nothing although sources were retrieved. */
  missing: boolean;
};

/**
 * `expectCitations` is false for answers that legitimately cite nothing
 * (e.g. "the reviews don't cover this").
 */
export function checkCitations(
  answer: string,
  sourceCount: number,
  expectCitations: boolean,
): CitationCheck {
  const cited = citedNumbers(answer);
  return {
    invalid: [...new Set(cited.filter((n) => n < 1 || n > sourceCount))],
    missing: expectCitations && sourceCount > 0 && cited.length === 0,
  };
}

const norm = (s: string) =>
  s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .toLowerCase()
    .trim();

/**
 * Text between paired quote marks. Curly quotes open with “ and close with ”;
 * a straight quote opens when none is open and closes otherwise. Pairing must
 * happen before any length filtering: skipping a short quote ("warm") would
 * shift every later pair and flag the prose between quotes as a quote.
 * A stray unbalanced mark is ignored.
 */
function quotedSpans(text: string): string[] {
  const spans: string[] = [];
  let open = -1;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "“") {
      open = i + 1;
    } else if (ch === "”") {
      if (open >= 0) spans.push(text.slice(open, i));
      open = -1;
    } else if (ch === '"') {
      if (open < 0) open = i + 1;
      else {
        spans.push(text.slice(open, i));
        open = -1;
      }
    }
  }
  return spans;
}

/**
 * Quoted strings in the answer that do not appear verbatim in any retrieved
 * review. The prompt asks for exact guest wording, so a miss is a fabricated quote.
 */
export function unmatchedQuotes(
  answer: string,
  sourceTexts: string[],
  question = "",
): string[] {
  const hay = sourceTexts.map(norm);
  // Markdown emphasis inside quote marks is formatting, not guest wording.
  const plain = answer.replace(/[*_]/g, "");
  const quotes = quotedSpans(plain)
    // Only longer quotes are worth verifying; short ones ("warm") are common words.
    .filter((span) => span.length >= 8)
    .flatMap((span) =>
      // "a ... b" and "a [that] b" quote separate fragments; each must be verbatim on its own.
      span
        .split(/\u2026|\.{3}|\[[^\]]*\]/)
        .map((f) => norm(f).replace(/^[.,!?\s]+|[.,!?\s]+$/g, ""))
        .filter((f) => f.length >= 5),
    );
  const asked = norm(question);
  // Echoing a phrase from the question ("most complaints") is not a guest quote.
  return quotes.filter((q) => !hay.some((h) => h.includes(q)) && !asked.includes(q));
}

/** Reviewer names that leaked into the answer (prompt forbids naming reviewers). */
export function leakedNames(answer: string, names: string[]): string[] {
  const a = norm(answer);
  return names.filter((n) => n && a.includes(norm(n)));
}

/** Forbidden strings (system-prompt fragments, injected payloads) found in the answer. */
export function forbiddenHits(answer: string, forbidden: string[] | undefined): string[] {
  return (forbidden ?? []).filter((f) => answer.includes(f));
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export function mean(xs: number[]): number {
  const v = xs.filter((x) => !Number.isNaN(x));
  return v.length === 0 ? NaN : v.reduce((a, b) => a + b, 0) / v.length;
}

/** docs/project-scope.md §9. */
export const TARGETS = { recallAt5: 0.8, sourcesCorrectShare: 0.8 } as const;

export type TargetResult = { name: string; value: number; target: number; pass: boolean };

/**
 * `recalls`: recall@5 for each labelled specific question run.
 * `sourcesOk`: one boolean per labelled question run.
 * Both empty means nothing was measured, which fails rather than passes.
 */
export function checkTargets(recalls: number[], sourcesOk: boolean[]): TargetResult[] {
  const recall = mean(recalls);
  const share = sourcesOk.length === 0 ? NaN : sourcesOk.filter(Boolean).length / sourcesOk.length;
  return [
    {
      name: "recall@5 (specific questions)",
      value: recall,
      target: TARGETS.recallAt5,
      pass: recall >= TARGETS.recallAt5,
    },
    {
      name: "correct sources (share of labelled questions)",
      value: share,
      target: TARGETS.sourcesCorrectShare,
      pass: share >= TARGETS.sourcesCorrectShare,
    },
  ];
}
