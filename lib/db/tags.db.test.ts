import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importLocations } from "./import";
import { loadManualTags } from "./manualTags";
import { replaceTagSet, TagSetError } from "./tags";
import { resetTestDatabase, testDatabaseUrl } from "./testDb";

const url = testDatabaseUrl();
const SRC = "google_business_profile";

const rv = (id: string, over: Record<string, unknown> = {}) => ({
  reviewId: id,
  starRating: "FIVE" as const,
  comment: `Nice ${id}`,
  createTime: "2026-01-14T18:22:00Z",
  ...over,
});
const loc = (reviews: ReturnType<typeof rv>[]) => ({
  locationId: "loc-a",
  propertyName: "Test Lodge",
  propertyType: "hotel" as const,
  reviews,
});

describe.skipIf(!url)("tag sets and manual tags (database)", () => {
  const c = new Client({ connectionString: url! });
  const q = async (sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows;
  const base = { source: SRC, tagSource: "manual" as const, taxonomyVersion: "v1" };

  beforeAll(async () => {
    await resetTestDatabase(url!);
    await c.connect();
  });
  afterAll(async () => {
    await c.end();
  });
  beforeEach(async () => {
    await c.query("TRUNCATE imports, reviews, properties RESTART IDENTITY CASCADE");
    await importLocations(c, [loc([rv("r1"), rv("r2"), rv("rating-only", { comment: undefined })])]);
  });

  it("a zero-theme set is a completed set, distinct from never reviewed", async () => {
    await replaceTagSet(c, { ...base, sourceReviewId: "r1", tags: [] });
    expect(await q("SELECT stale FROM review_tagging")).toEqual([{ stale: false }]);
    expect(await q("SELECT 1 FROM review_themes")).toHaveLength(0);
  });

  it("replaces the whole set, not merges", async () => {
    await replaceTagSet(c, { ...base, sourceReviewId: "r1", tags: [{ theme: "rooms", sentiment: "positive" }, { theme: "food", sentiment: "negative" }] });
    await replaceTagSet(c, { ...base, sourceReviewId: "r1", tags: [{ theme: "spa", sentiment: "neutral" }] });
    const rows = await q("SELECT t.slug, th.sentiment FROM review_themes th JOIN themes t ON t.id = th.theme_id");
    expect(rows).toEqual([{ slug: "spa", sentiment: "neutral" }]);
  });

  it("revalidating a stale manual set replaces it and clears stale", async () => {
    await replaceTagSet(c, { ...base, sourceReviewId: "r1", tags: [{ theme: "rooms", sentiment: "positive" }] });
    await importLocations(c, [loc([rv("r1", { comment: "Completely new words" }), rv("r2")])]);
    expect(await q("SELECT stale FROM review_tagging")).toEqual([{ stale: true }]);
    await replaceTagSet(c, { ...base, sourceReviewId: "r1", tags: [] });
    expect(await q("SELECT stale FROM review_tagging")).toEqual([{ stale: false }]);
  });

  it("rejects neutral beside a polar tag, unknown themes, missing and text-free reviews, and writes nothing", async () => {
    await expect(
      replaceTagSet(c, { ...base, sourceReviewId: "r1", tags: [{ theme: "food", sentiment: "neutral" }, { theme: "food", sentiment: "positive" }] }),
    ).rejects.toThrow(TagSetError);
    await expect(replaceTagSet(c, { ...base, sourceReviewId: "r1", tags: [{ theme: "nope", sentiment: "positive" }] })).rejects.toThrow(/Unknown theme/);
    await expect(replaceTagSet(c, { ...base, sourceReviewId: "ghost", tags: [] })).rejects.toThrow(/does not exist/);
    await expect(replaceTagSet(c, { ...base, sourceReviewId: "rating-only", tags: [] })).rejects.toThrow(/no text/);
    expect(await q("SELECT 1 FROM review_tagging")).toHaveLength(0);
  });

  it("concurrent writers of one review leave exactly one complete set, never a mix", async () => {
    const other = new Client({ connectionString: url! });
    await other.connect();
    const a = replaceTagSet(c, { ...base, sourceReviewId: "r1", tags: [{ theme: "parking", sentiment: "neutral" }] });
    const b = replaceTagSet(other, { ...base, sourceReviewId: "r1", tags: [{ theme: "parking", sentiment: "positive" }, { theme: "parking", sentiment: "negative" }] });
    await Promise.all([a, b]);
    await other.end();
    const rows = await q("SELECT sentiment FROM review_themes ORDER BY sentiment");
    const set = rows.map((r) => r.sentiment).join(",");
    expect(["neutral", "negative,positive"]).toContain(set);
    expect(await q("SELECT 1 FROM review_tagging")).toHaveLength(1);
  });

  it("manual tag files load with zero-theme entries, and a typo loads nothing", async () => {
    const res = await loadManualTags(c, {
      source: SRC,
      taxonomyVersion: "v1",
      reviews: [
        { sourceReviewId: "r1", themes: [{ theme: "rooms", sentiment: "positive" }] },
        { sourceReviewId: "r2", themes: [] },
      ],
    });
    expect(res.loaded).toBe(2);
    expect(await q("SELECT 1 FROM review_tagging")).toHaveLength(2);

    await c.query("DELETE FROM review_tagging");
    await expect(
      loadManualTags(c, { source: SRC, taxonomyVersion: "v1", reviews: [{ sourceReviewId: "r1", themes: [] }, { sourceReviewId: "r-typo", themes: [] }] }),
    ).rejects.toThrow(/r-typo/);
    expect(await q("SELECT 1 FROM review_tagging")).toHaveLength(0);
    await expect(
      loadManualTags(c, { source: SRC, taxonomyVersion: "v1", reviews: [{ sourceReviewId: "r1", themes: [] }, { sourceReviewId: "r1", themes: [] }] }),
    ).rejects.toThrow(/Duplicate/);
  });
});
