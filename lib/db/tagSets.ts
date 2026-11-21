/**
 * Tag sets (ADR 0003). A tag set is identified by tag source, taxonomy version, prompt
 * version and dated model snapshot. Exactly one is active, and counts read only from
 * it. The database refuses to activate a model's tag set that has not passed the gate
 * (db/migrations/0003_tag_sets.sql); `activateTagSet` checks first so the error is clear.
 */
import type { Client } from "pg";
import type { TagSource } from "./tags";

type Db = Pick<Client, "query">;

export type TagSet = {
  id: number;
  tagSource: TagSource;
  taxonomyVersion: string;
  modelSnapshot: string | null;
  promptVersion: string | null;
  gatePassedAt: Date | null;
};

export type TagSetIdentity =
  | { tagSource: "manual"; taxonomyVersion: string }
  | { tagSource: "llm"; taxonomyVersion: string; modelSnapshot: string; promptVersion: string };

export class TagSetNotFoundError extends Error {}
export class GateNotPassedError extends Error {}

type Row = {
  id: string;
  tag_source: TagSource;
  taxonomy_version: string;
  model_snapshot: string | null;
  prompt_version: string | null;
  gate_passed_at: Date | null;
};

const columns = (prefix = "") =>
  ["id", "tag_source", "taxonomy_version", "model_snapshot", "prompt_version", "gate_passed_at"]
    .map((c) => prefix + c)
    .join(", ");

const toTagSet = (r: Row): TagSet => ({
  id: Number(r.id),
  tagSource: r.tag_source,
  taxonomyVersion: r.taxonomy_version,
  modelSnapshot: r.model_snapshot,
  promptVersion: r.prompt_version,
  gatePassedAt: r.gate_passed_at,
});

/** The tag set counts read from. Every migrated database has one. */
export async function getActiveTagSet(db: Db): Promise<TagSet> {
  const { rows } = await db.query<Row>(
    `SELECT ${columns("ts.")}
     FROM active_tag_set a JOIN tag_sets ts ON ts.id = a.tag_set_id`,
  );
  if (!rows[0]) throw new TagSetNotFoundError("No active tag set. Run the migrations (npm run db:migrate).");
  return toTagSet(rows[0]);
}

export async function getTagSet(db: Db, id: number): Promise<TagSet> {
  const { rows } = await db.query<Row>(`SELECT ${columns()} FROM tag_sets WHERE id = $1`, [id]);
  if (!rows[0]) throw new TagSetNotFoundError(`Tag set ${id} does not exist.`);
  return toTagSet(rows[0]);
}

/** A named set, or the active one when `id` is omitted. */
export async function resolveTagSet(db: Db, id?: number | null): Promise<TagSet> {
  return id == null ? getActiveTagSet(db) : getTagSet(db, id);
}

export async function listTagSets(db: Db): Promise<Array<TagSet & { active: boolean }>> {
  const { rows } = await db.query<Row & { active: boolean }>(
    `SELECT ${columns("ts.")}, a.tag_set_id IS NOT NULL AS active
     FROM tag_sets ts LEFT JOIN active_tag_set a ON a.tag_set_id = ts.id
     ORDER BY ts.id`,
  );
  return rows.map((r) => ({ ...toTagSet(r), active: r.active }));
}

/** The id of the tag set with this identity, created if it does not exist yet. */
export async function ensureTagSet(db: Db, identity: TagSetIdentity): Promise<number> {
  const model = identity.tagSource === "llm" ? identity.modelSnapshot : null;
  const prompt = identity.tagSource === "llm" ? identity.promptVersion : null;
  const { rows } = await db.query<{ id: string }>(
    `WITH ins AS (
       INSERT INTO tag_sets (tag_source, taxonomy_version, model_snapshot, prompt_version)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT ON CONSTRAINT tag_sets_identity DO NOTHING
       RETURNING id
     )
     SELECT id FROM ins
     UNION ALL
     SELECT id FROM tag_sets
     WHERE tag_source = $1 AND taxonomy_version = $2
       AND model_snapshot IS NOT DISTINCT FROM $3 AND prompt_version IS NOT DISTINCT FROM $4
     LIMIT 1`,
    [identity.tagSource, identity.taxonomyVersion, model, prompt],
  );
  return Number(rows[0].id);
}

/** Make a tag set the one counts read from. A model's set must have passed the gate. */
export async function activateTagSet(db: Db, id: number): Promise<void> {
  const set = await getTagSet(db, id);
  if (set.tagSource === "llm" && !set.gatePassedAt) {
    throw new GateNotPassedError(`Tag set ${id} has not passed the gate, so it cannot be active.`);
  }
  await db.query("UPDATE active_tag_set SET tag_set_id = $1, activated_at = now()", [id]);
}
