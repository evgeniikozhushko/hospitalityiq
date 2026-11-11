/**
 * Integration tests for Postgres import, Qdrant sync, reconcile and reindex,
 * using the disposable Postgres and an in-memory Qdrant fake.
 */
import { Client } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importLocations } from "./import";
import { FakeIndex, fakeEmbed } from "./fakeIndex";
import { reconcile, reindex } from "./reconcile";
import { syncIndex } from "./qdrantSync";
import { resetTestDatabase, testDatabaseUrl } from "./testDb";
import { pointIdForReview } from "../pointId";
import type { LocationReviews } from "../schema";

const url = testDatabaseUrl();
const SRC = "google_business_profile";

const review = (id: string, over: Record<string, unknown> = {}) => ({
  reviewId: id,
  reviewer: { displayName: "Jane Fixture", profilePhotoUrl: "http://x/p.png", isAnonymous: false },
  starRating: "FIVE" as const,
  comment: `Lovely stay ${id}`,
  createTime: "2026-01-14T18:22:00Z",
  ...over,
});

const lodge = (reviews: ReturnType<typeof review>[]): LocationReviews => ({
  locationId: "loc-a",
  propertyName: "Test Lodge",
  propertyType: "hotel",
  reviews,
});

describe.skipIf(!url)("ingest (database)", () => {
  const c = new Client({ connectionString: url! });
  const q = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
  let index: FakeIndex;
  let embed: ReturnType<typeof fakeEmbed>;

  beforeAll(async () => {
    await resetTestDatabase(url!);
    await c.connect();
  });
  afterAll(async () => {
    await c.end();
  });
  beforeEach(async () => {
    await c.query("TRUNCATE imports, reviews, properties RESTART IDENTITY CASCADE");
    index = new FakeIndex();
    embed = fakeEmbed();
  });

  const full = [review("r1"), review("r2"), review("r3")];

  it("importing the same file twice creates no duplicates and re-embeds nothing", async () => {
    await importLocations(c, [lodge(full)]);
    await syncIndex(c, index, embed, SRC);
    const embeddedOnce = embed.embedded.length;
    const second = await importLocations(c, [lodge(full)]);
    await syncIndex(c, index, embed, SRC);
    expect(second[0]).toMatchObject({ inserted: 0, unchanged: 3, status: "succeeded" });
    expect(await q("SELECT 1 FROM reviews")).toHaveLength(3);
    expect(embed.embedded.length).toBe(embeddedOnce);
    expect(index.points.size).toBe(3);
  });

  it("never stores reviewer identity", async () => {
    await importLocations(c, [lodge(full)]);
    await syncIndex(c, index, embed, SRC);
    const dump = JSON.stringify(await q("SELECT * FROM reviews")) + JSON.stringify([...index.points.values()]);
    expect(dump).not.toContain("Jane Fixture");
    expect(dump).not.toContain("p.png");
  });

  it("keeps rating-only reviews in Postgres but not in Qdrant", async () => {
    await importLocations(c, [lodge([review("r1"), review("r2", { comment: undefined })])]);
    await syncIndex(c, index, embed, SRC);
    expect(await q("SELECT 1 FROM reviews")).toHaveLength(2);
    expect(index.points.size).toBe(1);
    expect((await reconcile(c, index, SRC)).ok).toBe(true);
  });

  it("an edited review updates in place: llm tags dropped, manual kept and stale", async () => {
    await importLocations(c, [lodge(full)]);
    const [{ id }] = await q("SELECT id FROM reviews WHERE source_review_id = 'r1'");
    await c.query(
      `INSERT INTO review_tagging (review_id, tag_source, taxonomy_version) VALUES ($1,'manual','v1'), ($1,'llm','v1')`,
      [id],
    );
    const res = await importLocations(c, [lodge([review("r1", { comment: "Totally different text" }), review("r2"), review("r3")])]);
    expect(res[0].textChanged).toBe(1);
    const tagging = await q("SELECT tag_source, stale FROM review_tagging ORDER BY tag_source");
    expect(tagging).toEqual([{ tag_source: "manual", stale: true }]);
    expect(await q("SELECT 1 FROM reviews")).toHaveLength(3);
  });

  it("a partial import deletes nothing", async () => {
    await importLocations(c, [lodge(full)]);
    await importLocations(c, [lodge([review("r1")])]);
    expect(await q("SELECT 1 FROM reviews WHERE deleted_at IS NULL")).toHaveLength(3);
  });

  it("a complete snapshot only previews deletion unless applied", async () => {
    await importLocations(c, [lodge(full)]);
    const preview = await importLocations(c, [lodge([review("r1")])], { completeSnapshot: true });
    expect(preview[0].missing).toEqual(["r2", "r3"]);
    expect(preview[0].deleted).toBe(0);
    expect(await q("SELECT 1 FROM reviews WHERE deleted_at IS NULL")).toHaveLength(3);

    const applied = await importLocations(c, [lodge([review("r1")])], { completeSnapshot: true, apply: true });
    expect(applied[0].deleted).toBe(2);
    expect(await q("SELECT 1 FROM reviews WHERE deleted_at IS NULL")).toHaveLength(1);
  });

  it("deletion is scoped to the property and source of the snapshot", async () => {
    const other: LocationReviews = { ...lodge([review("o1")]), locationId: "loc-b", propertyName: "Other Place" };
    await importLocations(c, [lodge(full), other]);
    await importLocations(c, [lodge([review("r1")])], { completeSnapshot: true, apply: true });
    const live = await q("SELECT source_review_id FROM reviews WHERE deleted_at IS NULL ORDER BY 1");
    expect(live.map((r) => r.source_review_id)).toEqual(["o1", "r1"]);
    await importLocations(c, [lodge([review("zz")])], { source: "other_source", completeSnapshot: true, apply: true });
    expect(await q("SELECT 1 FROM reviews WHERE source = 'google_business_profile' AND deleted_at IS NULL")).toHaveLength(2);
  });

  it("refuses an empty complete snapshot and records a failed import without deleting", async () => {
    await importLocations(c, [lodge(full)]);
    const res = await importLocations(c, [lodge([])], { completeSnapshot: true, apply: true });
    expect(res[0].status).toBe("failed");
    expect(await q("SELECT 1 FROM reviews WHERE deleted_at IS NULL")).toHaveLength(3);
    expect((await q("SELECT status FROM imports ORDER BY id DESC LIMIT 1"))[0].status).toBe("failed");
  });

  it("a failing property rolls back and deletes nothing, other properties still import", async () => {
    await importLocations(c, [lodge(full)]);
    // Second property reuses the first one's name -> unique violation -> that property fails.
    const clash: LocationReviews = { ...lodge([review("c1")]), locationId: "loc-clash" };
    const ok: LocationReviews = { ...lodge([review("g1")]), locationId: "loc-ok", propertyName: "Fine Place" };
    const res = await importLocations(c, [clash, ok], { completeSnapshot: true, apply: true });
    expect(res.map((r) => r.status)).toEqual(["failed", "succeeded"]);
    expect(await q("SELECT 1 FROM reviews WHERE source_review_id = 'c1'")).toHaveLength(0);
    expect(await q("SELECT 1 FROM reviews WHERE source_review_id IN ('r1','r2','r3') AND deleted_at IS NULL")).toHaveLength(3);
  });

  it("a reappearing review is restored and re-indexed", async () => {
    await importLocations(c, [lodge(full)]);
    await syncIndex(c, index, embed, SRC);
    await importLocations(c, [lodge([review("r1"), review("r2")])], { completeSnapshot: true, apply: true });
    const removed = await syncIndex(c, index, embed, SRC);
    expect(removed.removed).toBe(1);
    expect(index.points.has(pointIdForReview(SRC, "r3"))).toBe(false);
    const back = await importLocations(c, [lodge(full)]);
    expect(back[0].restored).toBe(1);
    await syncIndex(c, index, embed, SRC);
    expect(index.points.has(pointIdForReview(SRC, "r3"))).toBe(true);
    expect((await reconcile(c, index, SRC)).ok).toBe(true);
  });

  it("a failed Qdrant write is retried on the next sync", async () => {
    await importLocations(c, [lodge(full)]);
    index.failUpsert = true;
    await expect(syncIndex(c, index, embed, SRC)).rejects.toThrow(/qdrant down/);
    expect(await q("SELECT 1 FROM reviews WHERE indexed_text_hash IS NOT NULL")).toHaveLength(0);
    index.failUpsert = false;
    await syncIndex(c, index, embed, SRC);
    expect(index.points.size).toBe(3);
    expect((await reconcile(c, index, SRC)).ok).toBe(true);
  });

  it("a failed Qdrant removal is retried and the hashes are kept until it succeeds", async () => {
    await importLocations(c, [lodge(full)]);
    await syncIndex(c, index, embed, SRC);
    await importLocations(c, [lodge([review("r1"), review("r2")])], { completeSnapshot: true, apply: true });
    index.failRemove = true;
    await expect(syncIndex(c, index, embed, SRC)).rejects.toThrow();
    expect(await q("SELECT 1 FROM reviews WHERE source_review_id = 'r3' AND indexed_text_hash IS NOT NULL")).toHaveLength(1);
    index.failRemove = false;
    await syncIndex(c, index, embed, SRC);
    expect(index.points.size).toBe(2);
  });

  it("a rating change refreshes the payload without re-embedding", async () => {
    await importLocations(c, [lodge(full)]);
    await syncIndex(c, index, embed, SRC);
    const n = embed.embedded.length;
    await importLocations(c, [lodge([review("r1", { starRating: "TWO" }), review("r2"), review("r3")])]);
    const rep = await syncIndex(c, index, embed, SRC);
    expect(rep).toMatchObject({ embedded: 0, payloadRefreshed: 1 });
    expect(embed.embedded.length).toBe(n);
    expect(index.points.get(pointIdForReview(SRC, "r1"))!.payload.rating).toBe(2);
  });

  it("a removed owner reply disappears from the point, and a changed one updates", async () => {
    const withReply = (text: string) => ({ reviewReply: { comment: text, updateTime: "2026-01-15T10:00:00Z" } });
    const id = pointIdForReview(SRC, "r1");
    await importLocations(c, [lodge([review("r1", withReply("Thanks for staying"))])]);
    await syncIndex(c, index, embed, SRC);
    expect(index.points.get(id)!.payload.ownerReply).toBe("Thanks for staying");

    await importLocations(c, [lodge([review("r1", withReply("Updated reply"))])]);
    expect(await syncIndex(c, index, embed, SRC)).toMatchObject({ embedded: 0, payloadRefreshed: 1 });
    expect(index.points.get(id)!.payload.ownerReply).toBe("Updated reply");

    await importLocations(c, [lodge([review("r1")])]);
    expect(await syncIndex(c, index, embed, SRC)).toMatchObject({ embedded: 0, payloadRefreshed: 1 });
    expect("ownerReply" in index.points.get(id)!.payload).toBe(false);
    expect((await reconcile(c, index, SRC)).ok).toBe(true);
  });

  it("removes a point an older pipeline left for a review that must not be indexed", async () => {
    const legacy = (id: string) =>
      index.points.set(pointIdForReview(SRC, id), {
        id: pointIdForReview(SRC, id),
        vector: [0, 0],
        payload: { reviewId: id, source: SRC, text: "old" },
      });
    legacy("r1");
    legacy("r2");
    legacy("other"); // no Postgres row: not this sync's business
    // r1 becomes text-free, r2 stays indexable; first ever import, so no indexed hash exists.
    await importLocations(c, [lodge([review("r1", { comment: undefined }), review("r2")])]);

    const first = await syncIndex(c, index, embed, SRC);
    expect(first.removed).toBe(1);
    expect(index.points.has(pointIdForReview(SRC, "r1"))).toBe(false);
    expect(index.points.has(pointIdForReview(SRC, "r2"))).toBe(true);
    expect(index.points.has(pointIdForReview(SRC, "other"))).toBe(true);

    const removeCalls = index.calls.remove;
    expect((await syncIndex(c, index, embed, SRC)).removed).toBe(0);
    expect(index.calls.remove).toBe(removeCalls); // nothing left to remove: no delete issued
  });

  it("retries removing a never-indexed review's point after a Qdrant failure", async () => {
    index.points.set(pointIdForReview(SRC, "r1"), {
      id: pointIdForReview(SRC, "r1"),
      vector: [0, 0],
      payload: { reviewId: "r1", source: SRC },
    });
    await importLocations(c, [lodge([review("r1", { comment: undefined })])]);
    index.failRemove = true;
    await expect(syncIndex(c, index, embed, SRC)).rejects.toThrow("qdrant down");
    expect(index.points.size).toBe(1);
    index.failRemove = false;
    expect((await syncIndex(c, index, embed, SRC)).removed).toBe(1);
    expect(index.points.size).toBe(0);
  });

  it("a property rename refreshes every review's payload", async () => {
    await importLocations(c, [lodge(full)]);
    await syncIndex(c, index, embed, SRC);
    await importLocations(c, [{ ...lodge(full), propertyName: "Renamed Lodge" }]);
    const rep = await syncIndex(c, index, embed, SRC);
    expect(rep.payloadRefreshed).toBe(3);
    expect(index.points.get(pointIdForReview(SRC, "r2"))!.payload.propertyName).toBe("Renamed Lodge");
  });

  it("a review edited while a sync is running is not marked as indexed", async () => {
    await importLocations(c, [lodge(full)]);
    const editor = new Client({ connectionString: url! });
    await editor.connect();
    const racing = async (texts: string[]) => {
      // The edit lands after the rows were read but before the hashes are recorded.
      await editor.query("UPDATE reviews SET text = 'edited mid-sync', text_hash = 'newhash' WHERE source_review_id = 'r1'");
      return embed(texts);
    };
    await syncIndex(c, index, racing, SRC);
    await editor.end();
    const [r1] = await q("SELECT text_hash, indexed_text_hash FROM reviews WHERE source_review_id = 'r1'");
    expect(r1.indexed_text_hash).not.toBe(r1.text_hash);
    const next = await syncIndex(c, index, embed, SRC);
    expect(next.embedded).toBe(1);
  });

  it("adopts existing points that have no textHash under their current IDs", async () => {
    await importLocations(c, [lodge(full)]);
    for (const id of ["r1", "r2", "r3"]) {
      index.points.set(pointIdForReview(SRC, id), {
        id: pointIdForReview(SRC, id),
        vector: [0, 0],
        payload: { reviewId: id, source: SRC, text: "old" }, // legacy: no textHash
      });
    }
    expect((await reconcile(c, index, SRC)).hashMismatch).toEqual(["r1", "r2", "r3"]);
    await syncIndex(c, index, embed, SRC);
    expect(index.points.size).toBe(3); // same IDs, overwritten, no duplicates
    expect((await reconcile(c, index, SRC)).ok).toBe(true);
  });

  it("reconcile compares ID sets, not just counts", async () => {
    await importLocations(c, [lodge(full)]);
    await syncIndex(c, index, embed, SRC);
    // Same number of points, but one is a different ID.
    index.points.delete(pointIdForReview(SRC, "r3"));
    index.points.set("ghost", { id: "ghost", vector: [1, 1], payload: { source: SRC, reviewId: "ghost", textHash: "x" } });
    const rep = await reconcile(c, index, SRC);
    expect(rep.postgresActive).toBe(rep.qdrantInScope);
    expect(rep).toMatchObject({ ok: false, missing: ["r3"], extra: ["ghost"] });
  });

  it("reconcile flags a text hash mismatch", async () => {
    await importLocations(c, [lodge(full)]);
    await syncIndex(c, index, embed, SRC);
    index.points.get(pointIdForReview(SRC, "r2"))!.payload.textHash = "stale";
    expect((await reconcile(c, index, SRC)).hashMismatch).toEqual(["r2"]);
  });

  it("reindex rebuilds a wiped Qdrant, still removes deleted reviews' points, and spares other sources", async () => {
    await importLocations(c, [lodge(full)]);
    await syncIndex(c, index, embed, SRC);
    await importLocations(c, [lodge([review("r1"), review("r2")])], { completeSnapshot: true, apply: true });
    // Qdrant is wiped, except points of another source, a point with no source, and a stale extra of ours.
    index.points.clear();
    index.points.set("other-1", { id: "other-1", vector: [0, 0], payload: { source: "ota", reviewId: "x" } });
    index.points.set("nosrc", { id: "nosrc", vector: [0, 0], payload: { reviewId: "y" } });
    index.points.set("extra-1", { id: "extra-1", vector: [0, 0], payload: { source: SRC, reviewId: "zzz", textHash: "q" } });

    const rep = await reindex(c, index, embed, SRC);
    expect(rep.reconcile.ok).toBe(true);
    expect(rep.extraRemoved).toBe(1);
    expect(rep.reconcile.outOfScope).toBe(2);
    expect(index.points.has("other-1")).toBe(true);
    expect(index.points.has("nosrc")).toBe(true);
    expect(index.points.has("extra-1")).toBe(false);
    expect(index.points.has(pointIdForReview(SRC, "r3"))).toBe(false); // soft-deleted stays out
    expect(index.points.has(pointIdForReview(SRC, "r1"))).toBe(true);
  });

  it("reindex keeps the removal signal for soft-deleted reviews whose point removal fails", async () => {
    await importLocations(c, [lodge(full)]);
    await syncIndex(c, index, embed, SRC);
    await importLocations(c, [lodge([review("r1"), review("r2")])], { completeSnapshot: true, apply: true });
    index.failRemove = true;
    await expect(reindex(c, index, embed, SRC)).rejects.toThrow();
    // Hash still set on the deleted review: the point is still known to need removal.
    expect(await q("SELECT 1 FROM reviews WHERE source_review_id = 'r3' AND indexed_text_hash IS NOT NULL")).toHaveLength(1);
    index.failRemove = false;
    const rep = await reindex(c, index, embed, SRC);
    expect(rep.reconcile.ok).toBe(true);
    expect(index.points.has(pointIdForReview(SRC, "r3"))).toBe(false);
  });
});
