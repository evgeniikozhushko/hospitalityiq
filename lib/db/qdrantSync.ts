/**
 * Brings Qdrant in line with Postgres for one source. Postgres is already
 * written; this step is safe to repeat and retries anything that failed.
 *
 * indexed_text_hash / indexed_payload_hash record what was actually SENT, and are
 * set only after Qdrant accepted it. They are compared with hashes computed from
 * the current row + property each time, so:
 *  - a failed Qdrant write leaves them behind and is retried next run;
 *  - an edit made while a sync is running is never marked as indexed (the hash
 *    stored is the one sent, which no longer matches);
 *  - a property rename or rating change refreshes the payload without re-embedding.
 * Pending removals are derived from the row, not queued: a point exists while
 * indexed_text_hash is set, and the row is soft-deleted, text-free or rating-less.
 */
import type { Client } from "pg";
import { pointIdForReview } from "../pointId";
import {
  buildPayload,
  hashPayload,
  INDEX_ROWS_SQL,
  NOT_INDEXABLE_SQL,
  type IndexRow,
} from "./payload";
import type { Embed, VectorIndex } from "./vectorIndex";

export type SyncReport = { removed: number; embedded: number; payloadRefreshed: number };

type DbIndexRow = IndexRow & {
  id: string;
  indexed_text_hash: string | null;
  indexed_payload_hash: string | null;
};

const BATCH = 100;

export async function syncIndex(
  client: Client,
  index: VectorIndex,
  embed: Embed,
  source: string,
): Promise<SyncReport> {
  const report: SyncReport = { removed: 0, embedded: 0, payloadRefreshed: 0 };
  // Only one sync per source at a time.
  await client.query("SELECT pg_advisory_lock(hashtext($1))", [`sync:${source}`]);
  try {
    // 1. Removals: soft-deleted / text-free / rating-less reviews that still have a point.
    const gone = await client.query<{ id: string; source_review_id: string }>(
      `SELECT r.id, r.source_review_id FROM reviews r
       WHERE r.source = $1 AND r.indexed_text_hash IS NOT NULL AND ${NOT_INDEXABLE_SQL}`,
      [source],
    );
    for (let i = 0; i < gone.rows.length; i += BATCH) {
      const batch = gone.rows.slice(i, i + BATCH);
      await index.remove(batch.map((r) => pointIdForReview(source, r.source_review_id)));
      await client.query(
        "UPDATE reviews SET indexed_text_hash = NULL, indexed_payload_hash = NULL WHERE id = ANY($1::bigint[])",
        [batch.map((r) => r.id)],
      );
      report.removed += batch.length;
    }

    // 2. Embed + upsert reviews whose text changed (or were never indexed), and
    //    refresh the payload of those whose metadata changed.
    const { rows } = await client.query<DbIndexRow>(INDEX_ROWS_SQL, [source]);
    const toEmbed: Array<{ row: DbIndexRow; payloadHash: string }> = [];
    const toRefresh: Array<{ row: DbIndexRow; payloadHash: string }> = [];
    for (const row of rows) {
      const payloadHash = hashPayload(buildPayload(row));
      if (row.indexed_text_hash !== row.text_hash) toEmbed.push({ row, payloadHash });
      else if (row.indexed_payload_hash !== payloadHash) toRefresh.push({ row, payloadHash });
    }

    for (let i = 0; i < toEmbed.length; i += BATCH) {
      const batch = toEmbed.slice(i, i + BATCH);
      const vectors = await embed(batch.map((b) => b.row.text));
      await index.upsert(
        batch.map((b, j) => ({
          id: pointIdForReview(source, b.row.source_review_id),
          vector: vectors[j],
          payload: buildPayload(b.row),
        })),
      );
      await markIndexed(client, batch);
      report.embedded += batch.length;
    }

    for (let i = 0; i < toRefresh.length; i += BATCH) {
      const batch = toRefresh.slice(i, i + BATCH);
      await index.setPayload(
        batch.map((b) => ({
          id: pointIdForReview(source, b.row.source_review_id),
          payload: buildPayload(b.row),
        })),
      );
      await markIndexed(client, batch);
      report.payloadRefreshed += batch.length;
    }
    return report;
  } finally {
    await client.query("SELECT pg_advisory_unlock(hashtext($1))", [`sync:${source}`]);
  }
}

/** Record what was sent (not what the row says now). */
async function markIndexed(
  client: Client,
  batch: Array<{ row: DbIndexRow; payloadHash: string }>,
) {
  for (const { row, payloadHash } of batch) {
    await client.query(
      "UPDATE reviews SET indexed_text_hash = $2, indexed_payload_hash = $3 WHERE id = $1",
      [row.id, row.text_hash, payloadHash],
    );
  }
}
