/**
 * The fixed data scope for counts (docs/routing-plan.md, decision 5): only real Google
 * reviews, so the synthetic practice set never reaches a user's answer. Which tag set
 * the counts read from is not a setting: it is the active tag set in the database
 * (lib/db/tagSets.ts, ADR 0003). Kept apart from lib/env.ts so it needs no OpenAI key.
 */
import type { StatsSettings } from "./answerPipeline";

/** The taxonomy is provisional until marketing has reviewed the theme list. */
const PROVISIONAL_TAXONOMIES = new Set(["v1"]);

export function statsSettings(): StatsSettings {
  return {
    source: "google_business_profile",
    isProvisional: (taxonomyVersion) => PROVISIONAL_TAXONOMIES.has(taxonomyVersion),
  };
}
