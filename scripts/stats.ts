/**
 * Run the fixed SQL statistics from the terminal (read-only connection).
 *
 *   npm run stats -- mentions --theme parking [--sentiment negative]
 *   npm run stats -- top --sentiment negative [--limit 5]
 *   npm run stats -- trend --theme parking --since 2026-02-01 --until 2026-02-28
 *
 * Filters: --property "Name" (repeatable) --type hotel --since YYYY-MM-DD --until YYYY-MM-DD
 *          --months 1,2 --min-rating 4 --max-rating 5 --source google_business_profile
 * Tags:    --tag-source manual|llm (default manual)  --taxonomy v1 (default v1)
 */
import { parseArgs } from "node:util";
import { Client } from "pg";
import { requireUrl } from "../lib/db/config";
import { PropertyType, EMPTY_FILTERS } from "../lib/schema";
import { Sentiment, TagSource } from "../lib/db/tags";
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
      "tag-source": { type: "string", default: "manual" },
      taxonomy: { type: "string", default: "v1" },
    },
  });
  const command = positionals[0];
  const sentiment = v.sentiment ? Sentiment.parse(v.sentiment) : null;
  const scope: StatsScope = {
    tagSource: TagSource.parse(v["tag-source"]),
    taxonomyVersion: v.taxonomy!,
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
      console.log(`Change: ${t.change.absolute >= 0 ? "+" : ""}${t.change.absolute} (${pct})`);
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
