-- Reverses db/migrations/0004_flagged_tagging.sql. Run by hand, in one transaction:
--
--   node --env-file=.env.local --import tsx scripts/rollback.ts 0004_flagged_tagging
--
-- Flagged rows are deleted, so those reviews read as untagged again and the tagger
-- will retry them. Roll this back before 0003.

DELETE FROM review_tagging WHERE status <> 'ok';

CREATE OR REPLACE VIEW current_review_themes AS
SELECT r.id AS review_id,
       r.property_id,
       r.created_at,
       r.rating,
       rt.tag_set_id,
       t.slug AS theme,
       th.sentiment
FROM reviews r
JOIN review_tagging rt ON rt.review_id = r.id AND NOT rt.stale
JOIN review_themes th ON th.review_id = rt.review_id AND th.tag_set_id = rt.tag_set_id
JOIN themes t ON t.id = th.theme_id
WHERE r.deleted_at IS NULL AND r.has_text;

DROP TRIGGER review_themes_not_flagged ON review_themes;
DROP FUNCTION review_themes_not_flagged();
ALTER TABLE review_tagging
  DROP CONSTRAINT review_tagging_error_iff_failed,
  DROP COLUMN status,
  DROP COLUMN error;

DELETE FROM schema_migrations WHERE filename = '0004_flagged_tagging.sql';
