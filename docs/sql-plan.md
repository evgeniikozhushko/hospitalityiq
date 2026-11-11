# Postgres foundation for review counts

Status: built (local foundation). Last updated 2026-11-09. Section "As built" lists where the build differs from the plan.

## Why

The app stores review text and metadata in Qdrant and retrieves a limited set of relevant reviews. That works for "What did guests say about parking?" but cannot reliably answer "How many reviews mentioned parking?" from the few reviews it retrieved.

Postgres gives a structured place for all reviews and their theme tags, so SQL can count and compare periods (project-scope principle: counting questions use exact database counts, not AI estimates). Qdrant keeps finding relevant examples and quotations.

## Scope

In: local Postgres, plain SQL migrations, review and theme-tag storage, manual theme tagging, fixed SQL statistics, Postgres/Qdrant reconciliation and repair, a synthetic seed and a stats CLI.

Deferred: AI theme tagging, routing natural-language questions to SQL, CSV ingestion, hosted deployment.

This work proves the mechanics, not real-world quality. Tagging accuracy is established only by a future, independently hand-labelled set of real reviews (see Test data).

## Decisions

- Local Postgres via Docker Compose. Hosting is decided later, when the pilot's IT and budget requirements are known. Connections are configurable.
- Plain SQL migrations, no ORM. SQL stays visible while learning, and an ORM can wait until it is needed.
- Statistics use fixed, parameterized SQL templates. The planner supplies filters (`QueryFilters`) but never generates SQL.
- Two connections: a read-only role for statistics queries, an admin/migrator role for migrations and imports. Env vars: `DATABASE_URL_READONLY`, `DATABASE_URL_ADMIN`, plus `DATABASE_URL_TEST` for tests. Do not use plain `DATABASE_URL`, which hosts commonly set to owner credentials.
- Role creation is environment setup, not a migration: `db/setup/roles.sql`, run with psql variables, no passwords in the repo.
- Reviewer identity is never stored (name, photo, anonymity flag).

## Schema (first migration)

- `properties(id, location_id UNIQUE, name, type, timezone)`. Timezone is used for local-date windows. `name` is the canonical name used for filter matching.
- `imports(id, source, property_id, is_complete_snapshot, status, started_at, finished_at)`. `status` is running, succeeded or failed.
- `reviews(id, source, source_review_id, property_id, rating, text NULL, has_text, owner_reply, created_at timestamptz, text_hash, payload_hash, indexed_text_hash NULL, indexed_payload_hash NULL, first_seen_at, last_import_id, deleted_at NULL)`.
  - `UNIQUE(source, source_review_id)`.
  - Rating-only reviews are kept (they belong in the total). They cannot be text-tagged and are not indexed in Qdrant.
  - Month is derived at query time, not stored.
- `themes(id, slug UNIQUE, label)`. Provisional list: housekeeping, rooms, front desk, food, spa, parking, value, other. To be validated with marketing. `other` is for mentions that fit no listed theme; it is not a marker for "no themes" (see `review_tagging`).
- `review_tagging(review_id, tag_source, taxonomy_version, tagged_at, stale)`, `PRIMARY KEY(review_id, tag_source, taxonomy_version)`.
  - One row means "this set of tags for this review was completed", even when the set has zero themes. This separates "reviewed, no applicable themes" from "not yet reviewed".
  - `tag_source`: manual or llm. `stale`: the text changed since the set was completed.
  - Only text reviews get tagging rows.
- `review_themes(review_id, tag_source, taxonomy_version, theme_id, sentiment)`, foreign key to `review_tagging` with `ON DELETE CASCADE`, `UNIQUE(review_id, tag_source, taxonomy_version, theme_id, sentiment)`.
  - `sentiment`: positive, negative, neutral. A review may carry both positive and negative for the same theme (praise and complaint in one review).
  - Neutral (a mention with no polarity) cannot coexist with positive or negative for the same review, theme, tag source and taxonomy version.
- Writer rule: a tag set is always replaced as a whole, atomically, in one transaction that locks the review row (`SELECT … FOR UPDATE`). The writer validates the neutral rule before commit. A check constraint cannot span rows, so this is enforced in code and tested.
- View `current_review_themes`: joins non-deleted text reviews to a non-stale `review_tagging` row and its `review_themes`. It exposes `tag_source` and `taxonomy_version` so templates must filter on both.
- Deferred until a real need: property aliases table, parent properties, theme applicability per property type, evidence quotes, tagger version history.

### Counting rules

- "Mentions" = `COUNT(DISTINCT review_id)`. Never count tag rows.
- "Complaints" = the same with `sentiment = 'negative'`.
- Every query selects exactly one `tag_source` and one `taxonomy_version`, passed explicitly with no defaults. Sources and versions are never combined silently.
- Exclude `other` from top-N theme rankings.
- Every result returns coverage next to the count, so untagged never reads as "no mention":
  - total reviews in the window
  - reviews with text (rating-only reviews can't be tagged)
  - text reviews with current tags
  - text reviews that are stale
  - text reviews not yet tagged
  Rating-only reviews are in the first number only and never count as untagged.

## Migrations

`scripts/migrate.ts` (`npm run db:migrate`): applies `db/migrations/*.sql` in filename order, one transaction each, records filename and checksum in `schema_migrations`, errors if an applied file changed, holds an advisory lock while running. Uses `pg`.

## Ingest (dual write)

1. Take an advisory lock per source and property, so imports and syncs for the same scope cannot overlap.
2. Per property, in one transaction: upsert the property, upsert all reviews on `(source, source_review_id)`, record the import. Postgres is written before Qdrant.
3. When text changes: llm `review_tagging` rows for that review are deleted (their theme rows cascade); manual rows are kept and set `stale = true`. Stale tags are excluded from statistics until revalidated.
4. Qdrant sync is driven by two hashes:
   - `text_hash` vs `indexed_text_hash`: re-embed only when text changed.
   - `payload_hash` vs `indexed_payload_hash`: refresh the payload (`set_payload`, no re-embedding) when rating, property name, timezone, etc. change.
   - After a successful Qdrant write, set the indexed hashes with a conditional update (`WHERE id = $1 AND text_hash = $sent AND payload_hash = $sent`). If the review changed meanwhile, the indexed hashes stay behind and the next sync picks it up. A failed Qdrant write leaves them unset, so it is retried.
5. Pending Qdrant removal is derived from the row, not a separate queue: `indexed_text_hash IS NOT NULL` while the review is soft-deleted or no longer has text. Removing the point clears the hashes.
6. Adopting the existing Qdrant points: the current fixture points have no `textHash` in their payload and Postgres starts with no indexed hashes. The first dual-write import therefore treats every review as needing sync, re-embeds and upserts under the existing point IDs (`pointIdFor(reviewId)`), and records the hashes after success. Reconciliation then has a known starting state.
7. Point IDs: keep the existing Google mapping so current search and evals keep working; namespace IDs by source for future sources. Widen `ReviewRecordSchema.source` (currently a literal) when a second source arrives.
8. Reconcile runs automatically at the end of ingest.

### Snapshots and deletion

- Soft-delete of reviews missing from an import happens only when the importer declares a complete snapshot for that source and property (API: every page fetched without error; CSV: explicit flag). Partial exports, including the fixtures by default, delete nothing.
- A complete snapshot becomes eligible only after its entire input validates and every page or record is accounted for. On any validation or ingestion failure the import is marked `failed` and no missing-review deletion runs. Missing reviews are identified by "not seen in this import", so deletion must never run for an import that did not succeed.
- Default is a dry-run preview, reported per property and source. `--apply` performs the deletion.
- A reappearing review clears `deleted_at` and is re-indexed.

## Reconciliation and repair

`scripts/reconcile.ts` (`npm run reconcile`): compares the set of active text-review IDs in Postgres with the set in Qdrant (keyed by the point-ID function over `(source, source_review_id)`), plus text-hash equality. Reports only-in-Postgres (missing), only-in-Qdrant (extra) and mismatched points; exits non-zero on any difference. Equal counts are not enough: different ID sets can have the same count. Scoped by source so synthetic data cannot trip it.

Indexed hashes in Postgres record what was last sent successfully; they do not prove the point still exists (the Qdrant volume can be lost or changed independently). Repair:

- `npm run reindex` rebuilds Qdrant from Postgres, which stores the text and owner reply.
  - It clears the indexed hashes only for active text reviews, so they re-embed and upsert.
  - It never clears hashes on soft-deleted or text-free reviews. Those hashes are the signal that the point still needs removal, and reindex performs that removal.
  - It also deletes "extra" Qdrant points: points that are not in Postgres' active set. Deletion is limited to the configured collection (`QDRANT_COLLECTION`) and to the source being repaired, selected by the point's `source` payload field. Points belonging to another source, or with no recognizable `source`, are reported but never deleted, so a repair cannot remove another source's data. Repairing a source requires naming it (`--source`).
- Reindex ends with reconcile and must exit clean.

## Statistics templates

`lib/reviewStats.ts`: fixed parameterized queries for theme mentions, negative complaints, and current vs previous period. Inputs come from `QueryFilters`, with these rules for this slice:

- Property names: exact canonical-name match against `properties.name` (the same case-insensitive canonicalization `sanitizePlan` uses). An unknown name is an error that lists the known names. SQL never drops it and never broadens to all properties. This deliberately differs from the Qdrant path, where `sanitizePlan` drops unknown names with a notice and `propertyOnly` retries with relaxed filters.
- Company aliases: a recognized alias (`COMPANY_ALIASES` in `lib/filters.ts`, for example BCP) is explicitly interpreted as all properties, applied only when no specific property remains, and the result is labelled with the alias. An alias combined with an unknown name is still an error.
- Other filters combine with AND, as in `buildFilter`: `propertyTypes`, rating range, `months`, and `since`/`until`. `months` is supported for plain counts and combines with `since`/`until`. Comparisons require a contiguous date window; a `months` filter (for example "winter") in a comparison is rejected with a clear message.
- Windows are local dates in the property's timezone, half-open `[start, end + 1 day)` (`until` in `QueryFilters` is inclusive). Compute boundaries with `AT TIME ZONE`, not by adding 24-hour intervals (daylight saving). Previous period = the immediately preceding window of equal length.
- Known mismatch: Qdrant's `month` field is UTC, SQL windows are local. A cited quote near a month boundary may fall outside the counted window. Documented until retrieval is aligned in a later change; keep a test fixture that shows it.

## Test data

Two kinds of labelled data, kept separate:

- Synthetic labels verify SQL behaviour only. A larger synthetic seed with hand-computed expected counts, loaded with `source = 'synthetic'` into the test database only. It is never embedded or written to the dev Qdrant, so search and the eval baseline are unaffected. Clearly labelled mechanics-only.
- Evaluation ground truth for tagging accuracy is a future, independently hand-labelled set of real reviews (project scope: 100 reviews hand-tagged by marketing and Evgenii; target >= 85% match), held out from prompt tuning. Fixture and synthetic tags are not a substitute for it.
- Manual tags for fixtures and the seed live in committed files (for example `data/manual-tags.json`, keyed by `(source, source_review_id)`), and a script loads them into Postgres. The file is the source of truth; the Docker volume is disposable. Loading writes a completed `review_tagging` row for every reviewed review, including those with zero themes. Revalidating a stale manual set replaces the whole set and clears `stale` only after the complete set for that review has been reviewed.

### Test database guard

- Integration tests require an explicit `DATABASE_URL_TEST` and run only against a dedicated disposable test instance.
- Refuse to run if it equals the admin or read-only URL, or if the host is not loopback, unless an explicit override variable is set. A database named `hiq_test` on a remote host is not safe. The guard runs before any truncate or insert.

## Tests

- Repeat import: no duplicates. Edited review: updates in place, llm tag set deleted, manual set kept and stale, excluded from stats, coverage shows it as stale.
- Rating-only reviews: in total, not in "with text", never counted as untagged, not indexed.
- Reviewed with zero themes: counted as tagged; "not yet reviewed" counted as untagged.
- Tag source and version: a query requires both; manual and llm rows (or two versions) never combine.
- Mixed sentiment: one review with positive and negative for a theme counts once in mentions and once in complaints. Neutral alongside a polar tag is rejected by the writer. Conflicting concurrent tag-set writes cannot leave both (only needed if more than one writer is allowed).
- Partial import deletes nothing; complete snapshot dry run vs `--apply`; failed or invalid import never deletes; reappearing review restored and re-indexed.
- Failed Qdrant write or removal is retried next run; metadata-only change refreshes the payload without re-embedding; a review edited during a sync is not wrongly marked indexed.
- First import adopts the existing fixture points under their current IDs and records hashes.
- Reconcile catches equal-count/different-ID sets and hash mismatches; reindex rebuilds a wiped Qdrant, removes extra points, and still removes points for soft-deleted reviews. Reindex of one source leaves another source's points, and points with no `source` payload, untouched (reported only).
- Filters: unknown property name errors without broadening; company alias means all properties; `months` combined with `since`/`until`; comparison with `months` rejected.
- Read-only role cannot write. Test-database guard rejects the admin URL and non-loopback hosts.
- Windows: local midnight, equal-length previous period, inclusive `until`, daylight-saving boundary.
- Existing: `npm test`, lint, type check, `npm run eval` unchanged; search and citations still work after importing fixtures.

## CLI

`scripts/stats.ts` in the style of `search` and `ask`: run the templates against the database from the terminal, for learning the SQL and inspecting real data.

## Delivery

Three commits or PRs on a new branch:

1. Docker Compose, env, roles, migration runner, first migration.
2. Ingest dual write, hashes, snapshot handling, reconcile and reindex.
3. Manual tags loader, synthetic seed, statistics templates, CLI, tests, README setup section.

## As built

Differences from the plan above, all deliberate:

- **No stored `payload_hash`.** The payload hash is computed at sync time from the review joined to its property and compared with `indexed_payload_hash`. A property rename or rating change is therefore noticed without keeping a second "current" hash in step. `indexed_*` hashes store what was actually SENT, so an edit made while a sync runs can never be marked as indexed (covered by a test). A per-source advisory lock stops overlapping syncs, in place of a conditional update.
- **Indexable means live, with text, and with a rating.** The Qdrant payload requires a rating, so a review with text but an unspecified rating stays in Postgres only. Reconcile and sync use the same rule (`INDEXABLE_SQL` in `lib/db/payload.ts`).
- **Role setup is a script, not psql variables.** `npm run db:setup` creates the read-only role with the name and password from `DATABASE_URL_READONLY` and runs the static grants in `db/setup/roles.sql`. No passwords live in the repo. It also sets `default_transaction_read_only` on the role.
- **Ports.** Dev Postgres is on 5433 and the disposable test instance (memory only) on 5434, because 5432 is commonly taken by another local Postgres.
- **Complete snapshots.** A complete snapshot with zero reviews is refused (it would delete everything). Each property is its own transaction and its own `imports` row, so one failing property records a failed import and deletes nothing while others still import.
- **Config.** Database URLs are read in `lib/db/config.ts`, not `lib/env.ts`, so database scripts do not need an OpenAI key.
- **Test config.** `vitest.config.mts` turns off file parallelism because database test files share one disposable instance.
- **Timezone.** `properties.timezone` defaults to `America/Edmonton`; there is no ingest field for it yet, so set it with SQL for a property elsewhere.
- **Statistics** return per-property rows plus a total, each with the five coverage numbers, and a trend reports `percent: null` when the previous period had no mentions.
- **Payload refresh replaces, not merges.** A metadata refresh uses Qdrant `overwrite_payload`; `set_payload` merges, so a removed field (e.g. an owner reply) would stay searchable. `npm run reindex` heals any point refreshed before this fix.
- **Legacy points.** Sync also asks Qdrant, by point ID, about reviews that must not be indexed but were never indexed by this pipeline, and removes any point found (an older pipeline may have left one under the same ID). Points with no `source` payload that match no Postgres review are never deleted automatically; reconcile reports them as out of scope.
- **Reindex holds the sync lock.** `reindex` takes the per-source advisory lock for the whole rebuild (clear hashes, sync, remove extras, final reconcile). Otherwise a concurrent import and sync could add a point between reconcile's Postgres read and its Qdrant listing, and reindex would delete it as an "extra" while Postgres still recorded it as indexed. A concurrent ingest simply waits.
- **Conventions for later changes (no code yet).**
  - *Property identity.* `properties.location_id` is unique without a source, which is fine for the Google import. Before a second provider is added, add `property_sources(property_id, source, external_location_id)` with `UNIQUE (source, external_location_id)` (backfill it from `properties`), so one hotel can carry several provider IDs. Until then a second provider's different ID for the same hotel fails loudly on the unique name index instead of creating a silent duplicate.
  - *Theme identity.* Taxonomy versions version tag sets, not theme definitions, so a theme's slug and meaning must stay stable. A label can be edited. If marketing changes what a theme means (split, merge, redefine), add a new slug and a new `taxonomy_version`; never repurpose an existing slug. Versioned definitions are deferred until the first real taxonomy change.
  - *Import tracking.* `last_import_id` is nullable for backfills; the missing-review queries use `IS DISTINCT FROM`, so a row with no import counts as not seen.

## Open questions

- Will the pilot be hosted? Docker-only is fine for development, but a deployed app cannot reach a local database.
- Theme list needs marketing's review.
- Other sources: ingest design waits for the actual CSV format and data-handling requirements (OTA exports may include guest details, so allowlist columns and sanitize).
