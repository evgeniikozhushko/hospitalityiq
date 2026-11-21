/**
 * Replay the answers of a saved eval run through the deterministic wording checks
 * (lib/sampleClaims.ts). Calls no model and costs nothing.
 *
 * Usage: npx tsx scripts/replay-checks.ts [evals/baselines/post-audit-fixes.json]
 *
 * The saved run is only read. The report goes to evals/results/replay-<name>.json.
 * Saved runs made before the fallback code was recorded have no code, so the ranking
 * check is applied where the answer starts with the gate's "rank properties" note.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { splitNote } from "../lib/evalMetrics";
import { PROPERTY_NEEDS_THEME_REASON } from "../lib/route";
import { rankingClaims, sampleCountClaims, splitCaveat } from "../lib/sampleClaims";

type SavedRun = {
  path: string | null;
  answer: string;
  fallbackCode?: string | null;
  sampleCount?: { pass: boolean | null; reason: string } | null;
  checks: Array<{ name: string; pass: boolean | null }>;
};

const file = process.argv[2] ?? "evals/baselines/post-audit-fixes.json";
const saved = JSON.parse(readFileSync(file, "utf8")) as { results: Record<string, SavedRun[]> };

const rows: Array<{
  caseId: string;
  run: number;
  judge: "flagged" | "passed" | "not judged";
  claims: ReturnType<typeof sampleCountClaims>;
  ranking: string[] | null;
  grounded: boolean | null;
}> = [];

for (const [caseId, runs] of Object.entries(saved.results)) {
  runs.forEach((r, run) => {
    if (r.path !== "retrieval" && r.path !== "fallback") return;
    const { note, modelText } = splitNote(r.answer);
    const text = splitCaveat(modelText).text;
    const ranksProperties = r.fallbackCode
      ? r.fallbackCode === "property_needs_theme"
      : (note ?? "").startsWith(PROPERTY_NEEDS_THEME_REASON);
    rows.push({
      caseId,
      run,
      judge: !r.sampleCount || r.sampleCount.pass === null ? "not judged" : r.sampleCount.pass ? "passed" : "flagged",
      claims: sampleCountClaims(text),
      ranking: ranksProperties ? rankingClaims(text) : null,
      grounded: r.checks.find((c) => c.name === "grounded")?.pass ?? null,
    });
  });
}

const count = (judge: string, flagged: boolean) =>
  rows.filter((r) => r.judge === judge && r.claims.length > 0 === flagged).length;

console.log(`${file}: ${rows.length} model-written answers\n`);
console.log("Sample figures stated as counts      check flags   check passes");
console.log(`  judge flagged (${String(count("flagged", true) + count("flagged", false)).padStart(2)})                 ${String(count("flagged", true)).padStart(2)}            ${String(count("flagged", false)).padStart(2)}`);
console.log(`  judge passed  (${String(count("passed", true) + count("passed", false)).padStart(2)})                 ${String(count("passed", true)).padStart(2)}            ${String(count("passed", false)).padStart(2)}`);

console.log("\nFlagged by the check:");
for (const r of rows.filter((x) => x.claims.length)) {
  console.log(`  ${r.caseId} run ${r.run} (judge ${r.judge})`);
  for (const c of r.claims) console.log(`      ${c.kind}: ${c.sentence}`);
}
console.log("\nFlagged by the judge only:");
for (const r of rows.filter((x) => x.judge === "flagged" && !x.claims.length)) console.log(`  ${r.caseId} run ${r.run}`);

console.log("\nProperty ranking from search results (rank-properties fallback only):");
for (const r of rows.filter((x) => x.ranking)) {
  console.log(`  ${r.caseId} run ${r.run}: ${r.ranking!.length ? "FLAGGED" : "clean"} (grounded judge: ${r.grounded})`);
  for (const s of r.ranking!) console.log(`      ${s}`);
}

mkdirSync("evals/results", { recursive: true });
const out = `evals/results/replay-${basename(file, ".json")}.json`;
writeFileSync(out, JSON.stringify({ source: file, rows }, null, 2));
console.log(`\nSaved ${out}`);
