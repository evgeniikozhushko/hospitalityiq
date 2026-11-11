-- Review storage and theme tags. See docs/sql-plan.md.
-- No reviewer identity (name, photo, anonymity) is stored anywhere.

CREATE TABLE properties (
  id          bigserial PRIMARY KEY,
  location_id text NOT NULL UNIQUE,
  name        text NOT NULL,            -- canonical name used for filter matching
  type        text NOT NULL CHECK (type IN ('hotel', 'restaurant', 'spa', 'theatre', 'rental')),
  timezone    text NOT NULL DEFAULT 'America/Edmonton'  -- IANA name; windows use local dates
);
CREATE UNIQUE INDEX properties_name_lower_key ON properties (lower(name));

CREATE TABLE imports (
  id                   bigserial PRIMARY KEY,
  source               text NOT NULL,
  property_id          bigint REFERENCES properties (id),
  is_complete_snapshot boolean NOT NULL DEFAULT false,
  status               text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'succeeded', 'failed')),
  started_at           timestamptz NOT NULL DEFAULT now(),
  finished_at          timestamptz
);

CREATE TABLE reviews (
  id                   bigserial PRIMARY KEY,
  source               text NOT NULL,
  source_review_id     text NOT NULL,
  property_id          bigint NOT NULL REFERENCES properties (id),
  rating               smallint CHECK (rating BETWEEN 1 AND 5),
  text                 text,            -- NULL for rating-only reviews
  has_text             boolean GENERATED ALWAYS AS (text IS NOT NULL AND text <> '') STORED,
  owner_reply          text,
  created_at           timestamptz NOT NULL,
  text_hash            text NOT NULL,   -- sha256 of the text; drives re-embedding
  -- What was actually sent to Qdrant, set only after a successful write. The payload
  -- hash is computed at sync time from the review + its property, so a property
  -- rename or rating change is noticed without a stored "current" payload hash.
  indexed_text_hash    text,
  indexed_payload_hash text,
  first_seen_at        timestamptz NOT NULL DEFAULT now(),
  last_import_id       bigint REFERENCES imports (id),
  deleted_at           timestamptz,
  UNIQUE (source, source_review_id)
);
CREATE INDEX reviews_property_created_idx ON reviews (property_id, created_at) WHERE deleted_at IS NULL;

CREATE TABLE themes (
  id    bigserial PRIMARY KEY,
  slug  text NOT NULL UNIQUE,
  label text NOT NULL
);

-- One row = "this tag set for this review was completed", even with zero themes.
-- That separates "reviewed, no applicable themes" from "not yet reviewed".
CREATE TABLE review_tagging (
  review_id        bigint NOT NULL REFERENCES reviews (id) ON DELETE CASCADE,
  tag_source       text NOT NULL CHECK (tag_source IN ('manual', 'llm')),
  taxonomy_version text NOT NULL,
  tagged_at        timestamptz NOT NULL DEFAULT now(),
  stale            boolean NOT NULL DEFAULT false,  -- text changed since completion
  PRIMARY KEY (review_id, tag_source, taxonomy_version)
);

CREATE TABLE review_themes (
  review_id        bigint NOT NULL,
  tag_source       text NOT NULL,
  taxonomy_version text NOT NULL,
  theme_id         bigint NOT NULL REFERENCES themes (id),
  sentiment        text NOT NULL CHECK (sentiment IN ('positive', 'negative', 'neutral')),
  PRIMARY KEY (review_id, tag_source, taxonomy_version, theme_id, sentiment),
  FOREIGN KEY (review_id, tag_source, taxonomy_version)
    REFERENCES review_tagging (review_id, tag_source, taxonomy_version) ON DELETE CASCADE
);
-- Positive and negative may coexist for a theme; neutral may not coexist with either.
-- A check constraint cannot span rows, so the writer enforces it (see docs/sql-plan.md).

-- Statistics read this view: non-deleted text reviews with completed, non-stale tags.
-- Callers must filter on tag_source AND taxonomy_version.
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
