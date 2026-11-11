---
status: accepted
---

# Counts never pass through the model

Marketing asks counting and trend questions ("how many reviews mention parking", "has check-in feedback changed over the last year"), and a wrong number looks exactly like a right one. So every count comes from fixed, parameterised SQL (`lib/reviewStats.ts`) and is turned into text by deterministic code. The model only picks the route, the theme and the filters, and code checks those before any SQL runs. It never writes SQL, and it never states or rewrites a number. If a question can't be counted exactly (unknown theme, a topic narrower than a theme, no continuous date range, database unavailable), the answer falls back to a qualitative answer from a sample of reviews and says it couldn't count. It never estimates.

## Considered options

- **Text-to-SQL.** Rejected: it's flexible, but it lets the model widen a scope silently (dropping an unknown property, mixing tag sources) in ways that look correct, and it puts model output on the path to the database.
- **SQL results narrated by the model.** Rejected: it reads better, but the model can round numbers, mix them up or embellish them, and evals would have to catch every such slip instead of it being impossible.

## Consequences

- Statistics answers read as fixed templates. A friendlier tone is a rendering change, not a prompt change.
- Every new kind of question (several themes at once, a property ranking with no theme, a count combined with quotes) needs a new fixed query and renderer, so expanding is a code change each time.
- Each review is counted once per theme, and every count carries its coverage (how many reviews are tagged), so "not tagged yet" can't read as "not mentioned".
