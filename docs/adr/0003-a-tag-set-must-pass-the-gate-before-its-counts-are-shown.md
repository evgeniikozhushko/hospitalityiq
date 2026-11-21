---
status: proposed
---

# A tag set must pass the gate before its counts are shown

Counts are only as right as the tags under them ([ADR 0001](0001-counts-never-pass-through-the-model.md)), and most tags will come from a model, not from people. A model's tags can look plausible and still be wrong for a whole theme. So model tags reach an answer only through a **tag set** that has passed the **gate**.

A tag set is every tag produced by one combination of taxonomy version, tagger prompt version and dated model snapshot (never an alias such as `gpt-4o-mini`, which can change underneath without notice). The gate compares a tag set with the hand labels on a fixed **gate sample** of 100 reviews and reports precision and recall for each theme. The set passes if it reaches 85% on every theme, not only overall: a tagger can score 85% overall and still be poor on a rare theme like parking. Exactly one tag set is **active** at a time. A single record in Postgres names it, counts read only from it, and only a passing gate run can switch it.

**Re-gating.** The gate is not a one-time check. Any change to the prompt, the model snapshot or the taxonomy makes a new tag set, which has to pass again before it replaces the active one. Until it does, counts keep reading from the old set. Re-running the gate is cheap, because the 100 hand labels stay the same.

## Considered options

- **Spot-check the tagger once and trust it after that.** Rejected: a later prompt or model change would alter every count without anyone looking.
- **One overall accuracy figure.** Rejected: counts are per theme, so the gate has to be per theme too.
- **Use a model alias and re-gate when results look different.** Rejected: nothing would show that the model had changed.

## Consequences

- The gate sample is never used to tune the prompt. Prompt iteration uses a separate set of 20–30 labelled reviews, or the gate score is inflated.
- The gate sample leans toward low star ratings, because complaints are what the main flow counts and a random draw is mostly five-star reviews.
- 85% is only reachable if people agree with each other at least that often. Two people label the same 20–30 reviews first. If they agree less than about 85% of the time, the threshold or the theme definitions change before any tagger is judged.
- A review whose text hash changes is stale in every tag set and is re-tagged. A review whose tags fail validation is flagged, not dropped, so it appears in coverage.
- Hand tags remain their own source and never need the gate, but they still count only when the active record points at them.
