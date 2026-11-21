-- A review whose model tags fail validation is flagged, never dropped
-- (docs/trends-campaigns-plan.md decision 2). Its review_tagging row says so and holds
-- no themes, so coverage can show it beside every count instead of the review
-- silently disappearing.

ALTER TABLE review_tagging
  ADD COLUMN status text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'failed_validation')),
  ADD COLUMN error  text,
  ADD CONSTRAINT review_tagging_error_iff_failed
    CHECK ((status = 'failed_validation') = (error IS NOT NULL AND btrim(error) <> ''));

-- A flagged review has no themes.
CREATE FUNCTION review_themes_not_flagged() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM review_tagging
             WHERE review_id = NEW.review_id AND tag_set_id = NEW.tag_set_id AND status <> 'ok') THEN
    RAISE EXCEPTION 'review % is flagged in tag set %, so it has no themes', NEW.review_id, NEW.tag_set_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_themes_not_flagged
  BEFORE INSERT OR UPDATE ON review_themes
  FOR EACH ROW EXECUTE FUNCTION review_themes_not_flagged();

CREATE OR REPLACE VIEW current_review_themes AS
SELECT r.id AS review_id,
       r.property_id,
       r.created_at,
       r.rating,
       rt.tag_set_id,
       t.slug AS theme,
       th.sentiment
FROM reviews r
JOIN review_tagging rt ON rt.review_id = r.id AND NOT rt.stale AND rt.status = 'ok'
JOIN review_themes th ON th.review_id = rt.review_id AND th.tag_set_id = rt.tag_set_id
JOIN themes t ON t.id = th.theme_id
WHERE r.deleted_at IS NULL AND r.has_text;
