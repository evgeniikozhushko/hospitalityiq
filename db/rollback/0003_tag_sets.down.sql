-- Reverses db/migrations/0003_tag_sets.sql. The migration runner only goes forward,
-- so this is run by hand, in one transaction, by the schema owner:
--
--   node --env-file=.env.local --import tsx scripts/rollback.ts 0003_tag_sets
--
-- Hand tags survive: each manual tag set goes back to (tag_source, taxonomy_version).
-- Model tag sets cannot be expressed in the old schema (it has no model or prompt
-- columns), so this refuses to run while any exist. Delete them first, knowing their
-- tags and gate results are lost. Evidence sentences are lost by design.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM tag_sets WHERE tag_source = 'llm') THEN
    RAISE EXCEPTION 'model tag sets exist; delete them (and their tags) before rolling back 0003';
  END IF;
END $$;

DROP VIEW current_review_themes;
DROP TRIGGER review_themes_check_evidence ON review_themes;
DROP FUNCTION review_themes_check_evidence();

ALTER TABLE review_tagging ADD COLUMN tag_source text, ADD COLUMN taxonomy_version text;
UPDATE review_tagging rt SET tag_source = ts.tag_source, taxonomy_version = ts.taxonomy_version
FROM tag_sets ts WHERE ts.id = rt.tag_set_id;
ALTER TABLE review_tagging
  ALTER COLUMN tag_source SET NOT NULL,
  ALTER COLUMN taxonomy_version SET NOT NULL,
  ADD CHECK (tag_source IN ('manual', 'llm'));

ALTER TABLE review_themes ADD COLUMN tag_source text, ADD COLUMN taxonomy_version text;
UPDATE review_themes th SET tag_source = ts.tag_source, taxonomy_version = ts.taxonomy_version
FROM tag_sets ts WHERE ts.id = th.tag_set_id;
ALTER TABLE review_themes
  ALTER COLUMN tag_source SET NOT NULL,
  ALTER COLUMN taxonomy_version SET NOT NULL;

ALTER TABLE review_themes DROP CONSTRAINT review_themes_review_id_tag_set_id_fkey;
ALTER TABLE review_themes DROP CONSTRAINT review_themes_pkey;
ALTER TABLE review_tagging DROP CONSTRAINT review_tagging_pkey;
ALTER TABLE review_themes DROP COLUMN tag_set_id, DROP COLUMN evidence_sentence;
ALTER TABLE review_tagging DROP COLUMN tag_set_id;

ALTER TABLE review_tagging ADD PRIMARY KEY (review_id, tag_source, taxonomy_version);
ALTER TABLE review_themes ADD PRIMARY KEY (review_id, tag_source, taxonomy_version, theme_id, sentiment);
ALTER TABLE review_themes ADD FOREIGN KEY (review_id, tag_source, taxonomy_version)
  REFERENCES review_tagging (review_id, tag_source, taxonomy_version) ON DELETE CASCADE;

DROP TRIGGER active_tag_set_requires_gate ON active_tag_set;
DROP TRIGGER active_tag_set_no_delete ON active_tag_set;
DROP TABLE active_tag_set;
DROP TRIGGER tag_sets_guard_update ON tag_sets;
DROP TABLE tag_sets;
DROP FUNCTION active_tag_set_requires_gate();
DROP FUNCTION active_tag_set_no_delete();
DROP FUNCTION tag_sets_guard_update();

CREATE VIEW current_review_themes AS
SELECT r.id AS review_id,
       r.property_id,
       r.created_at,
       r.rating,
       rt.tag_source,
       rt.taxonomy_version,
       t.slug AS theme,
       th.sentiment
FROM reviews r
JOIN review_tagging rt ON rt.review_id = r.id AND NOT rt.stale
JOIN review_themes th ON th.review_id = rt.review_id
                     AND th.tag_source = rt.tag_source
                     AND th.taxonomy_version = rt.taxonomy_version
JOIN themes t ON t.id = th.theme_id
WHERE r.deleted_at IS NULL AND r.has_text;

DELETE FROM schema_migrations WHERE filename = '0003_tag_sets.sql';
