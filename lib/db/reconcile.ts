/**
 * Compares the SET of live, indexable review IDs in Postgres with the points in
 * Qdrant for one source (equal counts can hide different IDs), plus text hashes.
 * Points of another source, or with no source, are counted but never judged.
 */
import type { Client } from "pg";
import { pointIdForReview } from "../pointId";
import { INDEXABLE_SQL } from "./payload";
import type { Embed, VectorIndex } from "./vectorIndex";
import { syncIndex, syncLockKey, type SyncReport } from "./qdrantSync";

export type ReconcileReport = {
  source: string;
  postgresActive: number;
  qdrantInScope: number;
  /** In Postgres, absent from Qdrant (source review IDs). */
  missing: string[];
  /** In Qdrant for this source, not live in Postgres (point IDs). */
  extra: string[];
  /** In both, but the text hash differs or is absent (source review IDs). */
  hashMismatch: string[];
  /** Points belonging to another source or with no source: reported, never touched. */
  outOfScope: number;
  ok: boolean;
};

export async function reconcile(
  client: Client,
  index: VectorIndex,
  source: string,
): Promise<ReconcileReport> {
  const { rows } = await client.query<{ source_review_id: string; text_hash: string }>(
    `SELECT r.source_review_id, r.text_hash FROM reviews r WHERE r.source = $1 AND ${INDEXABLE_SQL}`,
    [source],
  );
  const pg = new Map(rows.map((r) => [pointIdForReview(source, r.source_review_id), r]));
  const points = await index.listPoints();
  const inScope = points.filter((p) => p.source === source);

  const qd = new Map(inScope.map((p) => [p.id, p]));
  const missing: string[] = [];
  const hashMismatch: string[] = [];
  for (const [id, row] of pg) {
    const point = qd.get(id);
    if (!point) missing.push(row.source_review_id);
    else if (point.textHash !== row.text_hash) hashMismatch.push(row.source_review_id);
  }
  const extra = inScope.filter((p) => !pg.has(p.id)).map((p) => p.id);
  missing.sort();
  hashMismatch.sort();
  extra.sort();

  return {
    source,
    postgresActive: pg.size,
    qdrantInScope: inScope.length,
    missing,
    extra,
    hashMismatch,
    outOfScope: points.length - inScope.length,
    ok: missing.length === 0 && extra.length === 0 && hashMismatch.length === 0,
  };
}

export type ReindexReport = { sync: SyncReport; extraRemoved: number; reconcile: ReconcileReport };

/**
 * Rebuild Qdrant for one source from Postgres. Hashes are cleared only for live
 * indexable reviews (they re-embed); soft-deleted / text-free reviews keep theirs
 * because that is the signal their points still need removing, which sync does.
 * Extra points are deleted only when their payload source is this source.
 *
 * The per-source sync lock is held for the whole operation. Without it, a sync
 * that adds a point after reconcile reads Postgres but before it lists Qdrant
 * would look like an "extra" point and be deleted while Postgres still records
 * it as indexed. (The lock is session-level and re-entrant, so the nested lock
 * inside syncIndex is fine.)
 */
export async function reindex(
  client: Client,
  index: VectorIndex,
  embed: Embed,
  source: string,
): Promise<ReindexReport> {
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [syncLockKey(source)]);
  try {
    await client.query(
      `UPDATE reviews r SET indexed_text_hash = NULL, indexed_payload_hash = NULL
       WHERE r.source = $1 AND ${INDEXABLE_SQL}`,
      [source],
    );
    const sync = await syncIndex(client, index, embed, source);

    const before = await reconcile(client, index, source);
    if (before.extra.length > 0) {
      // Invalidate the hashes of Postgres reviews whose point is about to go, BEFORE
      // removing it. A review soft-deleted by a concurrent import still carries its
      // hashes; if they survived the removal and the review were later restored
      // unchanged, sync would see matching hashes and never re-index it. Clearing
      // first is retry-safe: if the removal fails, the row has NULL hashes and the
      // never-indexed path in syncIndex checks Qdrant and removes the point next run.
      const extraIds = new Set(before.extra);
      const hashed = await client.query<{ id: string; source_review_id: string }>(
        `SELECT id, source_review_id FROM reviews
         WHERE source = $1 AND (indexed_text_hash IS NOT NULL OR indexed_payload_hash IS NOT NULL)`,
        [source],
      );
      const stale = hashed.rows
        .filter((r) => extraIds.has(pointIdForReview(source, r.source_review_id)))
        .map((r) => r.id);
      if (stale.length > 0) {
        await client.query(
          "UPDATE reviews SET indexed_text_hash = NULL, indexed_payload_hash = NULL WHERE id = ANY($1::bigint[])",
          [stale],
        );
      }
      await index.remove(before.extra);
    }

    return { sync, extraRemoved: before.extra.length, reconcile: await reconcile(client, index, source) };
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [syncLockKey(source)]);
  }
}
