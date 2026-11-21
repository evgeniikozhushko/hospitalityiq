/**
 * Run the fixed SQL statistics from the terminal (read-only connection).
 *
 *   npm run stats -- mentions --theme parking [--sentiment negative]
 *   npm run stats -- top --sentiment negative [--limit 5]
 *   npm run stats -- trend --theme parking --since 2026-02-01 --until 2026-02-28
 *   npm run stats -- sets                      (list tag sets; * marks the active one)
 *
 * Filters: --property "Name" (repeatable) --type hotel --since YYYY-MM-DD --until YYYY-MM-DD
 *          --months 1,2 --min-rating 4 --max-rating 5 --source google_business_profile
 * Tags:    --tag-set <id> (default: the active tag set), to compare a set that is not active
 */
import { parseArgs } from "node:util";
import { Client } from "pg";
import { requireUrl } from "../lib/db/config";
import { PropertyType, EMPTY_FILTERS } from "../lib/schema";
import { Sentiment } from "../lib/db/tags";
import { listTagSets, resolveTagSet } from "../lib/db/tagSets";
import {
  StatsInputError,
  themeMentions,
  themeRanking,
  themeTrend,
  type Coverage,
  type StatsScope,
  type ThemeMentions,
} from "../lib/reviewStats";

const cov = (c: Coverage) =>
  `${c.totalReviews} reviews, ${c.textReviews} with text: ${c.currentTagged} tagged, ${c.stale} stale, ${c.untagged} untagged`;

function printMentions(m: ThemeMentions, heading?: string) {
  console.log(heading ?? `${m.theme}${m.sentiment ? ` (${m.sentiment})` : ""} in ${m.scopeLabel}`);
  for (const r of m.rows) console.log(`  ${r.propertyName.padEnd(28)} ${String(r.count).padStart(4)}   [${cov(r.coverage)}]`);
  console.log(`  ${"TOTAL".padEnd(28)} ${String(m.total.count).padStart(4)}   [${cov(m.total.coverage)}]`);
}

async function main() {
  const { positionals, values: v } = parseArgs({
    allowPositionals: true,
    options: {
      theme: { type: "string" },
      sentiment: { type: "string" },
      limit: { type: "string" },
      property: { type: "string", multiple: true },
      type: { type: "string", multiple: true },
      since: { type: "string" },
      until: { type: "string" },
      months: { type: "string" },
      "min-rating": { type: "string" },
      "max-rating": { type: "string" },
      source: { type: "string" },
      "tag-set": { type: "string" },
    },
  });
  const command = positionals[0];
  const sentiment = v.sentiment ? Sentiment.parse(v.sentiment) : null;
  const tagSetArg = v["tag-set"];
  if (tagSetArg !== undefined && !/^\d+$/.test(tagSetArg)) throw new StatsInputError("--tag-set must be a tag set id.");
  const filterScope: Omit<StatsScope, "tagSetId"> = {
    source: v.source,
    filters: {
      ...EMPTY_FILTERS,
      propertyNames: v.property ?? null,
      propertyTypes: v.type ? v.type.map((t) => PropertyType.parse(t)) : null,
      since: v.since ?? null,
      until: v.until ?? null,
      months: v.months ? v.months.split(",").map(Number) : null,
      minRating: v["min-rating"] ? Number(v["min-rating"]) : null,
      maxRating: v["max-rating"] ? Number(v["max-rating"]) : null,
    },
  };

  const client = new Client({ connectionString: requireUrl("readonly") });
  await client.connect();
  try {
    if (command === "sets") {
      for (const t of await listTagSets(client)) {
        const model = t.tagSource === "llm" ? ` ${t.modelSnapshot} prompt ${t.promptVersion}` : "";
        const gate = t.tagSource === "llm" ? (t.gatePassedAt ? " gate passed" : " not gated") : "";
        console.log(`${t.active ? "*" : " "} ${String(t.id).padStart(3)}  ${t.tagSource} ${t.taxonomyVersion}${model}${gate}`);
      }
      return;
    }
    const tagSet = await resolveTagSet(client, tagSetArg === undefined ? null : Number(tagSetArg));
    const scope: StatsScope = { ...filterScope, tagSetId: tagSet.id };
    if (command === "mentions") {
      if (!v.theme) throw new StatsInputError("--theme is required.");
      printMentions(await themeMentions(client, scope, { theme: v.theme, sentiment }));
    } else if (command === "top") {
      const r = await themeRanking(client, scope, { sentiment, limit: v.limit ? Number(v.limit) : 5 });
      console.log(`Top themes${r.sentiment ? ` (${r.sentiment})` : ""} in ${r.scopeLabel}:`);
      r.themes.forEach((t, i) => console.log(`  ${i + 1}. ${t.theme.padEnd(14)} ${t.count}`));
      console.log(`  [${cov(r.coverage)}]`);
    } else if (command === "trend") {
      if (!v.theme) throw new StatsInputError("--theme is required.");
      const t = await themeTrend(client, scope, { theme: v.theme, sentiment });
      printMentions(t.current, `CURRENT ${t.current.window.since}..${t.current.window.until}: ${t.theme} in ${t.current.scopeLabel}`);
      printMentions(t.previous, `PREVIOUS ${t.previous.window.since}..${t.previous.window.until}`);
      const pct = t.change.percent === null ? "n/a (previous period had none)" : `${t.change.percent.toFixed(1)}%`;
      console.log(`Change in mentions: ${t.change.absolute >= 0 ? "+" : ""}${t.change.absolute} (${pct})`);
      const share = (s: number | null) => (s === null ? "n/a (no tagged reviews)" : `${(s * 100).toFixed(1)}%`);
      const points = t.change.sharePoints === null ? "n/a" : `${t.change.sharePoints >= 0 ? "+" : ""}${t.change.sharePoints.toFixed(1)} points`;
      console.log(`Share of tagged reviews: ${share(t.change.currentShare)} now, ${share(t.change.previousShare)} before (${points})`);
    } else {
      console.log("Commands: mentions | top | trend. See the header of scripts/stats.ts.");
      process.exitCode = 1;
    }
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
