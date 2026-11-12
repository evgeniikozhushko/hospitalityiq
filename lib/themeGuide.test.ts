import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OTHER_THEME } from "./route";
import { THEME_GUIDE, themeGuideText } from "./themeGuide";

const seeded = [...readFileSync("db/migrations/0002_seed_themes.sql", "utf8").matchAll(/\('([a-z-]+)',/g)].map((m) => m[1]);

describe("theme guide", () => {
  it("lists exactly the seeded themes except Other", () => {
    expect(seeded.length).toBeGreaterThan(0);
    expect(THEME_GUIDE.map((t) => t.slug).sort()).toEqual(seeded.filter((s) => s !== OTHER_THEME).sort());
  });

  it("never offers Other to the planner", () => {
    expect(themeGuideText()).not.toMatch(/^- other/m);
  });

  it("does not map narrower topics to a theme", () => {
    const words = THEME_GUIDE.flatMap((t) => t.synonyms);
    for (const narrower of ["breakfast", "massage", "thermal pool", "noise", "wifi"]) {
      expect(words).not.toContain(narrower);
    }
  });

  it("gives each synonym to one theme only", () => {
    const words = THEME_GUIDE.flatMap((t) => t.synonyms);
    expect(new Set(words).size).toBe(words.length);
  });
});
