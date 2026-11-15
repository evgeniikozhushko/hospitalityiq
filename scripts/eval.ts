/**
 * Run the eval dataset through the real pipeline (answerQuestion) and score it.
 *
 * Usage: npm run eval -- [--runs 3] [--only q01,q05] [--judge] [--baseline name] [--no-fail]
 *   --runs N         repeat each question N times (planner and answerer are non-deterministic)
 *   --only ids       run a subset
 *   --judge          also grade groundedness and sample figures stated as counts with an LLM
 *                    (acknowledgement checks always use it)
 *   --baseline name  also save the results as evals/baselines/<name>.json (never overwrites)
 *   --no-fail        always exit 0
 *
 * Cases are reported in three groups (docs/routing-plan.md, Eval), so a statistics win
 * cannot hide a retrieval regression:
 *   regression  scored exactly as before, compared case by case with REGRESSION_BASELINE
 *   statistics  path and exact numbers (hand-computed from data/manual-tags.json)
 *   boundary    path only: questions that must stay on retrieval or fall back honestly
 * A case passes only when it passes every run.
 * Needs local Qdrant with data ingested (npm run ingest). LangSmith is optional.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { answerQuestion } from "../lib/answer";
import { env } from "../lib/env";
import { judgeAcknowledges, judgeGrounded, judgeNoSampleCounts, type JudgeResult } from "../lib/evalJudge";
import {
  checkCitations,
  checkTargets,
  compareToBaseline,
  filterMismatches,
  forbiddenHits,
  kFor,
  leakedNames,
  mean,
  missingText,
  outcomeOf,
  pathOf,
  recallAtK,
  reciprocalRank,
  sourcesCorrect,
  splitNote,
  unmatchedQuotes,
  type Outcome,
  type Path,
  type RunTrace,
} from "../lib/evalMetrics";
import type { PlannerOutput, QueryFilters } from "../lib/schema";

/** The run the regression group is compared with (committed, never overwritten). */
const REGRESSION_BASELINE = "evals/baselines/pre-statistics-routing.json";
/** A known judge miss unrelated to routing, reported apart from the regression check. */
const REPORT_SEPARATELY = ["q05"];

type Group = "regression" | "statistics" | "boundary";

type Case = {
  id: string;
  group: Group;
  type: "retrieval" | "generative" | "behavior" | "statistics";
  question: string;
  expectedOutcome: Outcome;
  expectedMode?: "specific" | "aggregate";
  relevantReviewIds?: string[];
  expectedFilters?: Partial<QueryFilters>;
  expectRelaxed?: boolean;
  expectDroppedProperty?: boolean;
  mustAcknowledge?: string;
  mustNotContain?: string[];
  /** The path the question must take (statistics and boundary groups). */
  expectedPath?: Path;
  /** Exact snippets the answer must contain: hand-computed numbers or fixed notes. */
  mustContain?: string[];
  notes?: string;
};

type Check = { name: string; pass: boolean | null; detail?: string };
type RunResult = {
  caseId: string;
  outcome: Outcome;
  path: Path | null;
  mode: string | null;
  retrievedIds: string[];
  recall: number;
  rr: number;
  sourcesOk: boolean | null;
  checks: Check[];
  pass: boolean;
  /** Judge: does a sample-based answer state a figure as a count? Reported, not part of pass. */
  sampleCount: JudgeResult | null;
  answer: string;
  seconds: number;
};

const args = process.argv.slice(2);
const flag = (n: string) => args.includes(`--${n}`);
const opt = (n: string) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const RUNS = Number(opt("runs") ?? 1);

/** Where --baseline saves, checked before any (paid) run starts. */
function baselinePath(): string | null {
  if (!flag("baseline")) return null;
  const name = opt("baseline");
  if (!name || !/^[a-z0-9-]+$/.test(name)) {
    throw new Error("--baseline needs a name of lowercase letters, digits and dashes, e.g. --baseline post-statistics-routing");
  }
  const file = `evals/baselines/${name}.json`;
  if (existsSync(file)) throw new Error(`${file} exists; saved baselines are never overwritten.`);
  return file;
}
const baselineFile = baselinePath();

const datasetRaw = readFileSync("evals/dataset.json", "utf8");
const dataset = JSON.parse(datasetRaw) as { today: string; cases: Case[] };
const only = opt("only")?.split(",");
const cases = dataset.cases.filter((c) => !only || only.includes(c.id));

// Reviewer display names from the fixtures: none may appear in an answer.
const reviewerNames: string[] = (
  JSON.parse(readFileSync("data/sample-reviews.json", "utf8")) as {
    reviews: { reviewer?: { displayName?: string } }[];
  }[]
).flatMap((loc) => loc.reviews.map((r) => r.reviewer?.displayName ?? ""));

async function collect(question: string): Promise<RunTrace> {
  const t: RunTrace = {
    intent: null,
    mode: null,
    filters: null,
    droppedPropertyNames: [],
    declinedIntent: null,
    noData: false,
    relaxed: false,
    sources: [],
    answer: "",
    planRoute: null,
    statsKind: null,
  };
  for await (const e of answerQuestion(question, { today: dataset.today })) {
    if (e.type === "plan") {
      // The pipeline sends the full planner output, route included.
      t.planRoute = (e.plan as Partial<PlannerOutput>).route ?? null;
      t.intent = e.plan.intent;
      t.mode = e.plan.mode;
      t.filters = e.plan.filters;
      t.droppedPropertyNames = e.droppedPropertyNames;
    } else if (e.type === "declined") t.declinedIntent = e.intent;
    else if (e.type === "no_data") t.noData = true;
    else if (e.type === "stats") t.statsKind = e.outcome.kind;
    else if (e.type === "sources") {
      t.sources = e.sources;
      t.relaxed = e.relaxed;
    } else if (e.type === "delta") t.answer += e.text;
  }
  return t;
}

// With LANGSMITH_TRACING=true each case becomes a named trace; otherwise a plain call.
let traced = collect;

async function runCase(c: Case): Promise<RunResult> {
  const started = Date.now();
  // One retry for transient network errors; anything else is a real failure.
  const t = await traced(c.question).catch((err: Error) => {
    if (!/fetch failed|ECONNRESET|ETIMEDOUT/.test(String(err.message) + String(err.cause ?? ""))) throw err;
    return traced(c.question);
  });
  const checks: Check[] = [];
  const add = (name: string, pass: boolean | null, detail?: string) =>
    checks.push({ name, pass, detail });

  const outcome = outcomeOf(t);
  const path = pathOf(t);
  // Checks on model output never grade the code-written fallback note or count text.
  const { modelText } = splitNote(t.answer);
  const modelAnswered = path === "retrieval" || path === "fallback";
  add("outcome", outcome === c.expectedOutcome, `got ${outcome}, want ${c.expectedOutcome}`);
  if (c.expectedPath) add("path", path === c.expectedPath, `got ${path}, want ${c.expectedPath}`);
  const missing = missingText(t.answer, c.mustContain);
  if (c.mustContain) add("exact text", missing.length === 0, `missing: ${missing.join(" | ")}`);
  if (c.expectedMode) add("mode", t.mode === c.expectedMode, `got ${t.mode}`);

  const bad = filterMismatches(t.filters, c.expectedFilters);
  if (c.expectedFilters) add("filters", bad.length === 0, `wrong: ${bad.join(",")}; got ${JSON.stringify(t.filters)}`);
  if (c.expectRelaxed) add("relaxed retry", t.relaxed, `relaxed=${t.relaxed}`);
  if (c.expectDroppedProperty) {
    add("dropped unknown property", t.droppedPropertyNames.length > 0, t.droppedPropertyNames.join(","));
  }

  const retrievedIds = t.sources.map((s) => s.reviewId);
  const relevant = c.relevantReviewIds ?? [];
  const k = kFor(t.mode);
  const recall = recallAtK(retrievedIds, relevant, k);
  const rr = reciprocalRank(retrievedIds, relevant);
  const sourcesOk = relevant.length ? sourcesCorrect(retrievedIds, relevant, k) : null;
  if (sourcesOk !== null) add("sources", sourcesOk, `recall=${recall.toFixed(2)} k=${k}`);

  let sampleCount: JudgeResult | null = null;
  if (outcome === "answered" && modelAnswered) {
    const cit = checkCitations(modelText, t.sources.length, relevant.length > 0 && !c.mustAcknowledge);
    add("citations", cit.invalid.length === 0 && !cit.missing, cit.missing ? "cites nothing" : `invalid: ${cit.invalid}`);
    const q = unmatchedQuotes(modelText, t.sources.map((s) => s.text), c.question);
    add("quotes verbatim", q.length === 0, q.join(" | "));
    if (flag("judge") && t.sources.length) sampleCount = await judgeNoSampleCounts(modelText);
  }
  if (outcome === "answered") {
    if (c.mustAcknowledge) {
      const j = await judgeAcknowledges(t.answer, c.mustAcknowledge);
      add("acknowledges limit", j.pass, j.reason);
    }
    if (flag("judge") && modelAnswered && t.sources.length) {
      // Same facts the answer model saw: property, rating and date are legitimate to cite.
      const reviews = t.sources
        .map((s) => `[${s.n}] ${s.propertyName} · ${s.rating}★ · ${s.createdAt.slice(0, 10)}\n${s.text}`)
        .join("\n\n");
      const j = await judgeGrounded(modelText, reviews);
      add("grounded", j.pass, j.reason);
    }
  }
  const leaked = leakedNames(t.answer, reviewerNames);
  add("no reviewer names", leaked.length === 0, leaked.join(","));
  const hits = forbiddenHits(t.answer, c.mustNotContain);
  if (c.mustNotContain) add("no forbidden text", hits.length === 0, hits.join(","));

  return {
    caseId: c.id,
    outcome,
    path,
    mode: t.mode,
    retrievedIds,
    recall,
    rr,
    sourcesOk,
    checks,
    pass: checks.every((x) => x.pass === true),
    sampleCount,
    answer: t.answer,
    seconds: (Date.now() - started) / 1000,
  };
}

const pct = (x: number) => (Number.isNaN(x) ? "n/a" : x.toFixed(2));

async function main() {
  if (process.env.LANGSMITH_TRACING === "true") {
    const { traceable } = await import("langsmith/traceable");
    traced = traceable(collect, {
      name: "eval-case",
      tags: ["eval"],
      metadata: { dataset: "evals/dataset.json", chatModel: env.OPENAI_CHAT_MODEL },
    });
  }
  const results: Record<string, RunResult[]> = {};
  for (const c of cases) {
    results[c.id] = [];
    for (let i = 0; i < RUNS; i++) {
      try {
        results[c.id].push(await runCase(c));
      } catch (err) {
        // A pipeline crash is a failed run, not an aborted eval.
        results[c.id].push({
          caseId: c.id, outcome: "answered", path: null, mode: null, retrievedIds: [], recall: NaN, rr: NaN,
          sourcesOk: null, checks: [{ name: "pipeline", pass: false, detail: (err as Error).message }],
          pass: false, sampleCount: null, answer: "", seconds: 0,
        });
      }
    }
    const r = results[c.id];
    const passes = r.filter((x) => x.pass).length;
    const paths = [...new Set(r.map((x) => x.path))].join("/");
    console.log(
      `${passes === r.length ? "PASS" : "FAIL"} ${c.id} ${passes}/${r.length}  [${c.group}, ${paths}]  ${c.question.slice(0, 60)}`,
    );
    for (const x of r) {
      for (const ck of x.checks.filter((y) => y.pass !== true)) {
        console.log(`      - ${ck.name}${ck.pass === null ? " (unknown)" : ""}: ${ck.detail ?? ""}`);
      }
    }
  }

  const all = Object.values(results).flat();
  const labelled = all.filter((x) => x.sourcesOk !== null);
  const specific = labelled.filter((x) => x.mode !== "aggregate");
  const aggregate = labelled.filter((x) => x.mode === "aggregate");
  const targets = checkTargets(
    specific.map((x) => x.recall),
    labelled.map((x) => x.sourcesOk === true),
  );

  const failedCases = Object.entries(results).filter(([, r]) => r.some((x) => !x.pass)).map(([id]) => id);
  const checkNames = [...new Set(all.flatMap((x) => x.checks.map((c) => c.name)))];

  console.log("\nCheck pass rates");
  for (const n of checkNames) {
    const cs = all.flatMap((x) => x.checks.filter((c) => c.name === n));
    console.log(`  ${n.padEnd(26)} ${cs.filter((c) => c.pass === true).length}/${cs.length}`);
  }
  console.log("\nRetrieval");
  console.log(`  recall@5, specific:        ${pct(mean(specific.map((x) => x.recall)))}  (n=${specific.length})`);
  console.log(`  MRR, specific:             ${pct(mean(specific.map((x) => x.rr)))}`);
  console.log(`  recall, aggregate (all):   ${pct(mean(aggregate.map((x) => x.recall)))}  (n=${aggregate.length})`);
  console.log("\nTargets (docs/project-scope.md §9)");
  for (const t of targets) {
    console.log(`  ${t.pass ? "PASS" : "FAIL"} ${t.name}: ${pct(t.value)} (target ≥ ${t.target})`);
  }
  const questionsPassed = Object.values(results).filter((r) => r.every((x) => x.pass)).length;
  console.log(`\nQuestions passing all checks: ${questionsPassed}/${cases.length}`);

  // --- The three groups -----------------------------------------------------
  const inGroup = (g: Group) => cases.filter((c) => c.group === g).map((c) => c.id);
  const runsOf = (ids: string[]) => ids.flatMap((id) => results[id]);
  const checkRate = (ids: string[], name: string) => {
    const cs = runsOf(ids).flatMap((x) => x.checks.filter((c) => c.name === name));
    return { passed: cs.filter((c) => c.pass === true).length, total: cs.length };
  };
  const casesPassing = (ids: string[]) => ids.filter((id) => results[id].every((x) => x.pass)).length;

  const baseline = JSON.parse(readFileSync(REGRESSION_BASELINE, "utf8")) as {
    results: Record<string, Array<{ pass: boolean }>>;
  };
  const regressionIds = inGroup("regression");
  const regression = compareToBaseline(results, baseline.results, regressionIds, REPORT_SEPARATELY);
  console.log(`\n1. Regression (${regressionIds.length} cases, compared with ${REGRESSION_BASELINE})`);
  console.log(`  passing: ${regression.passed.length}/${regression.scored.length}`);
  console.log(`  regressions: ${regression.regressions.join(", ") || "none"}`);
  if (regression.improvements.length) console.log(`  improvements: ${regression.improvements.join(", ")}`);
  for (const s of regression.separate) {
    console.log(`  ${s.id} (reported separately): ${s.now ? "PASS" : "FAIL"} now, ${s.before ? "PASS" : "FAIL"} before`);
  }
  if (regression.notInBaseline.length) console.log(`  not in the saved run: ${regression.notInBaseline.join(", ")}`);
  const rerouted = regressionIds.filter((id) => results[id].some((x) => x.path !== "retrieval" && x.path !== "declined"));
  if (rerouted.length) console.log(`  took a statistics path in some run: ${rerouted.join(", ")}`);

  const statsIds = inGroup("statistics");
  const statsPath = checkRate(statsIds, "path");
  const exact = checkRate(statsIds, "exact text");
  console.log(`\n2. Statistics (${statsIds.length} cases): ${casesPassing(statsIds)}/${statsIds.length} passing`);
  console.log(`  path: ${statsPath.passed}/${statsPath.total} runs   exact numbers: ${exact.passed}/${exact.total} runs`);

  const boundaryIds = inGroup("boundary");
  const boundaryPath = checkRate(boundaryIds, "path");
  console.log(`\n3. Boundary and fallback (${boundaryIds.length} cases): ${casesPassing(boundaryIds)}/${boundaryIds.length} passing`);
  console.log(`  path: ${boundaryPath.passed}/${boundaryPath.total} runs (target: all)`);

  const judged = all.filter((x) => x.sampleCount !== null);
  const sampleFails = judged.filter((x) => x.sampleCount?.pass === false);
  const sampleUnknown = judged.filter((x) => x.sampleCount?.pass === null);
  if (flag("judge")) {
    console.log(`\nSample figures stated as counts (sample-based answers): ${sampleFails.length}/${judged.length} runs (target 0)`);
    for (const x of sampleFails) console.log(`  ${x.caseId}: ${x.sampleCount?.reason}`);
    if (sampleUnknown.length) console.log(`  judge unavailable on ${sampleUnknown.length} runs`);
  }
  console.log("Reminder: 8 fictional reviews. Treat recall as a harness proof, not a quality claim.");

  const report = {
    ranAt: new Date().toISOString(),
    runs: RUNS,
    today: dataset.today,
    datasetSha256: createHash("sha256").update(datasetRaw).digest("hex").slice(0, 12),
    models: {
      chat: env.OPENAI_CHAT_MODEL,
      planner: env.OPENAI_PLANNER_MODEL || env.OPENAI_CHAT_MODEL,
      embedding: env.OPENAI_EMBEDDING_MODEL,
      judge: process.env.OPENAI_JUDGE_MODEL || env.OPENAI_CHAT_MODEL,
    },
    summary: {
      recallAt5Specific: mean(specific.map((x) => x.recall)),
      mrrSpecific: mean(specific.map((x) => x.rr)),
      targets,
      questionsPassed,
      questions: cases.length,
      failedCases,
      groups: {
        regression: { baseline: REGRESSION_BASELINE, ...regression },
        statistics: { cases: statsIds.length, passing: casesPassing(statsIds), path: statsPath, exactText: exact },
        boundary: { cases: boundaryIds.length, passing: casesPassing(boundaryIds), path: boundaryPath },
        sampleCounts: flag("judge") ? { failed: sampleFails.length, judged: judged.length } : null,
      },
    },
    results,
  };
  mkdirSync("evals/results", { recursive: true });
  writeFileSync("evals/results/latest.json", JSON.stringify(report, null, 2));
  if (baselineFile) {
    // Checked again: another run may have saved it meanwhile.
    if (existsSync(baselineFile)) throw new Error(`${baselineFile} exists; saved baselines are never overwritten.`);
    writeFileSync(baselineFile, JSON.stringify(report, null, 2));
    console.log(`Saved ${baselineFile}`);
  }

  if (process.env.LANGSMITH_TRACING === "true") {
    const { Client } = await import("langsmith");
    await new Client().awaitPendingTraceBatches();
  }

  const failed = failedCases.length > 0 || targets.some((t) => !t.pass);
  process.exit(failed && !flag("no-fail") ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
