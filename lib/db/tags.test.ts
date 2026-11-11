import { describe, expect, it } from "vitest";
import { normalizeTagSet, TagSetError } from "./tags";

describe("normalizeTagSet", () => {
  it("allows positive and negative for the same theme (praise and complaint in one review)", () => {
    const tags = [
      { theme: "parking", sentiment: "positive" as const },
      { theme: "parking", sentiment: "negative" as const },
    ];
    expect(normalizeTagSet(tags)).toHaveLength(2);
  });

  it("rejects neutral beside positive or negative for the same theme", () => {
    expect(() =>
      normalizeTagSet([
        { theme: "food", sentiment: "neutral" },
        { theme: "food", sentiment: "positive" },
      ]),
    ).toThrow(TagSetError);
  });

  it("allows neutral for one theme and polar tags for another", () => {
    expect(
      normalizeTagSet([
        { theme: "food", sentiment: "neutral" },
        { theme: "rooms", sentiment: "negative" },
      ]),
    ).toHaveLength(2);
  });

  it("drops exact duplicates and accepts an empty set", () => {
    const t = { theme: "spa", sentiment: "positive" as const };
    expect(normalizeTagSet([t, t])).toEqual([t]);
    expect(normalizeTagSet([])).toEqual([]);
  });
});
