/**
 * Notes appended to the answer prompt when the search did not match the question
 * as asked. Kept pure (no env or client imports) so the wording and order are
 * unit-testable.
 *
 * Order is fixed: relaxed filters, unknown property, then portfolio scope. Only
 * the first note may claim "your first sentence"; later ones say "second sentence",
 * so the model never gets two competing instructions.
 */
export function buildNotes(opts: {
  relaxed: boolean;
  dropped: string[];
  portfolioAlias: string | null;
}): string {
  const { relaxed, dropped, portfolioAlias } = opts;
  const notes: string[] = [];
  let firstTaken = false;
  const slot = () => {
    const s = firstTaken ? "second" : "first";
    firstTaken = true;
    return s;
  };

  if (relaxed) {
    notes.push(
      `The requested time period or rating filter matched no reviews, so these results ignore it. Your ${slot()} sentence must say there are no reviews for that period or rating and that the answer uses reviews from other dates or ratings.`,
    );
  }
  if (dropped.length) {
    const names = dropped.join(", ");
    notes.push(
      portfolioAlias
        ? `The question also mentions ${names}, which has no reviews in our data. Your ${slot()} sentence must say there are no reviews for ${names}. Then answer from the reviews below.`
        : `The question mentions ${names}, which has no reviews in our data. Your ${slot()} sentence must say there are no reviews for ${names}. Then answer only if the reviews below are still useful, and say they are from other properties.`,
    );
  }
  if (portfolioAlias) {
    notes.push(
      `The question refers to the whole company (${portfolioAlias}), not a single property, so the reviews below cover all properties. Your ${slot()} sentence must say "Searching all properties." Do not say there are no reviews for ${portfolioAlias}.`,
    );
  }
  return notes.length ? `\n\nNotes:\n- ${notes.join("\n- ")}` : "";
}
