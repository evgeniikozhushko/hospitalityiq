# Routing count and trend questions to SQL

Status: planned, not built. Written 2026-11-10, revised 2026-11-11 after a design review. Builds on [sql-plan.md](sql-plan.md) (the Postgres foundation, merged in PR #1). Terms (mention, complaint, praise, coverage, count, sample, trend) are defined in [GLOSSARY.md](../GLOSSARY.md); the core rule is [ADR 0001](adr/0001-counts-never-pass-through-the-model.md).

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

1. **The planner chooses the route; code decides everything after.** `QueryPlanSchema` gains `route: "retrieval" | "statistics"` and a nullable `stat: { kind: mentions | ranking | trend, theme, sentiment }` (every key nullable, as strict output requires). The model supplies filters and a theme and never writes SQL.
   - **`mode` stays, narrowed.** Its description drops counting and trends: `aggregate` now means comparing properties in words, and `mode` only matters on the retrieval route. A fallback from statistics always uses `aggregate` (40 reviews).
   - **Theme synonyms are explicit.** The prompt lists each theme slug with a meaning and an explicit list of synonyms (check-in, reception → front-desk; cleanliness → housekeeping). A narrower or different topic ("breakfast", "thermal pool") gets `theme: null`. `other` is never a valid planner theme.
   - **Boundary rules, with examples in the prompt.** Counts, rankings, "most/least", "how many" and "changed over time" go to statistics. "What do guests say/praise/complain about" stays on retrieval. "What do guests complain about **most**" goes to statistics (a ranking with negative sentiment). A question that asks for both a count and what guests say ("how many complain about parking, and what do they say?") goes to statistics, followed by the fixed line "For what guests say, ask: 'What do guests say about parking?'".
   - Sentiment follows the glossary: complaint = negative, praise = positive, "good or bad" / no qualifier = any.

2. **A pure gate sits between plan and SQL.** `resolveRoute(plan, knownThemes, today)` returns `statistics` (with a completed window), or a reason to fall back to retrieval with a visible note. It never guesses a nearest theme. In order:
   - `intent !== "review_insight"` → statistics is never used; the existing decline message stands, whatever `route` says.
   - Theme missing, unknown, or `other` → fall back: "I can only count broad themes such as Food, not <topic> specifically."
   - More than one theme in the question → fall back: "I can count one theme at a time; try asking about each separately."
   - Trend with `since` but no `until` → `until = today`. Trend with no window at all → fall back with a note asking for a time period. Trend combined with a `months` filter → fall back ("winter" has no single previous period).
   - The fallback is the existing retrieval path plus a note that the figure cannot be counted exactly. A sampled number is never presented as a count.

3. **One `today`, in local time.** `today` is computed once per question in a portfolio timezone constant (`America/Edmonton`) and passed both to the planner and to the gate's `until` default. Today `planQuery` defaults to the UTC date, which is already tomorrow on Banff evenings.

4. **Statistics handle properties differently from retrieval, on purpose.** `sanitizePlan` silently drops unknown property names, which suits retrieval but would broaden a count to all properties. The statistics route uses the planner's raw names: an unknown name returns "no property named X" (`UnknownPropertyError`); a company alias (BCP) means all properties only when no specific property is named. Windows are local dates in the property's timezone. Qdrant's `month` field is UTC, so a statistics count and a retrieval sample can differ near month boundaries; this stays documented, not hidden.

5. **Fixed data scope.** Statistics always use one `tagSource` and `taxonomyVersion` (constants `manual` and `v1`, overridable by env) and `source: "google_business_profile"`. This excludes the `synthetic` practice set. It does not exclude the 8 fictional fixtures, which are stored under the Google source and will be replaced by real reviews rather than kept alongside them. Every answer carries coverage and a "provisional tags" caveat while the taxonomy is provisional.

6. **Numbers are rendered by code, never narrated by the model** ([ADR 0001](adr/0001-counts-never-pass-through-the-model.md)). `renderStats(result)` is deterministic and emitted as `delta` events so the existing UI and CLI show it unchanged, plus a structured `stats` event for later UI use. Rendering rules:
   - **Counts are stated against tagged reviews**, in the same sentence: "2 of 8 tagged reviews mention Parking (50 reviews in scope; 42 not yet tagged)". If no review in scope is tagged, no count is shown, only "None of the 50 reviews in scope are tagged yet, so I can't count Parking mentions."
   - **The theme counted is always named** by its label, so a reworded question cannot hide what was counted.
   - **Property comparisons** are ordered by count (as asked), and every row shows its share of tagged reviews: "Lodge: 12 of 300 tagged reviews (4%)". No re-ranking by share.
   - **Theme rankings exclude `other`** and say so: "Mentions outside the listed themes are not ranked."
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
- Existing q03 and q04 are re-labelled to statistics and lose their `relevantReviewIds`. q21 ("which property gets the most complaints") has no theme and stays retrieval with the honest fallback.

Reported in three separate groups, so a statistics win cannot hide a retrieval regression:

1. **The 26 unchanged cases**, scored exactly as before. They are the same 26 case IDs as in the 26/28 run (2026-11-09, dataset `eec4c0b24c8b`, failed q04 and q05; committed unchanged as `evals/baselines/pre-statistics-routing.json`, so later runs overwriting `evals/results/latest.json` do not lose it), minus the re-labelled q03 and q04: q01, q02, q05–q28. Compare each case against its result in that run. On these 26 IDs that run scored 25/26, with q05 the only miss; report q05 separately (its judge miss is known and unrelated to routing), so the regression check is 25/25 on the other cases.
2. **Statistics cases** (re-labelled and new): route accuracy and exactness (the rendered text contains the hand-computed numbers).
3. **Boundary and fallback cases**: route accuracy (target 100%).

Across every case answered on the retrieval route, a new judge rubric item asks: "Does the answer state a number of reviews or mentions as if it covered all reviews, rather than the sample?" Failures are counted and reported (target 0).

## Tests

- Pure (no database, no OpenAI): `resolveRoute` for each rule in decision 2 (intent, theme missing/unknown/`other`, several themes, `until` filled from `today`, no window, months); `renderStats` for each result shape (zero counts, nothing tagged, `percent: null`, below and above `MIN_TREND_MENTIONS`, shares, `other` excluded); the local `today` near midnight UTC; error-to-message mapping for both kinds of failure.
- Integration (disposable database, synthetic data, existing pattern): `answerQuestion` with a stubbed planner returns the exact text for a hand-computed case; an unknown property yields the error and never broadens; a missing `DATABASE_URL_READONLY` and an unreachable database both fall back to retrieval.
- Real stack: the eval cases above.

## Files

`lib/schema.ts`, `lib/plan.ts`, new `lib/route.ts`, new `lib/statsAnswer.ts`, new `lib/db/readonlyPool.ts`, `lib/reviewStats.ts` (rankings exclude `other`), `lib/answer.ts`, `lib/askWire.ts`, `scripts/ask.ts`, `scripts/eval.ts`, `lib/evalMetrics.ts`, `evals/dataset.json`, plus status text in `docs/project-scope.md` and the README.

## Risks

- **Misrouting.** A qualitative question sent to SQL returns a bare number; the reverse keeps today's behaviour. Hence boundary cases in both directions and a fallback that never fabricates a count.
- **Overcounting by theme mapping.** A narrower topic mapped onto a broad theme would be an exact-looking wrong answer. Hence explicit synonyms, `theme: null` for anything else, and the theme label in every answer.
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
