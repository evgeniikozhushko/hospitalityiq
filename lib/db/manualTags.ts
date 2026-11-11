/**
 * Loads hand-made tags from a committed JSON file. The file is the source of
 * truth; the database is a disposable copy, so labels survive a wiped Docker volume.
 * Every listed review gets a completed tag set, including `themes: []` for
 * "reviewed, nothing applies".
 */
import { readFile } from "node:fs/promises";
import type { Client } from "pg";
import { z } from "zod";
import { replaceTagSet, Sentiment, TagSetError } from "./tags";

export const ManualTagsFileSchema = z.object({
  source: z.string().min(1),
  taxonomyVersion: z.string().min(1),
  reviews: z.array(
    z.object({
      sourceReviewId: z.string().min(1),
      themes: z.array(z.object({ theme: z.string().min(1), sentiment: Sentiment })),
    }),
  ),
});
export type ManualTagsFile = z.infer<typeof ManualTagsFileSchema>;

export async function loadManualTags(
  client: Client,
  file: ManualTagsFile,
): Promise<{ loaded: number }> {
  // Check every review exists before writing anything, so a typo cannot half-load.
  const ids = file.reviews.map((r) => r.sourceReviewId);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length > 0) throw new TagSetError(`Duplicate review IDs in tag file: ${[...new Set(dup)].join(", ")}`);
  const found = await client.query<{ source_review_id: string }>(
    "SELECT source_review_id FROM reviews WHERE source = $1 AND source_review_id = ANY($2::text[])",
    [file.source, ids],
  );
  const have = new Set(found.rows.map((r) => r.source_review_id));
  const missing = ids.filter((id) => !have.has(id));
  if (missing.length > 0) {
    throw new TagSetError(`Tag file lists reviews not in the database: ${missing.join(", ")}`);
  }
  for (const r of file.reviews) {
    await replaceTagSet(client, {
      source: file.source,
      sourceReviewId: r.sourceReviewId,
      tagSource: "manual",
      taxonomyVersion: file.taxonomyVersion,
      tags: r.themes,
    });
  }
  return { loaded: file.reviews.length };
}

export async function readManualTagsFile(path: string): Promise<ManualTagsFile> {
  return ManualTagsFileSchema.parse(JSON.parse(await readFile(path, "utf8")));
}
