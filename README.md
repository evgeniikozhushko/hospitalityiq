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

- **Ingest path:** sources (Google reviews, CSV exports, campaign records) → light sanitizing → OpenAI theme tagging validated by Zod → Postgres (records, tags) + Qdrant (embeddings).
- **Question path:** a router picks SQL on Postgres for counts and trends, or hybrid search on Qdrant for "what did guests say". Answers are written with a citation for every claim and streamed to the chat. LangSmith traces each step.

Details: [section 5 of the project scope](docs/project-scope.md#5-architecture).

## Tech stack

Next.js, TypeScript, OpenAI API, Qdrant, Postgres, Zod, LangSmith. See [section 7](docs/project-scope.md#7-tech-stack).

## Getting started

Prerequisites: Node.js, npm, Docker (for local Qdrant), and an OpenAI API key.

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) to see the app.

Check `lib/env.ts` for the environment variables the app expects.

## Project layout

| Path | Purpose |
|---|---|
| `lib/schema.ts` | Zod schemas for Google Business Profile reviews and the stored review record |
| `lib/sanitize.ts` | Lightweight regex sanitizer (emails, phones, booking refs, card-like numbers) |
| `lib/qdrant.ts`, `lib/openai.ts`, `lib/env.ts` | Clients and config |
| `scripts/ingest.ts` | Load → validate → sanitize → embed → upsert |
| `scripts/search.ts` | Dense-only retrieval from the terminal |
| `data/sample-reviews.json` | Fictional test fixture shaped like the Google API output |
| `evals/dataset.json` | Labelled eval questions (`npm run eval`) |
| `scripts/eval.ts` | Runs the dataset through the real pipeline and scores it |
| `docs/project-scope.md` | Living scope and decisions document |
| `docs/gbp-api-access.md` | Google Business Profile API access checklist |

## Status

Dense-only retrieval, cited answers (`npm run ask`) and an eval harness (`npm run eval`) work. Next up: fixing what the eval baseline found, theme taxonomy, Postgres data model, and hybrid (dense + sparse) search. The full status and roadmap are in [section 12 of the project scope](docs/project-scope.md#12-current-build-status).

## Data protection

Reviewer identity is not stored, and campaign financials stay behind role-based access in Postgres, never in the vector store. See [section 6](docs/project-scope.md#6-data-protection-updated).
