/**
 * What each theme means to the planner, with explicit synonyms (docs/routing-plan.md,
 * decision 1). Only these words map to a theme; anything narrower or different is not
 * a theme, so the gate falls back instead of counting a broader theme as if it were
 * the topic asked about. `other` is deliberately absent: it is never asked about.
 *
 * Must list exactly the themes seeded in db/migrations (a test checks this).
 */
export const THEME_GUIDE: ReadonlyArray<{ slug: string; meaning: string; synonyms: string[] }> = [
  {
    slug: "housekeeping",
    meaning: "how clean the property and rooms are, and the housekeeping service",
    synonyms: ["cleanliness", "clean", "dirty", "tidy", "housekeeping", "room cleaning"],
  },
  {
    slug: "rooms",
    meaning: "the room itself",
    synonyms: ["rooms", "the room", "room comfort", "beds", "room size"],
  },
  {
    slug: "front-desk",
    meaning: "arrival, departure and the front desk team",
    synonyms: ["check-in", "check-out", "front desk", "reception", "front desk staff"],
  },
  {
    slug: "food",
    meaning: "food and drink in general",
    synonyms: ["food", "meals", "dining", "cuisine", "food and drink"],
  },
  {
    slug: "spa",
    meaning: "the spa in general",
    synonyms: ["spa", "spa services", "spa experience"],
  },
  {
    slug: "parking",
    meaning: "parking",
    synonyms: ["parking", "car park", "parking lot", "valet parking"],
  },
  {
    slug: "value",
    meaning: "whether the stay or meal was worth the money",
    synonyms: ["value", "value for money", "worth it", "overpriced", "good price for what you get"],
  },
];

export function themeGuideText(): string {
  return THEME_GUIDE.map((t) => `- ${t.slug}: ${t.meaning} (${t.synonyms.join(", ")})`).join("\n");
}
