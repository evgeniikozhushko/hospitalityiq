/**
 * SQL statistics against the synthetic seed (data/synthetic). Expected numbers are
 * worked out by hand from that data, not produced by running the queries.
 *
 * Synthetic Lodge (hotel, America/Edmonton), reviews and manual v1 tags:
 *   L01 Jan 5   5* rooms+ parking-         L06 Feb 20 3* (reviewed, no themes)
 *   L02 Jan 20  2* parking- front-desk-    L07 Feb 22 5* (NOT tagged)
 *   L03 Jan 28  4* parking+ AND parking-   L08 Feb 25 5* rating-only
 *   L04 Feb 10  4* housekeeping+ value+    L10 2026-03-01T06:59Z = Feb 28 23:59 LOCAL, parking+
 *   L05 Feb 15  1* rooms- housekeeping- parking-
 *   L11 2026-03-01T07:00Z = Mar 1 00:00 LOCAL parking+   L12 2026-03-09T06:30Z = Mar 9 00:30 MDT parking-
 * Synthetic Bistro: B01 Jan 12 food+ value+ | B02 Feb 3 food- value- | B03 Feb 17 food+ parking(neutral)
 * Synthetic Spa:    S01 Jan 30 spa+ | S02 Feb 14 spa+ parking+ | S03 Feb 18 spa-
 */
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importLocations } from "./db/import";
import { loadManualTags, ManualTagsFileSchema } from "./db/manualTags";
import { replaceTagSet } from "./db/tags";
import { readonlyTestUrl, resetTestDatabase, testDatabaseUrl } from "./db/testDb";
import {
  ComparisonError,
  StatsInputError,
  themeMentions,
  themeRanking,
  themeTrend,
  UnknownPropertyError,
  UnknownThemeError,
  type StatsScope,
} from "./reviewStats";
import { EMPTY_FILTERS, LocationReviewsSchema, type QueryFilters } from "./schema";
import { z } from "zod";

const url = testDatabaseUrl();
const SRC = "synthetic";

const scope = (filters: Partial<QueryFilters> = {}, over: Partial<StatsScope> = {}): StatsScope => ({
  tagSource: "manual",
  taxonomyVersion: "v1",
  source: SRC,
  filters: { ...EMPTY_FILTERS, ...filters },
  ...over,
});
const LODGE = "Synthetic Lodge";
const counts = (r: { rows: Array<{ propertyName: string; count: number }> }) =>
  Object.fromEntries(r.rows.map((x) => [x.propertyName.replace("Synthetic ", ""), x.count]));

describe.skipIf(!url)("review statistics (database)", () => {
  const admin = new Client({ connectionString: url! });
  const ro = new Client({ connectionString: url ? readonlyTestUrl(url) : undefined });
  let reviewsJson: z.infer<typeof LocationReviewsSchema>[];

  async function seed() {
    await admin.query("TRUNCATE imports, reviews, properties RESTART IDENTITY CASCADE");
    await importLocations(admin, reviewsJson, { source: SRC });
    const tags = ManualTagsFileSchema.parse(JSON.parse(await readFile("data/synthetic/tags.json", "utf8")));
    await loadManualTags(admin, tags);
  }

  beforeAll(async () => {
    await resetTestDatabase(url!);
    await admin.connect();
    await ro.connect();
    reviewsJson = z.array(LocationReviewsSchema).parse(JSON.parse(await readFile("data/synthetic/reviews.json", "utf8")));
  });
  afterAll(async () => {
    await admin.end();
    await ro.end();
  });
  beforeEach(seed);

  describe("mentions", () => {
    it("counts distinct reviews per property: a mixed-sentiment review counts once", async () => {
      const r = await themeMentions(ro, scope(), { theme: "parking" });
      expect(counts(r)).toEqual({ Bistro: 1, Lodge: 7, Spa: 1 }); // 8 tag rows, 7 reviews at the Lodge
      expect(r.total.count).toBe(9);
    });

    it("complaints and praise: the mixed review is in both", async () => {
      expect(counts(await themeMentions(ro, scope(), { theme: "parking", sentiment: "negative" }))).toEqual({ Bistro: 0, Lodge: 5, Spa: 0 });
      expect(counts(await themeMentions(ro, scope(), { theme: "parking", sentiment: "positive" }))).toEqual({ Bistro: 0, Lodge: 3, Spa: 1 });
      expect(counts(await themeMentions(ro, scope(), { theme: "parking", sentiment: "neutral" }))).toEqual({ Bistro: 1, Lodge: 0, Spa: 0 });
    });

    it("reports coverage: rating-only is not untagged, zero-theme review counts as tagged", async () => {
      const r = await themeMentions(ro, scope(), { theme: "parking" });
      const lodge = r.rows.find((x) => x.propertyName === LODGE)!;
      expect(lodge.coverage).toEqual({ totalReviews: 11, textReviews: 10, currentTagged: 9, stale: 0, untagged: 1 });
      expect(r.total.coverage).toEqual({ totalReviews: 17, textReviews: 16, currentTagged: 15, stale: 0, untagged: 1 });
    });
  });

  describe("windows use the property's local dates", () => {
    const lodge = { propertyNames: [LODGE] };

    it("Jan 1 - Feb 28 includes the review at 23:59 local on Feb 28 (already March in UTC)", async () => {
      const r = await themeMentions(ro, scope({ ...lodge, since: "2026-01-01", until: "2026-02-28" }), { theme: "parking" });
      expect(r.total.count).toBe(5); // L01 L02 L03 L05 L10; a UTC window would give 4
      expect(r.total.coverage).toEqual({ totalReviews: 9, textReviews: 8, currentTagged: 7, stale: 0, untagged: 1 });
    });

    it("a window starting Mar 1 includes 00:00 local, excludes 23:59 the night before", async () => {
      const r = await themeMentions(ro, scope({ ...lodge, since: "2026-03-01", until: "2026-03-01" }), { theme: "parking" });
      expect(r.total.count).toBe(1); // L11 only
      expect(r.total.coverage.totalReviews).toBe(1);
    });

    it("daylight-saving day: Mar 8 is 23 hours long, so the 00:30 Mar 9 review is not in it", async () => {
      const mar8 = await themeMentions(ro, scope({ ...lodge, since: "2026-03-08", until: "2026-03-08" }), { theme: "parking" });
      expect(mar8.total.coverage.totalReviews).toBe(0);
      const mar9 = await themeMentions(ro, scope({ ...lodge, since: "2026-03-09", until: "2026-03-09" }), { theme: "parking" });
      expect(mar9.total.count).toBe(1);
    });

    it("months filter uses the local month and combines with since/until by AND", async () => {
      const m = (months: number[], extra: Partial<QueryFilters> = {}) =>
        themeMentions(ro, scope({ ...lodge, months, ...extra }), { theme: "parking" }).then((r) => r.total.count);
      expect(await m([1])).toBe(3);
      expect(await m([2])).toBe(2); // L05 and L10 (local Feb 28)
      expect(await m([2, 3])).toBe(4);
      expect(await m([1], { since: "2026-02-01" })).toBe(0);
      expect(await m([1, 2], { since: "2026-02-01" })).toBe(2);
    });
  });

  describe("trend", () => {
    it("compares with the equal-length window immediately before", async () => {
      const t = await themeTrend(ro, scope({ propertyNames: [LODGE], since: "2026-02-01", until: "2026-02-28" }), { theme: "parking" });
      expect(t.previous.window).toEqual({ since: "2026-01-04", until: "2026-01-31" });
      expect([t.current.total.count, t.previous.total.count]).toEqual([2, 3]);
      expect(t.change.absolute).toBe(-1);
      expect(t.change.percent).toBeCloseTo(-33.33, 1);
    });

    it("all properties, with total review counts for both windows", async () => {
      const t = await themeTrend(ro, scope({ since: "2026-02-01", until: "2026-02-28" }), { theme: "parking" });
      expect([t.current.total.count, t.previous.total.count]).toEqual([4, 3]);
      expect([t.current.total.coverage.totalReviews, t.previous.total.coverage.totalReviews]).toEqual([10, 5]);
    });

    it("percent is null when the previous period has none", async () => {
      const t = await themeTrend(ro, scope({ propertyNames: ["Synthetic Spa"], since: "2026-02-01", until: "2026-02-28" }), { theme: "parking" });
      expect([t.current.total.count, t.previous.total.count]).toEqual([1, 0]);
      expect(t.change.percent).toBeNull();
    });

    it("rejects comparisons without a contiguous window, or with a months filter", async () => {
      await expect(themeTrend(ro, scope(), { theme: "parking" })).rejects.toThrow(ComparisonError);
      await expect(themeTrend(ro, scope({ since: "2026-02-01" }), { theme: "parking" })).rejects.toThrow(ComparisonError);
      await expect(themeTrend(ro, scope({ since: "2026-01-01", until: "2026-03-31", months: [12, 1, 2] }), { theme: "parking" })).rejects.toThrow(/months/);
    });
  });

  describe("ranking", () => {
    it("ranks themes by distinct reviews and excludes 'other'", async () => {
      await replaceTagSet(admin, { source: SRC, sourceReviewId: "syn-L07", tagSource: "manual", taxonomyVersion: "v1", tags: [{ theme: "other", sentiment: "negative" }] });
      const r = await themeRanking(ro, scope(), { sentiment: "negative" });
      expect(r.themes).toEqual([
        { theme: "parking", count: 5 },
        { theme: "food", count: 1 },
        { theme: "front-desk", count: 1 },
        { theme: "housekeeping", count: 1 },
        { theme: "rooms", count: 1 },
      ]);
    });

    it("respects the limit and the property filter", async () => {
      const r = await themeRanking(ro, scope({ propertyNames: [LODGE] }), { sentiment: "negative", limit: 2 });
      expect(r.themes).toEqual([{ theme: "parking", count: 5 }, { theme: "front-desk", count: 1 }]);
      expect(r.coverage.totalReviews).toBe(11);
    });
  });

  describe("filters", () => {
    it("matches canonical property names case-insensitively", async () => {
      const r = await themeMentions(ro, scope({ propertyNames: ["synthetic LODGE "] }), { theme: "parking" });
      expect(counts(r)).toEqual({ Lodge: 7 });
    });

    it("an unknown property name is an error, even beside a valid one; nothing is broadened", async () => {
      await expect(themeMentions(ro, scope({ propertyNames: ["Nope Hotel"] }), { theme: "parking" })).rejects.toThrow(UnknownPropertyError);
      const err = await themeMentions(ro, scope({ propertyNames: [LODGE, "Nope Hotel"] }), { theme: "parking" }).catch((e) => e);
      expect(err).toBeInstanceOf(UnknownPropertyError);
      expect(err.known).toContain("Synthetic Spa");
    });

    it("only properties with reviews from the counted source are known, so practice properties never appear", async () => {
      const real = scope({ propertyNames: [LODGE] }, { source: "google_business_profile" });
      const err = await themeMentions(ro, real, { theme: "parking" }).catch((e) => e);
      expect(err).toBeInstanceOf(UnknownPropertyError);
      expect(err.known).toEqual([]);
      // With no source restriction, every property is known (scripts and tests).
      const any = await themeMentions(ro, scope({ propertyNames: [LODGE] }, { source: undefined }), { theme: "parking" });
      expect(any.scopeLabel).toBe(LODGE);
    });

    it("a company alias means all properties, only when no specific property is named", async () => {
      const all = await themeMentions(ro, scope({ propertyNames: ["BCP"] }), { theme: "parking" });
      expect(all.scopeLabel).toBe("All properties (BCP)");
      expect(all.total.count).toBe(9);
      const one = await themeMentions(ro, scope({ propertyNames: ["BCP", LODGE] }), { theme: "parking" });
      expect(one.scopeLabel).toBe(LODGE);
      await expect(themeMentions(ro, scope({ propertyNames: ["BCP", "Nope"] }), { theme: "parking" })).rejects.toThrow(UnknownPropertyError);
    });

    it("filters by property type and rating, combined with AND", async () => {
      expect(counts(await themeMentions(ro, scope({ propertyTypes: ["restaurant"] }), { theme: "parking" }))).toEqual({ Bistro: 1 });
      const r = await themeMentions(ro, scope({ propertyNames: [LODGE], minRating: 4, maxRating: 5 }), { theme: "parking" });
      expect(r.total.count).toBe(5); // L01 L03 L10 L11 L12
      expect(r.total.coverage.totalReviews).toBe(8);
    });

    it("rejects unknown themes, bad dates and inverted windows", async () => {
      await expect(themeMentions(ro, scope(), { theme: "nope" })).rejects.toThrow(UnknownThemeError);
      await expect(themeMentions(ro, scope({ since: "2026-13-01" }), { theme: "parking" })).rejects.toThrow(StatsInputError);
      await expect(themeMentions(ro, scope({ since: "2026-03-01", until: "2026-02-01" }), { theme: "parking" })).rejects.toThrow(/after/);
      await expect(themeMentions(ro, scope({ months: [13] }), { theme: "parking" })).rejects.toThrow(/month/);
    });

    it("requires a taxonomy version", async () => {
      await expect(themeMentions(ro, scope({}, { taxonomyVersion: " " }), { theme: "parking" })).rejects.toThrow(/taxonomyVersion/);
    });
  });

  describe("tag source and version are never mixed", () => {
    it("llm and manual tags, and other versions, stay separate", async () => {
      await replaceTagSet(admin, { source: SRC, sourceReviewId: "syn-L02", tagSource: "llm", taxonomyVersion: "v1", tags: [{ theme: "parking", sentiment: "positive" }] });
      await replaceTagSet(admin, { source: SRC, sourceReviewId: "syn-L04", tagSource: "manual", taxonomyVersion: "v2", tags: [{ theme: "parking", sentiment: "negative" }] });
      expect((await themeMentions(ro, scope({ propertyNames: [LODGE] }), { theme: "parking" })).total.count).toBe(7);
      const llm = await themeMentions(ro, scope({ propertyNames: [LODGE] }, { tagSource: "llm" }), { theme: "parking" });
      expect(llm.total.count).toBe(1);
      expect(llm.total.coverage).toMatchObject({ currentTagged: 1, untagged: 9 }); // 10 text reviews, one llm-tagged
      const v2 = await themeMentions(ro, scope({ propertyNames: [LODGE] }, { taxonomyVersion: "v2" }), { theme: "parking" });
      expect(v2.total.count).toBe(1);
    });
  });

  describe("stale and removed reviews", () => {
    it("an edited review's manual tags are excluded until revalidated, and coverage shows it", async () => {
      const edited = reviewsJson.map((l) => ({
        ...l,
        reviews: l.reviews.map((r) => (r.reviewId === "syn-L01" ? { ...r, comment: "Totally rewritten." } : r)),
      }));
      await importLocations(admin, edited, { source: SRC });
      const r = await themeMentions(ro, scope({ propertyNames: [LODGE] }), { theme: "parking" });
      expect(r.total.count).toBe(6); // L01 no longer counted
      expect(r.total.coverage).toMatchObject({ currentTagged: 8, stale: 1, untagged: 1 });

      await replaceTagSet(admin, { source: SRC, sourceReviewId: "syn-L01", tagSource: "manual", taxonomyVersion: "v1", tags: [{ theme: "parking", sentiment: "negative" }] });
      const after = await themeMentions(ro, scope({ propertyNames: [LODGE] }), { theme: "parking" });
      expect(after.total.count).toBe(7);
      expect(after.total.coverage.stale).toBe(0);
    });

    it("soft-deleted reviews are excluded from counts and totals", async () => {
      await admin.query("UPDATE reviews SET deleted_at = now() WHERE source_review_id = 'syn-L12'");
      const r = await themeMentions(ro, scope({ propertyNames: [LODGE] }), { theme: "parking" });
      expect(r.total.count).toBe(6);
      expect(r.total.coverage.totalReviews).toBe(10);
    });
  });

  it("the read-only role can run every template", async () => {
    await expect(themeMentions(ro, scope(), { theme: "food" })).resolves.toBeTruthy();
    await expect(themeRanking(ro, scope())).resolves.toBeTruthy();
  });
});
