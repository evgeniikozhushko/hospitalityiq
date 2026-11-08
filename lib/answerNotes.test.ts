import { describe, it, expect } from "vitest";
import { buildNotes } from "./answerNotes";

describe("buildNotes", () => {
  it("returns an empty string when there is nothing to say", () => {
    expect(buildNotes({ relaxed: false, dropped: [], portfolioAlias: null })).toBe("");
  });

  it("says the warning about an unknown property first", () => {
    const out = buildNotes({ relaxed: false, dropped: ["Grand Lakeside Resort"], portfolioAlias: null });
    expect(out).toContain("no reviews for Grand Lakeside Resort");
    expect(out).toContain("first sentence");
  });

  it("announces portfolio-wide scope in the first sentence when alone", () => {
    const out = buildNotes({ relaxed: false, dropped: [], portfolioAlias: "BCP" });
    expect(out).toContain("Searching all properties");
    expect(out).toContain("first sentence");
    expect(out).not.toContain("second sentence");
  });

  it("orders the notes: unknown-property warning first, portfolio scope second", () => {
    const out = buildNotes({
      relaxed: false,
      dropped: ["Grand Lakeside Resort"],
      portfolioAlias: "BCP",
    });
    const warning = out.indexOf("no reviews for Grand Lakeside Resort");
    const scope = out.indexOf("Searching all properties");
    expect(warning).toBeGreaterThan(-1);
    expect(scope).toBeGreaterThan(warning);
    expect(out).toContain("second sentence");
    // Exactly one note may claim the first sentence.
    expect(out.match(/first sentence/g)).toHaveLength(1);
  });

  it("keeps the relaxed-filter note ahead of the property notes", () => {
    const out = buildNotes({ relaxed: true, dropped: [], portfolioAlias: "BCP" });
    expect(out.indexOf("no reviews for that period or rating")).toBeLessThan(
      out.indexOf("Searching all properties"),
    );
  });
});
