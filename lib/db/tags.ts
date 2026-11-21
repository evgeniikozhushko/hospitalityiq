/**
 * Writing tags. A review's tags in one tag set (lib/db/tagSets.ts) are always
 * replaced as a whole, in one transaction that locks the review row. The write
 * records a completed `review_tagging` row even when the set has zero themes, which
 * is how "reviewed, no applicable themes" differs from "not yet reviewed".
 */
import type { Client } from "pg";
import { z } from "zod";

export const Sentiment = z.enum(["positive", "negative", "neutral"]);
export type Sentiment = z.infer<typeof Sentiment>;
export const TagSource = z.enum(["manual", "llm"]);
export type TagSource = z.infer<typeof TagSource>;

/** `evidenceSentence` is required for model tags and absent for hand tags; the database checks both. */
export type TagInput = { theme: string; sentiment: Sentiment; evidenceSentence?: string | null };

export class TagSetError extends Error {}

/**
 * Pure validation: no duplicates (after de-duplication), and neutral cannot sit beside
 * a positive or negative tag for the same theme. Positive + negative may coexist.
 */
export function normalizeTagSet(tags: TagInput[]): TagInput[] {
  const seen = new Set<string>();
  const unique = tags.filter((t) => {
    const key = `${t.theme}|${t.sentiment}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const byTheme = new Map<string, Set<Sentiment>>();
  for (const t of unique) {
    const s = byTheme.get(t.theme) ?? new Set<Sentiment>();
    s.add(t.sentiment);
    byTheme.set(t.theme, s);
  }
  for (const [theme, sentiments] of byTheme) {
    if (sentiments.has("neutral") && sentiments.size > 1) {
      throw new TagSetError(
        `Theme "${theme}": neutral cannot be combined with positive or negative for the same review.`,
      );
    }
  }
  return unique;
}

export type ReplaceTagSetArgs = {
  source: string;
  sourceReviewId: string;
  tagSetId: number;
  tags: TagInput[];
};

/** Replace the complete tag set; clears `stale`. Zero tags is a valid, completed set. */
export async function replaceTagSet(client: Client, args: ReplaceTagSetArgs): Promise<void> {
  const tags = normalizeTagSet(args.tags);

  await client.query("BEGIN");
  try {
    // Locking the review row serializes concurrent writers of the same review.
    const rev = await client.query<{ id: string; has_text: boolean }>(
      "SELECT id, has_text FROM reviews WHERE source = $1 AND source_review_id = $2 FOR UPDATE",
      [args.source, args.sourceReviewId],
    );
    if (rev.rowCount === 0) {
      throw new TagSetError(`Review ${args.source}/${args.sourceReviewId} does not exist.`);
    }
    if (!rev.rows[0].has_text) {
      throw new TagSetError(`Review ${args.sourceReviewId} has no text, so it cannot be tagged.`);
    }
    const reviewId = rev.rows[0].id;

    const slugs = [...new Set(tags.map((t) => t.theme))];
    const themes = await client.query<{ id: string; slug: string }>(
      "SELECT id, slug FROM themes WHERE slug = ANY($1::text[])",
      [slugs],
    );
    const idBySlug = new Map(themes.rows.map((t) => [t.slug, t.id]));
    const unknown = slugs.filter((s) => !idBySlug.has(s));
    if (unknown.length > 0) throw new TagSetError(`Unknown theme(s): ${unknown.join(", ")}.`);

    await client.query(
      "DELETE FROM review_tagging WHERE review_id = $1 AND tag_set_id = $2",
      [reviewId, args.tagSetId],
    );
    await client.query("INSERT INTO review_tagging (review_id, tag_set_id) VALUES ($1, $2)", [
      reviewId,
      args.tagSetId,
    ]);
    for (const t of tags) {
      await client.query(
        `INSERT INTO review_themes (review_id, tag_set_id, theme_id, sentiment, evidence_sentence)
         VALUES ($1, $2, $3, $4, $5)`,
        [reviewId, args.tagSetId, idBySlug.get(t.theme), t.sentiment, t.evidenceSentence ?? null],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}
