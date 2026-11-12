/**
 * The statistics route end to end against the disposable test database, with the
 * planner stubbed. Expected text is worked out by hand from data/synthetic (see the
 * table at the top of lib/reviewStats.db.test.ts), not produced by running the code.
 *
 * Parking, all properties, manual v1 tags, source "synthetic":
 *   Lodge  7 of 9 tagged (11 reviews: 9 tagged, 1 untagged, 1 rating-only)
 *   Bistro 1 of 3 tagged, Spa 1 of 3 tagged
 *   Total  9 of 15 tagged (17 reviews: 15 tagged, 1 not yet tagged, 1 rating-only)
 */
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { answerWith, type AnswerDeps, type AnswerEvent } from "./answerPipeline";
import { importLocations } from "./db/import";
import { loadManualTags, ManualTagsFileSchema } from "./db/manualTags";
import { readonlyTestUrl, resetTestDatabase, testDatabaseUrl } from "./db/testDb";
import { EMPTY_FILTERS, LocationReviewsSchema, type PlannerOutput, type QueryFilters, type StatRequest } from "./schema";

const url = testDatabaseUrl();

const plan = (stat: Partial<StatRequest>, filters: Partial<QueryFilters> = {}): PlannerOutput => ({
  intent: "review_insight",
  mode: "aggregate",
  searchQuery: "parking",
  filters: { ...EMPTY_FILTERS, ...filters },
  route: "statistics",
  stat: { kind: "mentions", themes: ["parking"], topic: "parking", sentiment: null, ...stat },
});

describe.skipIf(!url)("answer pipeline, statistics route (database)", () => {
  const admin = new Client({ connectionString: url! });
  const ro = new Client({ connectionString: url ? readonlyTestUrl(url) : undefined });

  beforeAll(async () => {
    await resetTestDatabase(url!);
    await admin.connect();
    await ro.connect();
    const reviews = z.array(LocationReviewsSchema).parse(JSON.parse(await readFile("data/synthetic/reviews.json", "utf8")));
    await importLocations(admin, reviews, { source: "synthetic" });
    const tags = ManualTagsFileSchema.parse(JSON.parse(await readFile("data/synthetic/tags.json", "utf8")));
    await loadManualTags(admin, tags);
  });
  afterAll(async () => {
    await admin.end();
    await ro.end();
  });

  const deps = (p: PlannerOutput) =>
    ({
      listProperties: vi.fn(async () => ["Synthetic Lodge", "Synthetic Bistro", "Synthetic Spa"]),
      plan: vi.fn(async () => p),
      retrieve: vi.fn(async () => ({ sources: [], relaxed: false })),
      streamAnswer: vi.fn(async function* () {
        yield "MODEL ANSWER";
      }),
      statsDb: () => ro,
      stats: { tagSource: "manual", taxonomyVersion: "v1", source: "synthetic", provisional: false },
      today: "2026-11-10",
      logError: vi.fn(),
    }) satisfies AnswerDeps;

  async function run(d: AnswerDeps) {
    const events: AnswerEvent[] = [];
    for await (const e of answerWith("q", d)) events.push(e);
    const text = events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
    return { events, types: events.map((e) => e.type), text };
  }

  it("answers a count with the exact, hand-computed text and never calls the model", async () => {
    const d = deps(plan({}));
    const { types, text, events } = await run(d);
    expect(types).toEqual(["plan", "stats", "delta", "done"]);
    expect(text).toBe(
      [
        "**Parking mentions · All properties**",
        "9 of 15 tagged reviews mention Parking (17 reviews in scope: 15 tagged, 1 not yet tagged, 1 rating-only).",
        "- Synthetic Lodge: 7 of 9 tagged reviews (78%)\n- Synthetic Bistro: 1 of 3 tagged reviews (33%)\n- Synthetic Spa: 1 of 3 tagged reviews (33%)",
        'For what guests say, ask: "What do guests say about parking?"',
      ].join("\n\n"),
    );
    expect(events[1]).toMatchObject({ type: "stats", outcome: { kind: "mentions", result: { total: { count: 9 } } } });
    expect(d.retrieve).not.toHaveBeenCalled();
    expect(d.streamAnswer).not.toHaveBeenCalled();
    expect(d.logError).not.toHaveBeenCalled();
  });

  it("counts complaints at one property", async () => {
    const { text } = await run(deps(plan({ sentiment: "negative" }, { propertyNames: ["synthetic lodge"] })));
    expect(text).toContain("5 of 9 tagged reviews complain about Parking (11 reviews in scope: 9 tagged, 1 not yet tagged, 1 rating-only).");
  });

  it("answers an unknown property with a fixed message, never widening to all properties", async () => {
    const d = deps(plan({}, { propertyNames: ["Moon Hotel"] }));
    const { types, text } = await run(d);
    expect(types).toEqual(["plan", "delta", "done"]);
    expect(text).toBe(
      "I don't know a property named Moon Hotel. Known properties: Synthetic Bistro, Synthetic Lodge, Synthetic Spa.",
    );
    expect(d.retrieve).not.toHaveBeenCalled();
  });

  it("never counts the practice data under the real source", async () => {
    const d = { ...deps(plan({})), stats: { tagSource: "manual" as const, taxonomyVersion: "v1", source: "google_business_profile", provisional: false } };
    const { text } = await run(d);
    expect(text).toContain("There are no reviews in scope, so there is nothing to count.");
  });
});
