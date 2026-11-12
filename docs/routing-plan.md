# Routing count and trend questions to SQL

Status: built (PRs #3, #4 and the eval PR). Written 2026-11-10, revised 2026-11-11 after a design review and while building. Builds on [sql-plan.md](sql-plan.md) (the Postgres foundation, merged in PR #1). Terms (mention, complaint, praise, coverage, count, sample, trend) are defined in [GLOSSARY.md](../GLOSSARY.md); the core rule is [ADR 0001](adr/0001-counts-never-pass-through-the-model.md).

## Why

`lib/reviewStats.ts` can answer "how many reviews mention X", "top themes" and "current vs previous period" exactly, but nothing in the question path calls it. `answerQuestion` (`lib/answer.ts`) plans, retrieves 8 or 40 reviews from Qdrant and asks the model to describe that sample; its prompt forbids exact counts. So "Which properties get the most mentions of cleanliness?" (eval q03) and "How has feedback about check-in changed over the last year?" (q04) can only be answered with hedges.

This slice sends counting and trend questions to SQL and keeps everything qualitative ("what do guests say", quotations) on Qdrant. It runs on the provisional taxonomy and the 8 hand-tagged fixtures. AI tagging waits for marketing's theme feedback.

## Scope

In: a route decision in the planner, a server-side gate before any SQL runs, a read-only database connection in the app, deterministic answer text for statistics, stats-specific filter handling, eval cases for routing and exactness.

Deferred: count-plus-quotations hybrid answers, several themes in one question, UI work beyond the unchanged text stream, "which property gets the most complaints" without a theme (the current statistics need a theme), AI tagging, the `property_sources` mapping (see sql-plan.md conventions).

## What exists and is reused

- Planner: `lib/plan.ts` (`planQuery`, strict structured output) and `QueryPlanSchema` in `lib/schema.ts`.
- Filters and aliases: `lib/filters.ts` (`sanitizePlan`, `findCompanyAlias`, `COMPANY_ALIASES`).
- Statistics: `themeMentions`, `themeRanking`, `themeTrend` and the `StatsInputError` family in `lib/reviewStats.ts`. They accept any client with `query`, so a `pg` Pool works.
- Events and wire format: `AnswerEvent` in `lib/answer.ts`, `lib/askWire.ts` (a drift guard fails `tsc` when the event union and its schema differ; the client already tolerates unknown event types).
- Eval harness: `scripts/eval.ts`, `lib/evalMetrics.ts`, `evals/dataset.json` (28 cases, fixed `today`).
- `pg` is on Next.js's default server-external list, so `next.config.ts` needs no change.

## Decisions

1. **The planner chooses the route; code decides everything after.** Planning is **two model calls run in parallel**, merged by `planAndRoute` in `lib/plan.ts`: `planQuery` (intent, mode, search query, filters) with its prompt and schema exactly as before statistics routing, and `routeQuery` (route and stat only). One combined call was tried first; in the eval it shifted retrieval plans (`aggregate` became `specific` for q05, q14, q25, q28; q16 lost its spa filter) while the old planner, run against the same model, did not. Two calls keep retrieval planning unchanged by construction and add no wait, at the cost of one small extra call per question. Together they return `PlannerOutputSchema`: the existing `QueryPlanSchema` plus `route: "retrieval" | "statistics"` and a nullable `stat: { kind: mentions | ranking | trend, themes, topic, sentiment, ranks: themes | properties }` (every key nullable, as strict output requires). The model supplies filters and themes and never writes SQL.
   - **`QueryPlanSchema` itself is unchanged.** Saved answers (`lib/askPersistence.ts`) and the wire format (`lib/askWire.ts`) parse it, so adding required fields to it would make previously saved answers fail to load. The new schema extends it instead, and code that only needs the plan keeps using `QueryPlan`.
   - **`themes`** is the list of theme slugs the question asks about, one entry per theme. A list, not a single theme, so that the gate can see a second theme and refuse it (decision 2). A ranking has `themes: null`.
   - **`ranks`** says what a "most" question compares: themes or properties (decision 2 uses it so a property question never becomes a theme ranking).
   - **`topic`** is the subject of the question in the user's own words ("breakfast", "the thermal pool", "check-in"), copied whether or not it maps to a theme. It is only ever shown back in a fallback note, never used in SQL.
   - **`mode` stays, unchanged.** It only matters on the retrieval route. Narrowing its description (as first decided) shifted retrieval answers in the eval, so its wording is the original one. A fallback from statistics always uses `aggregate` (40 reviews).
   - **Theme synonyms are explicit.** The prompt lists each theme slug with a meaning and an explicit list of synonyms (check-in, reception → front-desk; cleanliness → housekeeping). A narrower or different topic ("breakfast", "thermal pool") gets an empty `themes` list and its `topic` set. `other` is never a valid planner theme.
   - **The route follows the form of the question**, not whether its topic is a theme: "how many mention the thermal pool" is statistics with an empty themes list, so the gate explains it can only count themes.
   - **Boundary rules, with examples in the prompt.** Counts, rankings, "most/least", "how many" and "changed over time" go to statistics. "What do guests say/praise/complain about" stays on retrieval. "What do guests complain about **most**" goes to statistics (a ranking with negative sentiment). A question that asks for both a count and what guests say ("how many complain about parking, and what do they say?") goes to statistics, followed by the fixed line "For what guests say, ask: 'What do guests say about parking?'". That line ends **every** statistics answer that has a count (for a ranking, it names the top theme), so no planner field is needed to detect the "what do they say" half; it is left out only when there is nothing to count.
   - Sentiment follows the glossary: complaint = negative, praise = positive, "good or bad" / no qualifier = any.

2. **A pure gate sits between plan and SQL.** `resolveRoute(plan, knownThemes, today)` returns `statistics` (with a completed window), or a reason to fall back to retrieval with a visible note. It never guesses a nearest theme. In order:
   - `intent !== "review_insight"` → statistics is never used; the existing decline message stands, whatever `route` says.
   - `route: "statistics"` but `stat` or `stat.kind` is null → fall back: "I couldn't tell what to count."
   - `kind: "ranking"` with `ranks` other than `"properties"` → statistics (a theme ranking); `themes` is ignored.
   - `ranks: "properties"` ("which property gets the most complaints") is never a theme ranking. With one theme it becomes a per-property count of that theme (the `mentions` rows, ordered by count). With no theme → fall back: 'I can rank properties for one theme at a time, for example "which property gets the most parking complaints".' Added because the planner turned that question into a theme ranking in 2 of 6 runs even with explicit prompt rules; a field the planner must fill makes the distinction deterministic in code.
   - `themes` has more than one distinct entry → fall back: "I can count one theme at a time; try asking about each separately." Checked before validity, so "parking or breakfast" gets this note rather than the next one.
   - `themes` empty or null (for `mentions` and `trend`), or its one entry unknown or `other` → fall back. With `topic` set: "I can only count broad themes such as Food, not <topic> specifically." With `topic` null: "I can only count broad themes such as Food or Parking." The note lists the theme labels either way.
   - Trend combined with a `months` filter → fall back ("winter" has no single previous period). Checked before the window, so "has winter feedback changed?" gets this note, which is the real reason, rather than "which period?".
   - Trend with no `since` (no window, or only an `until`) → fall back with a note asking for a time period. Trend with `since` but no `until` → `until = today`.
   - The fallback is the existing retrieval path plus a note that the figure cannot be counted exactly. A sampled number is never presented as a count.

3. **One `today`, in local time.** `today` is computed once per question in a portfolio timezone constant (`America/Edmonton`) and passed both to the planner and to the gate's `until` default. Today `planQuery` defaults to the UTC date, which is already tomorrow on Banff evenings.
   - **Two timezone rules, two jobs, no conflict.** The portfolio timezone decides which calendar *dates* the question means (today, "last year"), once, for the whole question. Each property's own timezone then decides which *instants* fall inside those dates (decision 4), so a window means the same local days at every property. While every property is in `America/Edmonton` the two agree; if a property in another timezone is added, this split still holds.

4. **Statistics handle properties differently from retrieval, on purpose.** `sanitizePlan` silently drops unknown property names, which suits retrieval but would broaden a count to all properties. The statistics route uses the planner's raw names: an unknown name returns "no property named X" (`UnknownPropertyError`). Only properties with reviews from the counted source are known, so the synthetic practice properties are never listed in that message or counted under the real source. A company alias (BCP) means all properties only when no specific property is named. Windows are local dates in the property's timezone. Qdrant's `month` field is UTC, so a statistics count and a retrieval sample can differ near month boundaries; this stays documented, not hidden.

5. **Fixed data scope.** Statistics always use one `tagSource` and `taxonomyVersion` (constants `manual` and `v1`, overridable by env) and `source: "google_business_profile"`. This excludes the `synthetic` practice set. It does not exclude the 8 fictional fixtures, which are stored under the Google source and will be replaced by real reviews rather than kept alongside them. Every answer carries coverage and a "provisional tags" caveat while the taxonomy is provisional.

6. **Numbers are rendered by code, never narrated by the model** ([ADR 0001](adr/0001-counts-never-pass-through-the-model.md)). `renderStats(result)` is deterministic and emitted as `delta` events so the existing UI and CLI show it unchanged, plus a structured `stats` event for later UI use. Rendering rules:
   - **Counts are stated against reviews with current tags**, in the same sentence. "Tagged" in answers always means *current* tags. Reviews with outdated tags are not counted; they appear in coverage, next to untagged ones. Example: "2 of 8 tagged reviews mention Parking (50 reviews in scope: 8 tagged, 3 with outdated tags, 37 not yet tagged; 2 rating-only)". The numbers add up: in scope = current + outdated + untagged + rating-only. If no review in scope has current tags, no count is shown, only "None of the 50 reviews in scope are tagged yet, so I can't count Parking mentions."
   - **The theme counted is always named** by its label, so a reworded question cannot hide what was counted.
   - **Property comparisons** are ordered by count (as asked), and every row shows its share of tagged reviews: "Lodge: 12 of 300 tagged reviews (4%)". No re-ranking by share.
   - **Theme rankings exclude `other`** (`themeRanking` already does) and the rendered text says so: "Mentions outside the listed themes are not ranked."
   - **Ties are stated, not ranked.** When themes share the top count the answer says so ("Front desk, Housekeeping and Parking are tied at the top, with 1 each."), and any tie in the list adds "Tied themes are listed alphabetically.", so a numbered list never implies one theme leads.
   - **Trends** show both periods with their own window, count and tagged total. The percent change is shown only when both periods have at least `MIN_TREND_MENTIONS` (10) mentions; otherwise a fixed sentence: "Too few mentions to show a reliable change."

7. **Read-only connection in the app.** `lib/db/readonlyPool.ts` builds a `pg` Pool lazily from `DATABASE_URL_READONLY`, cached on `globalThis` so Next dev reloads do not leak connections. Two kinds of failure, handled differently:
   - **Infrastructure** (variable missing, database down, timeout, connection refused): the question falls back to retrieval with a note that exact counts are unavailable right now; the error is logged on the server, never shown.
   - **Input** (`StatsInputError` subclasses: unknown property, bad window): a fixed user-facing message, with no retrieval fallback.
   Raw SQL errors never reach the user.

## Eval (where this succeeds or fails)

Add `expectedRoute` (and `expectedStat`) to `evals/dataset.json` and score route correctness in `scripts/eval.ts`. New cases, with exact numbers worked out by hand from `data/manual-tags.json`:

- Statistics: "how many reviews mention parking"; a theme-per-property question (housekeeping complaints, with shares); top themes for the portfolio (no `other`); "what do guests complain about most" (complaint ranking); "has check-in feedback changed over the last year" (fixed `today`, open-ended window filled to today, "too few mentions" sentence); a BCP-wide count; a count-plus-what-they-say question (statistics plus the follow-up line).
- Boundary, must stay retrieval: "what do guests say about parking", reusable phrases and quotes, "what do families say".
- Must fall back honestly: unknown theme ("how many mention the thermal pool"), a narrower topic ("how many mention breakfast"), two themes ("parking or value"), a trend with no time period, a "winter" trend. Unknown property returns the fixed message and does not fall back.
- Existing q03 and q04 are re-labelled to statistics and lose their `relevantReviewIds`. q21 ("which property gets the most complaints") has no theme and stays in the regression group; it now takes the honest fallback.
- **q01, q02 and q26 also moved to statistics** (decided while building the eval). They ask what guests complain about or praise *most*, which decision 1 routes to a ranking, and the planner did so in every run; they could no longer pass their old retrieval checks. They are statistics cases with hand-computed rankings.

Reported in three separate groups, so a statistics win cannot hide a retrieval regression:

1. **The 23 unchanged cases** (`group: "regression"`), scored exactly as before. They are case IDs from the 26/28 run (2026-11-09, dataset `eec4c0b24c8b`, failed q04 and q05; committed unchanged as `evals/baselines/pre-statistics-routing.json`, so later runs overwriting `evals/results/latest.json` do not lose it), minus the five moved to statistics (q01, q02, q03, q04, q26): q05–q25, q27, q28. Compare each case against its result in that run. On these 23 IDs that run scored 22/23, with q05 the only miss; report q05 separately (its judge miss is known and unrelated to routing), so the regression check is 22/22 on the other cases. (Originally 26 IDs and 25/25, before q01, q02 and q26 moved.) **Pass rule:** run with `--runs 3 --judge`, as the snapshot was, and count a case as passing only when it passes all 3 runs. That is the rule `scripts/eval.ts` already applies and the rule behind 26/28; a majority rule would make the comparison meaningless.
2. **Statistics cases** (re-labelled and new): route accuracy and exactness (the rendered text contains the hand-computed numbers).
3. **Boundary and fallback cases**: route accuracy (target 100%).

**Saved runs.** All live in `evals/baselines/`. `pre-statistics-routing.json` is the reference for group 1. `initial-retrieval-only.json` is the older first run (dataset `944313d3003b`, 19/25), moved from `evals/baseline.json`. `npm run eval -- --baseline <name>` saves a new run as `evals/baselines/<name>.json` and refuses to overwrite one.

**What the eval cannot reach.** With 8 fixtures and `MIN_TREND_MENTIONS = 10`, every trend case renders "Too few mentions to show a reliable change". The percent-change path is covered by the `renderStats` unit tests only, until real data arrives.

Across every case answered on the retrieval route, a new judge rubric item asks: "Does the answer state a number of reviews or mentions as if it covered all reviews, rather than the sample?" Failures are counted and reported (target 0).

## Tests

- Pure (no database, no OpenAI): `resolveRoute` for each rule in decision 2 (intent, no kind, ranking, several themes, themes empty/unknown/`other` with and without `topic`, `until` filled from `today`, no window, months); `renderStats` for each result shape (zero counts, nothing tagged, `percent: null`, below and above `MIN_TREND_MENTIONS`, shares, `other` excluded); the local `today` near midnight UTC; error-to-message mapping for both kinds of failure.
- Integration (disposable database, synthetic data, existing pattern): `answerQuestion` with a stubbed planner returns the exact text for a hand-computed case; an unknown property yields the error and never broadens; a missing `DATABASE_URL_READONLY` and an unreachable database both fall back to retrieval.
- Real stack: the eval cases above.

## Files

- PR A (merged): `lib/schema.ts`, new `lib/today.ts`, new `lib/route.ts`, new `lib/statsAnswer.ts`.
- PR B: new `lib/answerPipeline.ts` (the pipeline, with every external call passed in so it can be tested with a stubbed planner and the test database), `lib/answer.ts` (the real wiring), new `lib/db/readonlyPool.ts`, new `lib/statsSettings.ts`, new `lib/themeGuide.ts` (theme synonyms for the planner, checked against the seeded themes), `lib/plan.ts`, `lib/askWire.ts`, `lib/askState.ts`, `lib/reviewStats.ts` (known properties limited to the counted source), `scripts/ask.ts`, `.env.example`.
- PR C: `scripts/eval.ts`, `lib/evalMetrics.ts`, `evals/dataset.json`, plus status text in `docs/project-scope.md` and the README.

## Risks

- **Misrouting.** A qualitative question sent to SQL returns a bare number; the reverse keeps today's behaviour. Hence boundary cases in both directions and a fallback that never fabricates a count.
- **Overcounting by theme mapping.** A narrower topic mapped onto a broad theme would be an exact-looking wrong answer. Hence explicit synonyms, an empty `themes` list for anything else, and the theme label in every answer.
- **Numbers are only as good as the tags.** Today that is 8 fictional fixtures. Answers say "provisional" and state counts against tagged reviews. Real value arrives with AI tagging, which needs marketing's theme list first.
- **Small numbers read as trends.** Hence the `MIN_TREND_MENTIONS` threshold and per-period tagged totals.
- **UTC vs local month** mismatch between Qdrant and SQL (decision 4).

## Verification

`npx tsc --noEmit`; `npx vitest run` with and without `DATABASE_URL_TEST`; `npm run ask -- "how many reviews mention parking?"` shows the statistics route, "X of Y tagged reviews" and coverage; `npm run ask -- "what do guests say about parking?"` still cites reviews; `npm run ask -- "how many mention breakfast?"` falls back with the theme note; `npm run eval` shows the three groups with no regression in group 1; run `npm run dev`, ask one question of each kind in the browser, and confirm the text renders and the stream completes.

## Open questions

- Which tag source to trust once AI tagging exists (manual vs llm), and when to flip the default.
- Whether a count-plus-quotations answer, and several themes per question, are worth a second slice once routing is proven.
- Marketing's review of the provisional theme list, which changes the glossary and the planner's synonym lists.
- Whether `MIN_TREND_MENTIONS = 10` holds up on real data.
