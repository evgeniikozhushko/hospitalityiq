/**
 * Postgres side of ingestion: properties and reviews are upserted per property in
 * one transaction, tied to an `imports` row. Reviewer identity is never read.
 *
 * Missing-review soft-deletion happens only for a declared complete snapshot of a
 * property, only when the import succeeded, and only with `apply` (default is a
 * preview). See docs/sql-plan.md.
 */
import type { Client } from "pg";
import { GOOGLE_SOURCE } from "../pointId";
import { sanitize } from "../sanitize";
import { ratingToNumber, type LocationReviews } from "../schema";
import { hashText } from "./payload";

export type ImportOptions = {
  source?: string;
  /** The importer vouches that this file lists every review of each property it contains. */
  completeSnapshot?: boolean;
  /** Perform the deletions of a complete snapshot (otherwise only report them). */
  apply?: boolean;
};

export type PropertyImportResult = {
  locationId: string;
  propertyName: string;
  importId: number | null;
  status: "succeeded" | "failed";
  error?: string;
  inserted: number;
  updated: number;
  unchanged: number;
  textChanged: number;
  restored: number;
  /** Live reviews of this property/source absent from a complete snapshot. */
  missing: string[];
  deleted: number;
};

type Prepared = {
  sourceReviewId: string;
  rating: number | null;
  text: string | null;
  ownerReply: string | null;
  createdAt: string;
};

function prepare(loc: LocationReviews): Prepared[] {
  // Note: r.reviewer is deliberately never read.
  return loc.reviews.map((r) => ({
    sourceReviewId: r.reviewId,
    rating: ratingToNumber(r.starRating),
    text: r.comment ? sanitize(r.comment) || null : null,
    ownerReply: r.reviewReply?.comment ? sanitize(r.reviewReply.comment) || null : null,
    createdAt: r.createTime,
  }));
}

export async function importLocations(
  client: Client,
  locations: LocationReviews[],
  opts: ImportOptions = {},
): Promise<PropertyImportResult[]> {
  const source = opts.source ?? GOOGLE_SOURCE;
  const results: PropertyImportResult[] = [];
  for (const loc of locations) {
    results.push(await importProperty(client, loc, source, opts));
  }
  return results;
}

async function importProperty(
  client: Client,
  loc: LocationReviews,
  source: string,
  opts: ImportOptions,
): Promise<PropertyImportResult> {
  const result: PropertyImportResult = {
    locationId: loc.locationId,
    propertyName: loc.propertyName,
    importId: null,
    status: "failed",
    inserted: 0,
    updated: 0,
    unchanged: 0,
    textChanged: 0,
    restored: 0,
    missing: [],
    deleted: 0,
  };
  const complete = opts.completeSnapshot === true;
  const reviews = prepare(loc);

  await client.query("BEGIN");
  try {
    if (complete && reviews.length === 0) {
      throw new Error("Refusing a complete snapshot with zero reviews: it would delete everything.");
    }
    // One import per source + property at a time.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`import:${source}:${loc.locationId}`]);

    const prop = await client.query<{ id: string }>(
      `INSERT INTO properties (location_id, name, type) VALUES ($1, $2, $3)
       ON CONFLICT (location_id) DO UPDATE SET name = EXCLUDED.name, type = EXCLUDED.type
       RETURNING id`,
      [loc.locationId, loc.propertyName, loc.propertyType],
    );
    const propertyId = prop.rows[0].id;

    const imp = await client.query<{ id: string }>(
      `INSERT INTO imports (source, property_id, is_complete_snapshot) VALUES ($1, $2, $3) RETURNING id`,
      [source, propertyId, complete],
    );
    const importId = Number(imp.rows[0].id);
    result.importId = importId;

    for (const r of reviews) {
      const textHash = hashText(r.text);
      const prev = await client.query(
        `SELECT id, property_id, rating, text, owner_reply, created_at, text_hash, deleted_at
         FROM reviews WHERE source = $1 AND source_review_id = $2 FOR UPDATE`,
        [source, r.sourceReviewId],
      );
      if (prev.rowCount === 0) {
        await client.query(
          `INSERT INTO reviews (source, source_review_id, property_id, rating, text, owner_reply,
                                created_at, text_hash, last_import_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [source, r.sourceReviewId, propertyId, r.rating, r.text, r.ownerReply, r.createdAt, textHash, importId],
        );
        result.inserted++;
        continue;
      }
      const old = prev.rows[0];
      const textChanged = old.text_hash !== textHash;
      const restored = old.deleted_at !== null;
      const same =
        !textChanged &&
        !restored &&
        String(old.property_id) === String(propertyId) &&
        old.rating === r.rating &&
        (old.owner_reply ?? null) === r.ownerReply &&
        new Date(old.created_at).getTime() === new Date(r.createdAt).getTime();

      await client.query(
        `UPDATE reviews SET property_id = $2, rating = $3, text = $4, owner_reply = $5, created_at = $6,
                text_hash = $7, last_import_id = $8, deleted_at = NULL
         WHERE id = $1`,
        [old.id, propertyId, r.rating, r.text, r.ownerReply, r.createdAt, textHash, importId],
      );
      if (textChanged) {
        // The old tags describe old text: drop LLM tags, keep manual ones but mark them stale.
        await client.query("DELETE FROM review_tagging WHERE review_id = $1 AND tag_source = 'llm'", [old.id]);
        await client.query("UPDATE review_tagging SET stale = true WHERE review_id = $1", [old.id]);
        result.textChanged++;
      }
      if (restored) result.restored++;
      if (same) result.unchanged++;
      else result.updated++;
    }

    if (complete) {
      const missing = await client.query<{ source_review_id: string }>(
        `SELECT source_review_id FROM reviews
         WHERE source = $1 AND property_id = $2 AND deleted_at IS NULL AND last_import_id <> $3
         ORDER BY source_review_id`,
        [source, propertyId, importId],
      );
      result.missing = missing.rows.map((m) => m.source_review_id);
      if (opts.apply && result.missing.length > 0) {
        const del = await client.query(
          `UPDATE reviews SET deleted_at = now()
           WHERE source = $1 AND property_id = $2 AND deleted_at IS NULL AND last_import_id <> $3`,
          [source, propertyId, importId],
        );
        result.deleted = del.rowCount ?? 0;
      }
    }

    await client.query("UPDATE imports SET status = 'succeeded', finished_at = now() WHERE id = $1", [importId]);
    await client.query("COMMIT");
    result.status = "succeeded";
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    result.status = "failed";
    result.error = (err as Error).message;
    result.importId = null;
    result.inserted = result.updated = result.unchanged = result.textChanged = result.restored = 0;
    result.missing = [];
    result.deleted = 0;
    // Record the failure outside the rolled-back transaction. No deletion ran.
    await client.query(
      `INSERT INTO imports (source, property_id, is_complete_snapshot, status, finished_at)
       VALUES ($1, (SELECT id FROM properties WHERE location_id = $2), $3, 'failed', now())`,
      [source, loc.locationId, complete],
    );
    return result;
  }
}
