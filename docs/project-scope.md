# HospitalityIQ: project scope and decisions

Living reference for the HospitalityIQ build. Consolidates the Project Plan and Pilot proposal (both dated Nov 1, 2026) with decisions made since.

Last updated: Nov 6, 2026 · Evgenii Kozhushko

---

## 1. What it is

An internal AI assistant for Banff Caribou Properties that turns guest reviews and campaign history into answers marketers can act on. Every answer shows its sources.

- **Users:** the marketing team first, then property managers and operations.
- **Program context:** final project for the Parsity AI Engineering Program, then a 12-week pilot at the company.
- **Not in scope:** guest-facing use, writing marketing copy, connecting to the PMS or booking engine.

## 2. The problem

- Reviews are spread across Google, Booking.com, Expedia and surveys for many hotels, restaurants and spas. Nobody can read them all, so decisions rest on a few memorable reviews.
- No trends: hard to answer "which property gets the most housekeeping complaints?" or "are parking complaints going up?"
- Campaign knowledge lives in people's heads, emails and decks, and leaves with them.
- New campaign planning starts from scratch.
- The organization is cautious about where data goes, so the design has to show it clearly.

## 3. Capabilities

| # | Capability | Pilot? |
|---|---|---|
| 1 | **Voice of the Guest:** reviews grouped into themes (housekeeping, front desk, food, spa, parking, value…) and tracked over time by property and outlet | Yes |
| 2 | **Campaign Memory:** campaign records and results; ask what worked, what didn't, and why | Yes |
| 3 | **Campaign brief drafts:** a new brief from guest themes and past wins, every point cited | After the pilot |

**Main user flow:** pick "Banff Caribou Lodge, last 6 months", ask "What are guests complaining about most?" and get the top 5 themes with review counts, the trend against the previous period, and 2–3 quoted reviews per theme, each linked to its source and date.

**Other pilot questions:**
- "Show me only the parking complaints from winter" (follow-up with filters)
- "Which property gets the most housekeeping complaints this quarter?"
- "What do guests say about our spa?"
- "Which winter promotion brought the most direct bookings, and why did it work?"

**Admin flow:** upload a CSV or campaign record; the app reports how many records were processed and tagged.

## 4. Data sources

| Data | Volume | How it's obtained | Refresh | Public? |
|---|---|---|---|---|
| Google reviews | MVP: ~500 from 2–3 properties. Later: all properties, last 24 months | Google Business Profile API (**access requested**, pending). CSV export until approved | Daily once approved; weekly CSV until then | Yes |
| OTA reviews (Booking.com, Expedia) | Several hundred per property per year (to confirm) | Extranet CSV exports, or the reputation tool's export | Weekly manual upload | Review text is public; exports may include guest details |
| Post-stay surveys | To confirm | Revinate export | Monthly | **No** |
| Campaign records | 10–15 campaigns, last 2 years | One Markdown record per campaign (fixed template) + metrics table (spend, bookings, revenue) | When each campaign closes | **No** (financials confidential) |
| Property fact sheets, brand notes | ~20 short docs | Own data | Rarely | Internal |

## 5. Architecture

Two paths.

**Ingest path (daily):**
1. Sources: Google reviews (API), CSV exports, campaign records
2. Light sanitizing (see section 6)
3. Theme tagging: OpenAI tags each review with themes and sentiment; Zod validates the output
4. Storage: records and tags in Postgres; embeddings in Qdrant

**Question path:**
1. Marketer asks a question, filtered by property and date range
2. Router (Zod-validated output) picks a route: counts and trends → SQL on Postgres; "what did guests say" → hybrid search on Qdrant, then reranking
3. The answer is written from those results, with a citation for every claim, and streamed to the chat
4. LangSmith traces each step

**Principle:** counting questions ("how many", "which property most") use exact database counts, not AI estimates.

## 6. Data protection (updated)

### Change: heavy redaction dropped for public reviews (Nov 6, 2026)

Google reviews are already public, so the local redaction pipeline adds little protection for them. Removed from scope:

- Microsoft Presidio
- Staff-name list
- Review queue for records the cleaner can't confirm
- Restricted raw vault for public reviews
- The 100-snippet redaction eval (≥99% caught, 0 card numbers missed)

### What stays

- **Reviewer identity is not stored.** The reviewer's name from Google is dropped at ingestion (`ReviewRecordSchema` has no reviewer field).
- **Financial data stays restricted.** Campaign spend and revenue live in Postgres behind role-based access, never in the vector store. The model only receives figures an answer needs, for users whose role allows it. This was marketing's original concern.
- **Traceability:** every answer cites sources; every step is logged in LangSmith.

### Open decisions

- **Is the pilot Google-reviews-only?** If OTA exports, surveys or other non-public data are added, redaction returns for that source, and the privacy-contact (Alberta PIPA) review in the pilot proposal applies before use.
- **Keep the existing lightweight regex sanitizer** (`lib/sanitize.ts`: emails, phones, booking refs, card-like numbers)? It's already built and tested. Proposed: keep it as a cheap safety net. Not yet decided.

## 7. Tech stack

| Layer | Choice | Used for |
|---|---|---|
| App | Next.js, TypeScript, Node.js | Chat UI with streaming, upload and API routes |
| Model | OpenAI API (chat + embeddings) behind a thin adapter | Tagging, routing, answers, embeddings |
| Vector store | **Qdrant** (dense + sparse) | Review and campaign text with metadata |
| Structured store | Postgres | Clean reviews, theme tags, campaign metrics |
| Validation | Zod | Review schema, tag schema, router output |
| Observability | LangSmith | Tracing nested calls, debugging |
| Data in | Google Business Profile API; CSV exports | Review ingestion |
| Scheduling | Cron (e.g. Vercel Cron) | Daily review sync |
| ~~Redaction~~ | ~~Regex + staff-name list + Presidio~~ | Dropped for public reviews (section 6) |

**Note:** Qdrant replaced Pinecone. One line in the Project Plan's data section still says "OpenAI, Pinecone and LangSmith"; this should read Qdrant.

## 8. Stretch goal: hybrid search proven with retrieval evals

Sparse + dense hybrid search, measured with recall@k and MRR.

- Reviews contain exact words that matter (property names, amenities, outlet names), which sparse search catches; dense search catches paraphrases ("couldn't find anywhere to park").
- A recall@5 number before and after each change makes trust measurable.
- Plan: dense-only baseline → add sparse vectors → add a reranker, measuring after each step on the same labelled question set.

After the program: an MCP server so other company tools can query reviews and campaign history.

## 9. Evals and success measures

| Eval | Test set | Pass when |
|---|---|---|
| Retrieval | 20 real marketing questions with hand-labelled relevant reviews | Recall@5 ≥ 0.8; hybrid beats dense-only on recall@5 and MRR |
| Answer accuracy | Same 20 questions | Correct sources for ≥ 16 of 20 |
| Theme accuracy | 100 reviews hand-tagged by marketing and Evgenii | LLM tags match on ≥ 85%; "top 3 complaints" matches the hand count |
| Citations | Same 20 questions, LLM-as-judge | Every answer cites at least one source |
| ~~Redaction~~ | ~~100 snippets with known PII~~ | Dropped (section 6) |

**Pilot business measures:** time saved on a real task (≥ 50% faster), weekly use by marketing without prompting.

## 10. Pilot

- **Length:** 12 weeks, marketing team, 2–3 properties.
- **Decision at week 12:** expand company-wide, adjust and run 4 more weeks, or stop.
- **People:** Evgenii (build and run); Jackie, marketing partner (1–2 h/week: test questions, feedback, hand-tagging 100 reviews); whoever manages the Google listings and OTA extranets (one-time access); IT (hosting and database conversation); privacy contact (only if non-public data is added).
- **Start requirements:** approval and software budget; a marketing partner; review exports for 2–3 properties (last 12 months) and campaign records (last 2 years); manager access to Google Business Profiles; IT conversation; week-12 decision meeting.

### Cost

| Item | Estimate (/month) |
|---|---|
| OpenAI API (~50 questions/day; gpt-4o-mini to gpt-4o) | ~$2–25; one-time tagging of 5,000 reviews ≈ $1 |
| Qdrant Cloud | $0 on the free tier (1 GB RAM, 4 GB disk) |
| LangSmith | $0 free plan; $39 per extra seat |
| Hosting and database | To confirm with IT |

Value is measured as hours saved × hourly cost (illustration: 5 h/week at $35/h ≈ $700/month).

**Note:** the pilot document asks for "up to $200 per month" in The Ask but "up to $100 per month" in Start Requirements. Pick one before sharing.

## 11. Decision log

| Date | Decision |
|---|---|
| Nov 1, 2026 | Qdrant chosen as the vector database instead of Pinecone |
| Nov 1, 2026 | Marketing is the first use case; guest reviews are the priority |
| Nov 1, 2026 | `parsity_medical_rag` is reference only; HospitalityIQ is built separately in `~/Code/hospitalityiq` |
| Nov 1, 2026 | Google Business Profile API chosen as the review source; npm as package manager |
| Nov 6, 2026 | Google Business Profile API access requested (pending approval) |
| Nov 6, 2026 | Heavy redaction (Presidio, staff-name list, review queue, redaction eval) dropped because Google reviews are public |

## 12. Current build status

**Done**
- Next.js + TypeScript scaffold; Qdrant running locally in Docker
- `lib/schema.ts`: Zod schemas for Google Business Profile reviews and the stored review record (no reviewer field)
- `lib/sanitize.ts` + tests: lightweight regex sanitizer
- `lib/qdrant.ts`, `lib/openai.ts`, `lib/env.ts`: clients and config
- `scripts/ingest.ts`: load → validate → sanitize → embed → upsert
- `scripts/search.ts`: dense-only retrieval from the terminal (working)
- `data/sample-reviews.json`: fictional test fixture shaped like the Google API output; to be replaced by real reviews
- Answer pipeline: `lib/plan.ts` (intent, filters), `lib/filters.ts`, `lib/retrieve.ts` (with relaxed retry), `lib/answer.ts` (cited, streamed), `POST /api/ask`, `npm run ask`
- Eval harness: `evals/dataset.json` (42 labelled cases in three groups: regression, statistics, boundary), `scripts/eval.ts` (`npm run eval`), `lib/evalMetrics.ts` + tests, `lib/evalJudge.ts`. Saved runs live in `evals/baselines/`: `initial-retrieval-only.json` (first numbers) and `pre-statistics-routing.json` (the reference for the regression group)
- `evals/test-questions.md`: original draft questions (superseded by `dataset.json`)
- `docs/gbp-api-access.md`: API access checklist
- Statistics routing: count, ranking and trend questions are answered exactly from Postgres, with text written by code, never the model; everything qualitative stays on Qdrant. Design, decisions and eval: `docs/routing-plan.md`, `docs/adr/0001-counts-never-pass-through-the-model.md`, terms in `GLOSSARY.md`
- Postgres foundation (local, Docker Compose): plain-SQL migrations, read-only role, `reviews` / `review_tagging` / `review_themes`, Postgres-first ingest with Qdrant sync, `reconcile` / `reindex`, and fixed parameterized statistics queries (`lib/reviewStats.ts`, `npm run stats`). Tags are provisional hand tags and synthetic practice data. Design and as-built differences: `docs/sql-plan.md`

**Next**
1. Fix what the eval found (latest run in `evals/results/latest.json`, saved runs in `evals/baselines/`), then re-baseline on real reviews
2. Theme taxonomy, agreed with marketing
3. AI theme tagging validated against a hand-labelled set (statistics routing is done; counts are only as good as the tags)
4. Qdrant collection redesign with named dense + sparse vectors
5. Re-label the eval dataset against real reviews when they arrive (current labels use 8 fictional reviews)
6. When connecting the Google Business Profile API, map each location to a `propertyType` (hotel, restaurant, spa). GBP does not supply it, and the planner's type filter depends on it. Company aliases (BCP, Banff Caribou Properties) live in `COMPANY_ALIASES` in `lib/filters.ts`