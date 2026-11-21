---
status: proposed
---

# Campaign figures never enter the vector store

Marketing wants to ask which campaigns worked and why. A campaign has two parts: its figures (spend, bookings, direct bookings, revenue) and a written record of what was done. The figures live in Postgres, behind a database role that only the campaign statistics queries use. The written records are embedded and searched like reviews, and the vector store has no per-field permissions. Anyone, and any route, that can search the records can read whatever they contain. So a record that says "we spent $40k" would get around the separation the financial role exists to enforce, and the model could quote that figure as if it were a count.

So figures are stored only as columns in Postgres. Records are not rejected for containing one: authors write naturally, and ingest masks amounts before anything is embedded. A money amount (a currency symbol or code next to a number) becomes `[AMOUNT]` in the stored and embedded text, the same way the sanitizer replaces phone numbers, and ingest prints a warning naming the line. The Markdown file keeps the original. The record and its row share a campaign ID, so an answer can join them in code.

## Considered options

- **Figures in the record text, permissions in the prompt.** Rejected: the prompt is not a permission boundary, and the evals could only show that it held on the questions tried.
- **A separate, restricted vector collection for records that contain figures.** Rejected: it moves the problem rather than removing it. Every route that searches it would have to be trusted with figures, and a sampled figure would still read like a count, which [ADR 0001](0001-counts-never-pass-through-the-model.md) rules out.

## Consequences

- A compound question ("which winter promotion brought the most direct bookings, and why did it work?") is answered in two steps. SQL ranks the campaigns and code writes the figure, then the model explains the top campaign from its record without seeing the figure. Each campaign tied for the top is explained.
- The template asks authors to put figures in the CSV, but a figure left in the text is masked, not refused. The mask covers money amounts only. A booking count written in prose ("bookings doubled to 120") is not masked, so the warning also lists numbers near "bookings", "revenue", "spend" or "ROI" for the author to check.
- The mask is never loosened to let an amount through to the vector store.
- If records are ever loaded from a source other than the template, the same masking applies.
