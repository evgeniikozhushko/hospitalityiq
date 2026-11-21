# Tagging, campaigns and sign-in

Status: proposed, not approved. Written 2026-11-20 from three rounds of design questions (Q1–Q19). Builds on [routing-plan.md](routing-plan.md). New terms (tag set, active tag set, gate, gate sample, evidence sentence, campaign, campaign figures, direct booking, campaign record) are defined in [GLOSSARY.md](../GLOSSARY.md). The rules that are hard to reverse are [ADR 0002](adr/0002-campaign-figures-never-enter-the-vector-store.md) (figures never enter the vector store) and [ADR 0003](adr/0003-a-tag-set-must-pass-the-gate-before-its-counts-are-shown.md) (a tag set must pass the gate, and every new one passes again).

## Sequence and data (Q1, Q2, Q6)

- **Order:** tagger, then ranked themes with trend, then quotes, then campaigns. Counts are only as good as the tags, so tagging comes first. Campaigns start only after the trend flow passes its eval.
- **No deadline.** Dates are not driving scope. The full order is planned, campaign figures included.
- **Real reviews:** the Google API is connected. Real reviews for 2–3 properties are pulled first, and tuning (tagger prompt, the remaining eval wording slips) happens on them, not on the synthetic set. The CSV import stays, as a fallback and for OTA exports later.

## Why

Most of the main pilot flow ("top themes with counts and trend") answers "none are tagged yet" on real reviews, because nothing produces tags ([audit](audit-2026-11-14-2.md), finding 3). The pilot also asks about campaigns ("which winter promotion brought the most direct bookings, and why did it work?"), which today are always declined. And the app has no sign-in, which blocks it from being reachable by anyone.

## Scope

In: narrowed database grants, an AI tagger with tag sets and a gate, quotes picked by code, thin-theme display, campaign figures and records with their ingest checks, campaign routes including the compound question, Microsoft sign-in with an email allowlist, a campaign eval set.

Deferred: tuning the tagger against real reviews (waits for the Google API), the campaign eval questions (wait for real records), same-period-last-year trends (wait for real volumes), a hosting ADR (waits for IT).

## Principle: write code now, measure later

Everything here can be built and tested on the synthetic set and on records that exist only in the test suite. None of it is tuned against fictional data. The tagger prompt is written once on the synthetic set and then left alone until real reviews arrive. Iterating on it against made-up reviews is the overfitting the audit warned about.

## Decisions

### 1. Narrowed database grants first (Q5, Q7)

The most important rule here, because financial leakage is what marketing raised first. Today the read-only role gets `SELECT` on all current and future tables (`db/setup/roles.sql:6-7`), so a campaign spend table would be readable by the question path the day it was created. Before any campaign table exists:

- The read-only role is granted named tables and views only, with no default privileges on future tables.
- Campaign figures sit behind a separate role that only the campaign route uses.
- The model never receives a figure the answer does not need.

These depend on no data, so they come first. A single sign-in gate is enough for the pilot while every user is in marketing. The database role is the real protection.

### 1a. Taxonomy (Q3)

- The provisional v1 list is used now, with the taxonomy version on every tag. A re-tag when marketing changes the list costs about $1 per 5,000 reviews.
- A review can carry several themes, each with its own sentiment (praise for the spa and a complaint about parking in one review). The tag table already allows this.
- Marketing sees the draft theme list **before** the hand labelling starts, not after.

### 2. Tagging (Q17)

- A step after each import, safe to re-run. It touches only reviews with no tags in the current tag set, or with stale ones.
- A tag set is identified by taxonomy version, prompt version and a **dated model snapshot**, never an alias. Each run records all three.
- A review whose text hash changes is stale and is re-tagged. The `text_hash` and `stale` columns already exist (`db/migrations/0001_init.sql`).
- The tagger's output goes through the same Zod validation as the router. A review whose tags fail validation is flagged and shows up in coverage. It is never dropped, or counts would silently shrink (Q1).
- Each run has a spending cap and stops cleanly when it is reached.
- One record names the **active tag set**. Counts read only from it, and it switches only after a new set passes the gate. Today the active set is chosen by `STATS_TAG_SOURCE` and `STATS_TAXONOMY_VERSION` (`lib/statsSettings.ts`). That moves to the record.

### 3. The gate (Q8)

- Precision and recall **for each theme** against hand labels, with an 85% bar on every theme. A tagger can score 85% overall and still be poor on parking.
- Every theme needs at least 15 labelled mentions in the gate sample, or its score is noise. If a theme falls short, more reviews that mention it are added to the sample. A theme still short after that is reported as "not enough labels to judge", and its counts are not shown.
- **Agreement first.** Evgenii and Jackie label the same 20–30 reviews. If they agree less than about 85% of the time, the bar or the theme definitions change before any tagger is judged.
- **Three separate labelled sets:** the agreement set (20–30), a tuning set for prompt iteration (20–30), and the gate sample (100), which is never used for tuning.
- The gate sample leans toward low star ratings, because complaints are what the main flow counts.
- Every new prompt, model snapshot or taxonomy is a new tag set and goes through the gate again ([ADR 0003](adr/0003-a-tag-set-must-pass-the-gate-before-its-counts-are-shown.md)). The 100 labels stay the same, so re-checking is one run.

### 4. Code picks the quotes (Q9)

- The tagger returns the **evidence sentence** for each tag. Code checks it is a word-for-word substring of the stored (sanitized) text, because that is what gets quoted. A tag whose sentence fails the check is flagged under rule 2.
- This needs a new nullable column on the tag rows. Hand tags have no sentence.
- "Most relevant" is a rule code can apply: matching sentiment first (negative for a complaints question), then most recent.
- The sentence also speeds up the hand audit for the gate.

### 5. Thin themes (Q10)

One property over six months is about 80–125 reviews across seven themes, so most themes will sit under 10 mentions. Below the threshold, each row shows both raw counts beside "too few to show a change" ("7 mentions, 4 in the previous period"). The trend answer already prints both periods' counts and compares shares. The new work is carrying that into each row of the ranking.

Seasonality goes on the list. In Banff, the last six months against the six before compares summer with winter. Share of reviews already helps, and the same period last year is the fairer comparison once real volumes exist.

### 6. Campaign records and figures (Q11, Q12)

- **Fixed template** for the Markdown record, with a campaign ID that links it to its CSV row. The CSV has a separate direct-bookings column and a note on how bookings were attributed. Unknown figures are blank, never zero.
- **No figures in the vector store** ([ADR 0002](adr/0002-campaign-figures-never-enter-the-vector-store.md)). Records are accepted as written. Ingest masks money amounts as `[AMOUNT]` before embedding, and warns about the masked line and any number near "bookings", "revenue", "spend" or "ROI".
- 2–3 records are filled in before the template is frozen, from real campaign decks or emails if marketing has them (Q4).
- The first batch is 3–5 records. The target is the 10–15 campaigns in the scope doc.

### 7. Which money questions are answered (Q15)

An allowlist: **spend, bookings, direct bookings and revenue per campaign** are answered, and everything else financial is declined (payroll, pricing, rates, budgets, property revenue, and anything not on the list).

- **Derived figures** such as cost per booking or return on spend are allowed only when code computes them from allowed fields. The model never does.
- **Sums** are allowed ("total campaign revenue at the Lodge"), but the answer says it is campaign revenue, not property revenue.

### 8. Campaign rankings (Q16)

- Only campaigns with the figure are ranked, and the ones left out are named: "ranked 6 of 9 winter campaigns; no figure recorded for A, B, C". A blank is never zero and never ranked last.
- Ties: every campaign tied with the last place is kept, the same rule as top themes.
- Too few figures: with only one or two campaigns that have one, the answer says so instead of showing a ranking.
- Different attribution methods: if the campaigns being ranked counted bookings differently, the answer flags it.

### 9. The compound question (Q12)

"Which winter promotion brought the most direct bookings, and why did it work?" is answered in two steps within one answer. SQL ranks the campaigns and code writes the figure. Then the model explains the top campaign from its record and never sees the figure, so the "why" can't restate or change it. If campaigns tie for the top, each tied campaign is explained.

### 10. Sign-in and hosting (Q13, Q14)

- **Plan for** Vercel with Microsoft sign-in and an email allowlist. The check lives in one module so it can move if IT says otherwise.
- **IT still has to register the app** in the company's Microsoft tenant. Ask for a single-tenant registration, so only company accounts can sign in at all. The allowlist sits on top of that.
- **The check runs on the server**, in every API route, not only on the page.
- **Preview deployments** either go through the same check or run on synthetic data only.
- **Real campaign figures stay off Vercel and hosted Postgres until IT agrees.** Public reviews are low risk; spend and revenue are what marketing worried about. Find out which region the database would be in.

## Eval (Q18)

The campaign routes get their own set of 10–15 questions, written once the real records exist, each with its expected campaign and figure. It must include:

- a campaign with a blank figure,
- a financial question that should be declined,
- the compound "which brought the most, and why" question,
- a campaign that doesn't exist.

Jackie writes some of them. Questions written by the same person who wrote the records will fit those records too well. Until then, there is no fictional campaign data to tune against.

## Tests

Unit and database tests on 2–3 made-up campaign records that exist only in the test suite. Tagger tests use recorded model output, not live calls. The gate script is tested on hand-made label files with known precision and recall.

## Order

1. Narrowed grants. Alongside it, pull real reviews for 2–3 properties.
2. Tag set schema: active-set record, model snapshot and prompt version, evidence sentence column, validation flag.
3. Tagger step with spending cap and substring check. Prompt written once on the synthetic set.
4. Gate script and labelling format.
5. Quote selection and thin-theme rows.
6. Campaign schema, financial role, template and ingest masking.
7. Campaign routes: allowlist, rankings, compound question.
8. Sign-in, once IT has registered the app.

Measuring (agreement, gate, campaign eval) starts when real reviews and records arrive.

## Risks

- People may agree too rarely for 85% to be reachable. The agreement check exists to find this out before the tagger is judged.
- The ingest check for money amounts will sometimes reject harmless text. The author rewrites it.
- IT may not approve Vercel, or may take a long time. Keeping the check in one module limits the rework.

## Open questions

- Do real campaign records (decks, emails) exist to write the first records from?
- Will IT register a single-tenant app, and do they accept Vercel and a hosted Postgres for campaign figures? Which region?
- How were direct bookings attributed for past campaigns, and is it the same for all of them?
