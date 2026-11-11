# Routing count and trend questions to SQL

Status: planned, not built. Written 2026-11-10. Builds on [sql-plan.md](sql-plan.md) (the Postgres foundation, merged in PR #1).

## Why

`lib/reviewStats.ts` can answer "how many reviews mention X", "top themes" and "current vs previous period" exactly, but nothing in the question path calls it. `answerQuestion` (`lib/answer.ts`) plans, retrieves 8 or 40 reviews from Qdrant and asks the model to describe that sample; its prompt forbids exact counts. So "Which properties get the most mentions of cleanliness?" (eval q03) and "How has feedback about check-in changed over the last year?" (q04) can only be answered with hedges.

This slice sends counting and trend questions to SQL and keeps everything qualitative ("what do guests say", quotations) on Qdrant. It runs on the provisional taxonomy and the 8 hand-tagged fixtures. AI tagging waits for marketing's theme feedback.

## Scope

In: a route decision in the planner, a server-side gate before any SQL runs, a read-only database connection in the app, deterministic answer text for statistics, stats-specific filter handling, eval cases for routing and exactness.

Deferred: count-plus-quotations hybrid answers, UI work beyond the unchanged text stream, "which property gets the most complaints" without a theme (the current statistics need a theme), AI tagging, the `property_sources` mapping (see sql-plan.md conventions).

## What exists and is reused

- Planner: `lib/plan.ts` (`planQuery`, strict structured output) and `QueryPlanSchema` in `lib/schema.ts`.
- Filters and aliases: `lib/filters.ts` (`sanitizePlan`, `findCompanyAlias`, `COMPANY_ALIASES`).
- Statistics: `themeMentions`, `themeRanking`, `themeTrend` and the `StatsInputError` family in `lib/reviewStats.ts`. They accept any client with `query`, so a `pg` Pool works.
- Events and wire format: `AnswerEvent` in `lib/answer.ts`, `lib/askWire.ts` (a drift guard fails `tsc` when the event union and its schema differ; the client already tolerates unknown event types).
- Eval harness: `scripts/eval.ts`, `lib/evalMetrics.ts`, `evals/dataset.json` (28 cases, fixed `today`).
- `pg` is on Next.js's default server-external list, so `next.config.ts` needs no change.

## Decisions

1. **The planner chooses the route; code decides everything after.** `QueryPlanSchema` gains `route: "retrieval" | "statistics"` and a nullable `stat: { kind: mentions | ranking | trend, theme, sentiment }` (every key nullable, as strict output requires). The planner prompt lists the theme slugs with one-line meanings (check-in maps to front-desk, cleanliness to housekeeping) and explicit boundary rules: counts, rankings, "most/least", "how many", "changed over time" go to statistics; "what do guests say/praise/complain about" stays retrieval. The model supplies filters and a theme and never writes SQL.

2. **A pure gate sits between plan and SQL.** `resolveRoute(plan, knownThemes)` returns `statistics`, or a reason to fall back to retrieval, with a visible note. Fallbacks: theme missing or not a known slug (never guess a nearest theme); a trend without a contiguous `since`/`until`; a trend combined with a `months` filter ("winter" has no single previous period). The fallback is the existing retrieval path plus a note that the figure cannot be counted exactly. A sampled number is never presented as a count.

3. **Statistics handle properties differently from retrieval, on purpose.** `sanitizePlan` silently drops unknown property names, which suits retrieval but would broaden a count to all properties. The statistics route uses the planner's raw names: an unknown name returns "no property named X" (`UnknownPropertyError`); a company alias (BCP) means all properties only when no specific property is named. Windows are local dates in the property's timezone. Qdrant's `month` field is UTC, so a statistics count and a retrieval sample can differ near month boundaries; this stays documented, not hidden.

4. **Fixed data scope.** Statistics always use one `tagSource` and `taxonomyVersion` (constants `manual` and `v1`, overridable by env) and `source: "google_business_profile"`, so synthetic practice data can never reach a user's answer. Every answer carries the coverage numbers (total, text, tagged, stale, untagged) and a "provisional tags" caveat while the taxonomy is provisional.

5. **Numbers are rendered by code, never narrated by the model.** `renderStats(result)` is deterministic: counts per property, window dates, change and percent, a coverage sentence. It is emitted as `delta` events so the existing UI and CLI show it unchanged, plus a structured `stats` event for later UI use. The model cannot alter a number it never writes.

6. **Read-only connection in the app.** `lib/db/readonlyPool.ts` builds a `pg` Pool lazily from `DATABASE_URL_READONLY`, cached on `globalThis` so Next dev reloads do not leak connections. If the variable is missing, the statistics route is unavailable and the question falls back to retrieval with a note. `StatsInputError` subclasses map to fixed user-facing messages; raw SQL errors never reach the user.

## Eval (where this succeeds or fails)

Add `expectedRoute` (and `expectedStat`) to `evals/dataset.json` and score route correctness in `scripts/eval.ts`. New cases, with exact numbers worked out by hand from `data/manual-tags.json`:

- Statistics: "how many reviews mention parking"; a theme-per-property question (housekeeping complaints); top themes for the portfolio; "has check-in feedback changed over the last year" (fixed `today`); a BCP-wide count.
- Boundary, must stay retrieval: "what do guests say about parking", reusable phrases and quotes, "what do families say".
- Must fall back honestly: unknown theme ("how many mention the thermal pool"), unknown property, a "winter" trend.
- Existing q03 and q04 are re-labelled. q21 ("which property gets the most complaints") has no theme and stays retrieval with the honest fallback.

Metrics: route accuracy (target 100% on labelled boundary cases), exactness (the rendered text contains the hand-computed numbers), and no retrieval answer presenting a sample figure as a count. Compare with the current 26/28 and report the q04/q05 judge misses separately.

## Tests

- Pure (no database, no OpenAI): `resolveRoute` fallbacks; `renderStats` for each result shape (zero counts, `percent: null`, coverage); error-to-message mapping.
- Integration (disposable database, synthetic data, existing pattern): `answerQuestion` with a stubbed planner returns the exact text for a hand-computed case; an unknown property yields the error and never broadens; a missing `DATABASE_URL_READONLY` falls back to retrieval.
- Real stack: the eval cases above.

## Files

`lib/schema.ts`, `lib/plan.ts`, new `lib/route.ts`, new `lib/statsAnswer.ts`, new `lib/db/readonlyPool.ts`, `lib/answer.ts`, `lib/askWire.ts`, `scripts/ask.ts`, `scripts/eval.ts`, `lib/evalMetrics.ts`, `evals/dataset.json`, plus status text in `docs/project-scope.md` and the README.

## Risks

- **Misrouting.** A qualitative question sent to SQL returns a bare number; the reverse keeps today's behaviour. Hence boundary cases in both directions and a fallback that never fabricates a count.
- **Numbers are only as good as the tags.** Today that is 8 fictional fixtures. Answers say "provisional" and show coverage. Real value arrives with AI tagging, which needs marketing's theme list first.
- **UTC vs local month** mismatch between Qdrant and SQL (decision 3).

## Verification

`npx tsc --noEmit`; `npx vitest run` with and without `DATABASE_URL_TEST`; `npm run ask -- "how many reviews mention parking?"` shows the statistics route, the exact count and coverage; `npm run ask -- "what do guests say about parking?"` still cites reviews; `npm run eval` shows route accuracy and exactness on the new cases with no regression against 26/28; run `npm run dev`, ask one question of each kind in the browser, and confirm the text renders and the stream completes.

## Open questions

- Which tag source to trust once AI tagging exists (manual vs llm), and when to flip the default.
- Whether a count-plus-quotations answer is worth a second slice once routing is proven.
- Marketing's review of the provisional theme list, which changes the glossary the planner uses.
