/**
 * The fixed data scope for counts (docs/routing-plan.md, decision 5). One tag source
 * and one taxonomy version, never combined, and only real Google reviews, so the
 * synthetic practice set never reaches a user's answer. Kept apart from lib/env.ts so
 * it needs no OpenAI key.
 */
import type { StatsSettings } from "./answerPipeline";
import { TagSource } from "./db/tags";

/** The taxonomy is provisional until marketing has reviewed the theme list. */
const PROVISIONAL_TAXONOMIES = new Set(["v1"]);

export function statsSettings(e: Record<string, string | undefined> = process.env): StatsSettings {
  const taxonomyVersion = e.STATS_TAXONOMY_VERSION?.trim() || "v1";
  return {
    tagSource: TagSource.parse(e.STATS_TAG_SOURCE?.trim() || "manual"),
    taxonomyVersion,
    source: "google_business_profile",
    provisional: PROVISIONAL_TAXONOMIES.has(taxonomyVersion),
  };
}
