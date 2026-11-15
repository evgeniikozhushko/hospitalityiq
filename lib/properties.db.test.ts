/**
 * The planner prompt lists the known properties, so the list must not change when its
 * source moves from the Qdrant index to Postgres: a different list shifts routing.
 * The index holds a point for every review with text and a rating, so the names it
 * would report are worked out from the fixture file by that rule and compared here.
 */
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { z } from "zod";
import { importLocations } from "./db/import";
import { readonlyTestUrl, resetTestDatabase, testDatabaseUrl } from "./db/testDb";
import { GOOGLE_SOURCE } from "./pointId";
import { createPropertyLister, propertiesFromDb } from "./properties";
import { LocationReviewsSchema, ratingToNumber } from "./schema";

const url = testDatabaseUrl();

describe.skipIf(!url)("property list (database)", () => {
  const admin = new Client({ connectionString: url! });
  const ro = new Client({ connectionString: url ? readonlyTestUrl(url) : undefined });
  let fixtures: z.infer<typeof LocationReviewsSchema>[];

  beforeAll(async () => {
    await resetTestDatabase(url!);
    await admin.connect();
    await ro.connect();
    const read = async (file: string) => z.array(LocationReviewsSchema).parse(JSON.parse(await readFile(file, "utf8")));
    fixtures = await read("data/sample-reviews.json");
    await importLocations(admin, fixtures, { source: GOOGLE_SOURCE });
    await importLocations(admin, await read("data/synthetic/reviews.json"), { source: "synthetic" });
    // A property whose only review cannot be searched (no text) is not in the index either.
    await importLocations(
      admin,
      [
        {
          locationId: "loc-rating-only",
          propertyName: "Rating Only Inn",
          propertyType: "hotel",
          reviews: [{ reviewId: "ro-1", starRating: "FIVE", createTime: "2026-01-01T00:00:00Z" }],
        },
      ],
      { source: GOOGLE_SOURCE },
    );
  });
  afterAll(async () => {
    await admin.end();
    await ro.end();
  });

  it("lists exactly the properties the index holds for the fixtures, in the same order", async () => {
    const indexed = fixtures
      .filter((loc) => loc.reviews.some((r) => r.comment && ratingToNumber(r.starRating) !== null))
      .map((loc) => loc.propertyName)
      .sort();
    expect(indexed.length).toBeGreaterThan(0);

    const list = createPropertyLister({
      primary: () => propertiesFromDb(ro, GOOGLE_SOURCE),
      fallback: async () => {
        throw new Error("the index must not be needed");
      },
    });
    expect(await list()).toEqual(indexed);
  });

  it("leaves out practice properties and properties with nothing searchable", async () => {
    const names = await propertiesFromDb(ro, GOOGLE_SOURCE);
    expect(names.some((n) => n.startsWith("Synthetic"))).toBe(false);
    expect(names).not.toContain("Rating Only Inn");
    expect((await propertiesFromDb(ro, "synthetic")).sort()).toEqual(["Synthetic Bistro", "Synthetic Lodge", "Synthetic Spa"]);
  });
});
