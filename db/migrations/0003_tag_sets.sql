-- Tag sets (docs/trends-campaigns-plan.md decision 2, ADR 0003).
--
-- A tag set is every tag produced by one taxonomy version, prompt version and dated
-- model snapshot, or all hand tags for one taxonomy version. Tag rows were keyed by
-- (tag_source, taxonomy_version); they are now keyed by tag_set_id. Exactly one tag
-- set is active, and counts read only from it. A model's tag set can become active
-- only after it has passed the gate.
--
-- Existing rows become one tag set per (tag_source, taxonomy_version), and manual v1
-- (the previous default) is made active, so every count stays the same.
-- Reverse with db/rollback/0003_tag_sets.down.sql.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM review_tagging WHERE tag_source = 'llm') THEN
    RAISE EXCEPTION 'review_tagging has llm rows with no recorded model or prompt; delete them before migrating';
  END IF;
END $$;

CREATE TABLE tag_sets (
  id               bigserial PRIMARY KEY,
  tag_source       text NOT NULL CHECK (tag_source IN ('manual', 'llm')),
  taxonomy_version text NOT NULL CHECK (btrim(taxonomy_version) <> ''),
  -- A dated snapshot such as gpt-4o-mini-2024-07-18, never an alias that can move.
  model_snapshot   text CHECK (model_snapshot ~ '(\d{4}-\d{2}-\d{2}|\d{8})$'),
  prompt_version   text CHECK (btrim(prompt_version) <> ''),
  gate_passed_at   timestamptz,
  gate_report      jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  -- Model fields are NULL for hand tags and required for model tags. Hand tags are
  -- the gold labels, so they are never gated themselves.
  CONSTRAINT tag_sets_source_fields CHECK (
    (tag_source = 'manual' AND model_snapshot IS NULL AND prompt_version IS NULL
                           AND gate_passed_at IS NULL AND gate_report IS NULL)
    OR (tag_source = 'llm' AND model_snapshot IS NOT NULL AND prompt_version IS NOT NULL)
  ),
  CONSTRAINT tag_sets_gate_has_report CHECK (gate_passed_at IS NULL OR gate_report IS NOT NULL),
  CONSTRAINT tag_sets_identity UNIQUE NULLS NOT DISTINCT
    (tag_source, taxonomy_version, model_snapshot, prompt_version)
);

-- Exactly one row: the tag set counts read from.
CREATE TABLE active_tag_set (
  singleton    boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  tag_set_id   bigint NOT NULL REFERENCES tag_sets (id) ON DELETE RESTRICT,
  activated_at timestamptz NOT NULL DEFAULT now()
);

-- A model's tag set can be activated only after it has passed the gate.
CREATE FUNCTION active_tag_set_requires_gate() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ts tag_sets%ROWTYPE;
BEGIN
  SELECT * INTO ts FROM tag_sets WHERE id = NEW.tag_set_id;
  IF ts.tag_source = 'llm' AND ts.gate_passed_at IS NULL THEN
    RAISE EXCEPTION 'tag set % has not passed the gate, so it cannot be active', NEW.tag_set_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER active_tag_set_requires_gate
  BEFORE INSERT OR UPDATE ON active_tag_set
  FOR EACH ROW EXECUTE FUNCTION active_tag_set_requires_gate();

-- Counts must always have a set to read from: switch to another set, never remove the row.
CREATE FUNCTION active_tag_set_no_delete() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the active tag set cannot be removed; activate another tag set instead'
    USING ERRCODE = 'check_violation';
END $$;
CREATE TRIGGER active_tag_set_no_delete
  BEFORE DELETE ON active_tag_set
  FOR EACH ROW EXECUTE FUNCTION active_tag_set_no_delete();

-- A tag set's identity never changes, and the active set cannot lose its gate pass:
-- clearing it would leave counts reading from an ungated set.
CREATE FUNCTION tag_sets_guard_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tag_source, NEW.taxonomy_version, NEW.model_snapshot, NEW.prompt_version)
     IS DISTINCT FROM (OLD.tag_source, OLD.taxonomy_version, OLD.model_snapshot, OLD.prompt_version) THEN
    RAISE EXCEPTION 'tag set % identity cannot change; create a new tag set', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.tag_source = 'llm' AND NEW.gate_passed_at IS NULL AND OLD.gate_passed_at IS NOT NULL
     AND EXISTS (SELECT 1 FROM active_tag_set WHERE tag_set_id = OLD.id) THEN
    RAISE EXCEPTION 'tag set % is active, so its gate pass cannot be cleared; activate another tag set first', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tag_sets_guard_update
  BEFORE UPDATE ON tag_sets
  FOR EACH ROW EXECUTE FUNCTION tag_sets_guard_update();

INSERT INTO tag_sets (tag_source, taxonomy_version)
SELECT DISTINCT tag_source, taxonomy_version FROM review_tagging
UNION
SELECT 'manual', 'v1';

INSERT INTO active_tag_set (tag_set_id)
SELECT id FROM tag_sets WHERE tag_source = 'manual' AND taxonomy_version = 'v1';

-- Re-key the tag rows by tag set.
DROP VIEW current_review_themes;

ALTER TABLE review_tagging ADD COLUMN tag_set_id bigint REFERENCES tag_sets (id);
UPDATE review_tagging rt SET tag_set_id = ts.id
FROM tag_sets ts
WHERE ts.tag_source = rt.tag_source AND ts.taxonomy_version = rt.taxonomy_version;
ALTER TABLE review_tagging ALTER COLUMN tag_set_id SET NOT NULL;

ALTER TABLE review_themes ADD COLUMN tag_set_id bigint;
UPDATE review_themes th SET tag_set_id = ts.id
FROM tag_sets ts
WHERE ts.tag_source = th.tag_source AND ts.taxonomy_version = th.taxonomy_version;
ALTER TABLE review_themes ALTER COLUMN tag_set_id SET NOT NULL;

ALTER TABLE review_themes DROP CONSTRAINT review_themes_review_id_tag_source_taxonomy_version_fkey;
ALTER TABLE review_themes DROP CONSTRAINT review_themes_pkey;
ALTER TABLE review_tagging DROP CONSTRAINT review_tagging_pkey;

ALTER TABLE review_tagging DROP COLUMN tag_source, DROP COLUMN taxonomy_version;
ALTER TABLE review_tagging ADD PRIMARY KEY (review_id, tag_set_id);

ALTER TABLE review_themes DROP COLUMN tag_source, DROP COLUMN taxonomy_version;
ALTER TABLE review_themes ADD PRIMARY KEY (review_id, tag_set_id, theme_id, sentiment);
ALTER TABLE review_themes ADD FOREIGN KEY (review_id, tag_set_id)
  REFERENCES review_tagging (review_id, tag_set_id) ON DELETE CASCADE;

-- The sentence a model tag was given for. Hand tags have none.
ALTER TABLE review_themes ADD COLUMN evidence_sentence text;

-- A model tag must quote its sentence word for word from the stored (sanitized) text,
-- because that text is what gets shown as the quote. A hand tag must not have one.
CREATE FUNCTION review_themes_check_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE src text; txt text;
BEGIN
  SELECT ts.tag_source INTO src FROM tag_sets ts WHERE ts.id = NEW.tag_set_id;
  IF src = 'manual' THEN
    IF NEW.evidence_sentence IS NOT NULL THEN
      RAISE EXCEPTION 'hand tags have no evidence sentence' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.evidence_sentence IS NULL OR btrim(NEW.evidence_sentence) = '' THEN
    RAISE EXCEPTION 'a model tag needs an evidence sentence' USING ERRCODE = 'check_violation';
  END IF;
  SELECT r.text INTO txt FROM reviews r WHERE r.id = NEW.review_id;
  IF txt IS NULL OR strpos(txt, NEW.evidence_sentence) = 0 THEN
    RAISE EXCEPTION 'evidence sentence is not word for word in review %', NEW.review_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER review_themes_check_evidence
  BEFORE INSERT OR UPDATE ON review_themes
  FOR EACH ROW EXECUTE FUNCTION review_themes_check_evidence();

-- Statistics read this view: non-deleted text reviews with completed, non-stale tags.
-- Callers must filter on tag_set_id.
CREATE VIEW current_review_themes AS
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
