# HospitalityIQ

An internal AI assistant for Banff Caribou Properties that turns guest reviews and campaign history into answers marketers can act on. Every answer shows its sources.

Built as the final project for the Parsity AI Engineering Program, followed by a 12-week pilot with the marketing team.

> **Full scope, architecture, data-protection decisions, evals and decision log:** [`docs/project-scope.md`](docs/project-scope.md)

## What it does

- **Voice of the Guest:** reviews grouped into themes (housekeeping, front desk, food, spa, parking, value…) and tracked over time by property and outlet.
- **Campaign Memory:** ask what worked, what didn't, and why across past campaigns.
- **Campaign brief drafts** (after the pilot): a new brief from guest themes and past wins, every point cited.

See [section 3 of the project scope](docs/project-scope.md#3-capabilities) for the main user flow and example questions.

## Architecture (summary)

What is built today, and what is still planned:

- **Ingest path (built):** Google-shaped review files → light sanitizing → Postgres (reviews, hand-made theme tags) → embeddings in Qdrant, with a reconcile check. **Planned:** the Google Business Profile API and CSV uploads as sources, campaign records, and OpenAI theme tagging validated by Zod (today the only tags are hand tags, so counts cover only hand-tagged reviews).
- **Question path (built):** a router sends counts, rankings and trends to fixed SQL on Postgres, with the numbers written by code, and "what did guests say" to dense search on Qdrant. Retrieval answers cite a review for every claim and are streamed to the chat. **Planned:** hybrid (dense + sparse) search with reranking, example reviews behind each count, sign-in, and one LangSmith trace per question (today each model call is traced on its own, and only when `LANGSMITH_TRACING=true`).

Details: [section 5 of the project scope](docs/project-scope.md#5-architecture).

## Tech stack

Next.js, TypeScript, OpenAI API, Qdrant, Postgres, Zod, LangSmith. See [section 7](docs/project-scope.md#7-tech-stack).

## Getting started

Prerequisites: Node.js, npm, Docker (for local Qdrant), and an OpenAI API key.

```bash
npm install
cp .env.example .env.local         # then set OPENAI_API_KEY
docker start qdrant 2>/dev/null || docker run -d --name qdrant \
  -p 6333:6333 -p 6334:6334 \
  -v "$PWD/qdrant_storage:/qdrant/storage" \
  qdrant/qdrant                    # Qdrant on :6333 (not in docker-compose yet)
```

Then set up Postgres and load the fixtures (next section), and start the app:

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the app. Without Postgres the app still answers from Qdrant, but count questions fall back to a sample with a note.

`.env.example` lists every variable; `lib/env.ts` and `lib/db/config.ts` validate them. Day-to-day commands are in [docs/dev-cheatsheet.md](docs/dev-cheatsheet.md).

### Checks

```bash
npx next typegen && npx tsc --noEmit   # typegen writes the route types a fresh clone lacks
npm run lint
npm test                           # database tests run when DATABASE_URL_TEST is set, and are skipped otherwise
```

The same three run on every pull request (`.github/workflows/ci.yml`), with a disposable Postgres for the database tests. `npm run eval` calls OpenAI, so it is run by hand.

### Local Postgres (review counts)

Postgres holds every review and its theme tags so counts and trends are exact; Qdrant keeps finding quotations. Design: [docs/sql-plan.md](docs/sql-plan.md).

```bash
docker compose up -d --wait        # Postgres on :5433 (dev) and :5434 (disposable, for tests)
# copy the DATABASE_URL_* lines from .env.example into .env.local
npm run db:migrate                 # apply db/migrations (plain SQL, checksummed)
npm run db:setup                   # create the read-only role used by statistics
npm run ingest                     # Postgres first, then Qdrant, then a reconcile check
npm run tags:load                  # hand tags for the fixtures (data/manual-tags.json)
npm run seed:synthetic             # optional: fictional practice data, Postgres only
npm run stats -- mentions --theme parking --source synthetic
npm run stats -- trend --theme parking --since 2026-02-01 --until 2026-02-28 --source synthetic
npm run reconcile                  # do Postgres and Qdrant hold the same reviews?
npm run reindex -- --source=google_business_profile   # rebuild Qdrant from Postgres
```

Integration tests use the disposable instance and are skipped unless `DATABASE_URL_TEST` is set (they refuse non-local or non-`_test` databases). Port 5433 avoids clashing with another local Postgres on 5432.

## Project layout

| Path | Purpose |
|---|---|
| `lib/schema.ts` | Zod schemas for Google Business Profile reviews, the query plan and the route |
| `lib/sanitize.ts` | Lightweight regex sanitizer (emails, phones, booking refs, card-like numbers) |
| `lib/qdrant.ts`, `lib/openai.ts`, `lib/env.ts` | Clients and config |
| `lib/properties.ts` | The property names the planner may filter on (Postgres, with Qdrant as fallback) |
| `scripts/ingest.ts` | Load → validate → sanitize → Postgres → embed → Qdrant → reconcile |
| `db/migrations/`, `db/setup/roles.sql` | Plain-SQL schema and read-only role grants |
| `lib/db/` | Migration runner, import, Qdrant sync, reconcile/reindex, tag writer |
| `lib/reviewStats.ts` | Fixed, parameterized SQL statistics (`npm run stats`) |
| `data/synthetic/`, `data/manual-tags.json` | Practice data and hand tags (mechanics only, not eval ground truth) |
| `scripts/search.ts` | Dense-only retrieval from the terminal |
| `data/sample-reviews.json` | Fictional test fixture shaped like the Google API output |
| `evals/dataset.json` | Labelled eval questions (`npm run eval`) |
| `scripts/eval.ts` | Runs the dataset through the real pipeline and scores it |
| `docs/project-scope.md` | Living scope and decisions document |
| `docs/gbp-api-access.md` | Google Business Profile API access checklist |

## Status

Dense-only retrieval, cited answers (`npm run ask`) and an eval harness (`npm run eval`) work. Count, ranking and trend questions ("how many reviews mention parking?") are answered exactly from the local Postgres statistics, with the numbers written by code; qualitative questions stay on cited retrieval. Next up: AI theme tagging, fixing what the eval found, theme taxonomy, and hybrid (dense + sparse) search. The full status and roadmap are in [section 12 of the project scope](docs/project-scope.md#12-current-build-status).

## Data protection

Reviewer identity is not stored, and campaign financials stay behind role-based access in Postgres, never in the vector store. See [section 6](docs/project-scope.md#6-data-protection-updated).
