/**
 * Tag set rules (db/migrations/0003_tag_sets.sql, ADR 0003), enforced by the database
 * as well as by lib/db/tagSets.ts, and the down migration.
 */
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importLocations } from "./import";
import { runMigrations } from "./migrate";
import { rollbackMigration } from "./rollback";
import { replaceTagSet } from "./tags";
import { activateTagSet, ensureTagSet, GateNotPassedError, getActiveTagSet, listTagSets } from "./tagSets";
import { resetTestDatabase, testDatabaseUrl } from "./testDb";

const url = testDatabaseUrl();
const SRC = "google_business_profile";
const TEXT = "Lovely room. The parking was a nightmare and cost too much. Breakfast was fine.";
const MODEL = { tagSource: "llm", taxonomyVersion: "v1", modelSnapshot: "gpt-4o-mini-2024-07-18", promptVersion: "p1" } as const;

describe.skipIf(!url)("tag sets (database)", () => {
  const c = new Client({ connectionString: url! });
  const q = async <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => (await c.query(sql, p)).rows as T[];
  const pass = (id: number) => c.query(`UPDATE tag_sets SET gate_passed_at = now(), gate_report = '{}' WHERE id = $1`, [id]);
  let manualV1 = 0;

  async function seed() {
    await c.query("TRUNCATE imports, reviews, properties RESTART IDENTITY CASCADE");
    await c.query("UPDATE active_tag_set SET tag_set_id = $1", [manualV1]);
    await c.query("DELETE FROM tag_sets WHERE id <> $1", [manualV1]);
    await importLocations(c, [
      {
        locationId: "loc-a",
        propertyName: "Test Lodge",
        propertyType: "hotel",
        reviews: [{ reviewId: "r1", starRating: "TWO", comment: TEXT, createTime: "2026-01-14T18:22:00Z" }],
      },
    ]);
  }

  beforeAll(async () => {
    await resetTestDatabase(url!);
    await c.connect();
    manualV1 = (await getActiveTagSet(c)).id;
  });
  afterAll(async () => {
    await c.end();
  });
  beforeEach(seed);

  it("starts with hand tags, taxonomy v1, as the active set", async () => {
    expect(await getActiveTagSet(c)).toMatchObject({ tagSource: "manual", taxonomyVersion: "v1", modelSnapshot: null });
  });

  describe("identity", () => {
    it("requires model fields for model tags and forbids them for hand tags, as NULL not empty strings", async () => {
      const ins = (src: string, model: string | null, prompt: string | null) =>
        c.query("INSERT INTO tag_sets (tag_source, taxonomy_version, model_snapshot, prompt_version) VALUES ($1, 'v9', $2, $3)", [src, model, prompt]);
      await expect(ins("manual", "gpt-4o-mini-2024-07-18", null)).rejects.toThrow(/tag_sets_source_fields/);
      await expect(ins("llm", null, "p1")).rejects.toThrow(/tag_sets_source_fields/);
      await expect(ins("llm", "gpt-4o-mini-2024-07-18", null)).rejects.toThrow(/tag_sets_source_fields/);
      await expect(ins("llm", "gpt-4o-mini-2024-07-18", " ")).rejects.toThrow(/check/);
      await expect(ins("manual", "", null)).rejects.toThrow(/check/);
    });

    it("refuses a model alias that can move: the snapshot must be dated", async () => {
      await expect(ensureTagSet(c, { ...MODEL, modelSnapshot: "gpt-4o-mini" })).rejects.toThrow(/model_snapshot/);
      await expect(ensureTagSet(c, { ...MODEL, modelSnapshot: "claude-sonnet-4-20250514" })).resolves.toBeGreaterThan(0);
    });

    it("is unique, including hand tag sets whose model fields are NULL", async () => {
      const a = await ensureTagSet(c, MODEL);
      expect(await ensureTagSet(c, MODEL)).toBe(a);
      expect(await ensureTagSet(c, { tagSource: "manual", taxonomyVersion: "v1" })).toBe(manualV1);
      await expect(c.query("INSERT INTO tag_sets (tag_source, taxonomy_version) VALUES ('manual', 'v1')")).rejects.toThrow(/tag_sets_identity/);
    });

    it("never changes once created", async () => {
      const a = await ensureTagSet(c, MODEL);
      await expect(c.query("UPDATE tag_sets SET prompt_version = 'p2' WHERE id = $1", [a])).rejects.toThrow(/identity cannot change/);
    });
  });

  describe("the active set", () => {
    it("cannot be a model's set that has not passed the gate, through the code or straight SQL", async () => {
      const a = await ensureTagSet(c, MODEL);
      await expect(activateTagSet(c, a)).rejects.toThrow(GateNotPassedError);
      await expect(c.query("UPDATE active_tag_set SET tag_set_id = $1", [a])).rejects.toThrow(/has not passed the gate/);
      expect((await getActiveTagSet(c)).id).toBe(manualV1);
    });

    it("can be a model's set once it has passed", async () => {
      const a = await ensureTagSet(c, MODEL);
      await pass(a);
      await activateTagSet(c, a);
      expect((await getActiveTagSet(c)).id).toBe(a);
      expect((await listTagSets(c)).filter((t) => t.active).map((t) => t.id)).toEqual([a]);
    });

    it("keeps its gate pass while active; it can be cleared after another set is activated", async () => {
      const a = await ensureTagSet(c, MODEL);
      await pass(a);
      await activateTagSet(c, a);
      await expect(c.query("UPDATE tag_sets SET gate_passed_at = NULL WHERE id = $1", [a])).rejects.toThrow(/gate pass cannot be cleared/);
      await activateTagSet(c, manualV1);
      await c.query("UPDATE tag_sets SET gate_passed_at = NULL WHERE id = $1", [a]);
      await expect(activateTagSet(c, a)).rejects.toThrow(GateNotPassedError);
    });

    it("needs a gate report beside a gate pass", async () => {
      const a = await ensureTagSet(c, MODEL);
      await expect(c.query("UPDATE tag_sets SET gate_passed_at = now() WHERE id = $1", [a])).rejects.toThrow(/tag_sets_gate_has_report/);
    });

    it("is exactly one row that cannot be removed, and its set cannot be deleted", async () => {
      await expect(c.query("INSERT INTO active_tag_set (singleton, tag_set_id) VALUES (true, $1)", [manualV1])).rejects.toThrow(/duplicate key/);
      await expect(c.query("INSERT INTO active_tag_set (singleton, tag_set_id) VALUES (false, $1)", [manualV1])).rejects.toThrow(/check/);
      await expect(c.query("DELETE FROM active_tag_set")).rejects.toThrow(/cannot be removed/);
      await expect(c.query("DELETE FROM tag_sets WHERE id = $1", [manualV1])).rejects.toThrow(/foreign key/);
    });
  });

  describe("evidence sentences", () => {
    const write = (tagSetId: number, evidenceSentence?: string | null) =>
      replaceTagSet(c, { source: SRC, sourceReviewId: "r1", tagSetId, tags: [{ theme: "parking", sentiment: "negative", evidenceSentence }] });

    it("a model tag must quote its sentence word for word from the stored text", async () => {
      const a = await ensureTagSet(c, MODEL);
      await expect(write(a, null)).rejects.toThrow(/needs an evidence sentence/);
      await expect(write(a, "The parking was terrible.")).rejects.toThrow(/not word for word/);
      await expect(write(a, "the parking was a nightmare")).rejects.toThrow(/not word for word/); // case matters
      await write(a, "The parking was a nightmare and cost too much.");
      expect(await q("SELECT evidence_sentence FROM review_themes")).toEqual([
        { evidence_sentence: "The parking was a nightmare and cost too much." },
      ]);
    });

    it("a hand tag has none", async () => {
      await expect(write(manualV1, "Lovely room.")).rejects.toThrow(/hand tags have no evidence sentence/);
      await write(manualV1);
    });
  });

  describe("down migration", () => {
    const columns = (table: string) =>
      q<{ column_name: string; data_type: string; is_nullable: string }>(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
         WHERE table_schema = 'public' AND table_name = $1 ORDER BY column_name`,
        [table],
      );
    const handTags = () =>
      q(`SELECT r.source_review_id, rt.tag_source, rt.taxonomy_version, t.slug, th.sentiment, rt.stale
         FROM review_themes th
         JOIN review_tagging rt USING (review_id, tag_source, taxonomy_version)
         JOIN reviews r ON r.id = th.review_id JOIN themes t ON t.id = th.theme_id
         ORDER BY 1, 3, 4, 5`);

    it("refuses while a model tag set exists", async () => {
      await ensureTagSet(c, MODEL);
      await expect(rollbackMigration(c, "0003_tag_sets")).rejects.toThrow(/model tag sets exist/);
      expect((await getActiveTagSet(c)).id).toBe(manualV1); // nothing changed
    });

    it("restores the 0002 schema with every hand tag, and the migration then applies again", async () => {
      const v2 = await ensureTagSet(c, { tagSource: "manual", taxonomyVersion: "v2" });
      await write2(manualV1, [{ theme: "parking", sentiment: "negative" }, { theme: "rooms", sentiment: "positive" }]);
      await write2(v2, [{ theme: "value", sentiment: "negative" }]);

      await rollbackMigration(c, "0003_tag_sets");

      expect(await columns("review_tagging")).toEqual([
        { column_name: "review_id", data_type: "bigint", is_nullable: "NO" },
        { column_name: "stale", data_type: "boolean", is_nullable: "NO" },
        { column_name: "tag_source", data_type: "text", is_nullable: "NO" },
        { column_name: "tagged_at", data_type: "timestamp with time zone", is_nullable: "NO" },
        { column_name: "taxonomy_version", data_type: "text", is_nullable: "NO" },
      ]);
      expect((await columns("review_themes")).map((x) => x.column_name)).toEqual([
        "review_id", "sentiment", "tag_source", "taxonomy_version", "theme_id",
      ]);
      expect((await columns("current_review_themes")).map((x) => x.column_name)).toEqual([
        "created_at", "property_id", "rating", "review_id", "sentiment", "tag_source", "taxonomy_version", "theme",
      ]);
      expect(await q("SELECT to_regclass('tag_sets') AS t, to_regclass('active_tag_set') AS a")).toEqual([{ t: null, a: null }]);
      const before = await handTags();
      expect(before).toEqual([
        { source_review_id: "r1", tag_source: "manual", taxonomy_version: "v1", slug: "parking", sentiment: "negative", stale: false },
        { source_review_id: "r1", tag_source: "manual", taxonomy_version: "v1", slug: "rooms", sentiment: "positive", stale: false },
        { source_review_id: "r1", tag_source: "manual", taxonomy_version: "v2", slug: "value", sentiment: "negative", stale: false },
      ]);

      // Forward again: 0003 is the only migration applied, and the same tags come back.
      expect(await runMigrations(c, path.join(process.cwd(), "db/migrations"))).toEqual(["0003_tag_sets.sql"]);
      const back = await q(
        `SELECT ts.taxonomy_version, t.slug, th.sentiment FROM review_themes th
         JOIN tag_sets ts ON ts.id = th.tag_set_id JOIN themes t ON t.id = th.theme_id ORDER BY 1, 2`,
      );
      expect(back).toEqual(before.map((r) => ({ taxonomy_version: r.taxonomy_version, slug: r.slug, sentiment: r.sentiment })));
      expect(await getActiveTagSet(c)).toMatchObject({ tagSource: "manual", taxonomyVersion: "v1" });
      manualV1 = (await getActiveTagSet(c)).id;
    });

    const write2 = (tagSetId: number, tags: Array<{ theme: string; sentiment: "positive" | "negative" }>) =>
      replaceTagSet(c, { source: SRC, sourceReviewId: "r1", tagSetId, tags });
  });
});
