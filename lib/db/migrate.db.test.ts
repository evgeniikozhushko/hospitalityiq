/**
 * Integration test against the disposable Postgres (docker compose up -d --wait).
 * Skipped with a hint when DATABASE_URL_TEST is not set.
 */
import path from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "./migrate";
import { readonlyTestUrl, resetTestDatabase, testDatabaseUrl } from "./testDb";

const url = testDatabaseUrl();
if (!url) console.warn("DATABASE_URL_TEST not set: skipping database tests (see .env.example).");

describe.skipIf(!url)("migrations (database)", () => {
  const admin = new Client({ connectionString: url! });

  beforeAll(async () => {
    await resetTestDatabase(url!);
    await admin.connect();
  });
  afterAll(async () => {
    await admin.end();
  });

  it("creates the schema and seeds the provisional themes", async () => {
    const { rows } = await admin.query("SELECT slug FROM themes ORDER BY slug");
    expect(rows.map((r) => r.slug)).toEqual([
      "food", "front-desk", "housekeeping", "other", "parking", "rooms", "spa", "value",
    ]);
  });

  it("is idempotent: running again applies nothing", async () => {
    const dir = path.join(process.cwd(), "db/migrations");
    expect(await runMigrations(admin, dir)).toEqual([]);
  });

  it("derives has_text, so rating-only reviews are not text reviews", async () => {
    await admin.query(
      "INSERT INTO properties (location_id, name, type) VALUES ('p1', 'Test Lodge', 'hotel')",
    );
    await admin.query(
      `INSERT INTO reviews (source, source_review_id, property_id, rating, text, created_at, text_hash)
       SELECT 'google_business_profile', v.id, p.id, 5, v.txt, now(), 'h'
       FROM properties p, (VALUES ('r1', 'Great stay'), ('r2', NULL), ('r3', '')) AS v(id, txt)`,
    );
    const { rows } = await admin.query("SELECT source_review_id, has_text FROM reviews ORDER BY 1");
    expect(rows).toEqual([
      { source_review_id: "r1", has_text: true },
      { source_review_id: "r2", has_text: false },
      { source_review_id: "r3", has_text: false },
    ]);
  });

  it("enforces one review per (source, source_review_id)", async () => {
    await expect(
      admin.query(
        `INSERT INTO reviews (source, source_review_id, property_id, text, created_at, text_hash)
         SELECT source, source_review_id, property_id, 'dup', now(), 'h' FROM reviews LIMIT 1`,
      ),
    ).rejects.toThrow(/duplicate key/);
  });

  it("deletes a tag set's themes when its review_tagging row is removed", async () => {
    await admin.query(
      `INSERT INTO review_tagging (review_id, tag_source, taxonomy_version)
       SELECT id, 'manual', 'v1' FROM reviews WHERE source_review_id = 'r1'`,
    );
    await admin.query(
      `INSERT INTO review_themes (review_id, tag_source, taxonomy_version, theme_id, sentiment)
       SELECT r.id, 'manual', 'v1', t.id, 'positive' FROM reviews r, themes t
       WHERE r.source_review_id = 'r1' AND t.slug = 'rooms'`,
    );
    expect((await admin.query("SELECT 1 FROM current_review_themes")).rowCount).toBe(1);
    await admin.query("DELETE FROM review_tagging");
    expect((await admin.query("SELECT 1 FROM review_themes")).rowCount).toBe(0);
  });

  it("lets the read-only role read but not write", async () => {
    const ro = new Client({ connectionString: readonlyTestUrl(url!) });
    await ro.connect();
    try {
      expect((await ro.query("SELECT count(*)::int AS n FROM reviews")).rows[0].n).toBe(3);
      await expect(ro.query("DELETE FROM reviews")).rejects.toThrow(/permission denied|read-only/);
      await expect(ro.query("INSERT INTO themes (slug, label) VALUES ('x', 'x')")).rejects.toThrow();
    } finally {
      await ro.end();
    }
  });
});
