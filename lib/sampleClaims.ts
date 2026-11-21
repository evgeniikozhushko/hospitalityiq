/**
 * Known wordings that turn a handful of search results into a statement about all reviews:
 * "the only review that mentions parking", "the other reviews do not mention families",
 * "there are only two of them", "the Lodge gets the most complaints".
 *
 * A retrieval answer is written from the reviews a search returned. Those do not establish
 * complete coverage, so such a sentence reads as a count the model was never able to make
 * (docs/adr/0001: counts never pass through the model).
 *
 * This is a check for known patterns, not semantic detection: it will miss a claim worded
 * some other way. Pure (no env or client imports); used by the pipeline at runtime and by
 * the eval, so both grade the same thing.
 */

export type ClaimKind = "exclusive" | "remainder" | "quantity";
export type Claim = { kind: ClaimKind; sentence: string };

const straighten = (s: string) => s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"');

/**
 * Guest wording inside quote marks is evidence, not the model's own claim: a quoted
 * "the only downside was the parking" must not be flagged. Markdown emphasis goes too.
 */
function withoutQuotes(text: string): string {
  return straighten(text)
    .replace(/[*_]/g, "")
    .replace(/"[^"\n]*"/g, '""');
}

/** Lines, then sentences. A citation such as [2] may close a sentence. */
export function sentencesOf(text: string): string[] {
  return withoutQuotes(text)
    .split(/\n+/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""))
    .flatMap((line) => line.split(/(?<=[.!?\]])\s+(?=[A-Z"[])/))
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * The claim is about the reviews that were retrieved, and says so about the reviews
 * themselves: "the 8 reviews shown", "among the 8 most relevant reviews", "the other two
 * sampled reviews", "reviews in this sample". A bare "sample" elsewhere in the sentence
 * ("based on this sample, the only complaint is…") does not scope the claim, and neither
 * does a sample statement in some earlier sentence.
 */
const SCOPED = new RegExp(
  [
    String.raw`\b(?:reviews?|ones?|comments?) (?:shown|provided|below|above|here|retrieved|sampled|in (?:this|the) sample)\b`,
    String.raw`\b(?:sampled|shown|provided|retrieved) (?:[\w-]+ )?reviews?\b`,
    String.raw`\b(?:among|of|in|across|from) (?:the|these|those) (?:\d+ (?:most relevant |relevant )?|most relevant |relevant )(?:[\w-]+ ){0,3}?reviews?\b`,
  ].join("|"),
  "i",
);

const NUMBER = String.raw`(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+|a single|a couple of|a few)`;
const SEVERAL = String.raw`(?:two|three|four|five|six|seven|eight|nine|ten|[2-9]|\d{2,})`;
const NOT = String.raw`(?:do not|don't|does not|doesn't|did not|didn't|not|no|none|nothing|without)`;

const PATTERNS: Array<[ClaimKind, RegExp]> = [
  // "the only review that…", "is the only one that…", "the only downside", "the only family-specific comment"
  ["exclusive", /\bthe only\b/i],
  // "only one review", "mention parking only in one review", "only directly mentioned in one review", "there are only two of them"
  [
    "exclusive",
    new RegExp(String.raw`(?<!\bcan )(?<!\bcould )\bonly\b[^.;]{0,40}?\b${NUMBER} (?:[\w-]+ ){0,2}?(?:reviews?|guests?|comments?|mentions?|of them)\b`, "i"),
  ],
  // "just one review", "a single review mentions"
  ["exclusive", new RegExp(String.raw`\b(?:just|merely) ${NUMBER} (?:[\w-]+ ){0,2}?(?:reviews?|guests?|comments?|mentions?)\b`, "i")],
  // "guests only mention that parking was tight"
  ["exclusive", /\b(?:guests?|reviews?|reviewers?|families|visitors?) only (?:mention|say|talk|note|describe|complain|praise)/i],
  // "the other reviews do not mention parking", "the other reviews talk about the massage, not the pool"
  ["remainder", new RegExp(String.raw`\b(?:other|remaining) (?:[\w-]+ ){0,4}?reviews?\b[^.;]*?\b${NOT}\b`, "i")],
  ["remainder", new RegExp(String.raw`\bthe rest (?:of the reviews )?${NOT}\b`, "i")],
  // "no other review mentions it", "none of the other reviews", "nowhere else"
  ["remainder", /\bno other (?:reviews?|guests?|comments?|mentions?|complaints?)\b/i],
  ["remainder", /\bnone of the other\b/i],
  ["remainder", /\bnowhere else\b/i],
  // "most guests", "several reviews", "the majority of reviewers" (not "how many reviews", a refusal)
  ["quantity", /\b(?:most|(?<!\bhow )many|several|few|(?:the|a) majority of) (?:of the )?(?:reviews|guests|reviewers|visitors)\b/i],
  // "three reviews mention", "5 guests complain"
  [
    "quantity",
    new RegExp(String.raw`\b${SEVERAL} (?:of the )?(?:reviews|guests|reviewers) (?:mention|say|complain|praise|report|note|describe|talk)`, "i"),
  ],
];

/**
 * Sentences that state how many reviews say something without scoping the claim to the
 * retrieved reviews. "One review says X [3]" and "Another guest…" are not claims about the
 * rest of the reviews and pass. So does a plain coverage statement ("the reviews don't
 * cover breakfast"), which the answer prompt asks for.
 */
export function sampleCountClaims(text: string): Claim[] {
  const claims: Claim[] = [];
  for (const sentence of sentencesOf(text)) {
    if (SCOPED.test(sentence)) continue;
    const hit = PATTERNS.find(([, re]) => re.test(sentence));
    if (hit) claims.push({ kind: hit[0], sentence });
  }
  return claims;
}

// ---------------------------------------------------------------------------
// Ranking properties from search results
// ---------------------------------------------------------------------------

const RANKS = /\b(?:most|fewest|fewer|more|least|highest|lowest)\b(?! relevant)[^.;]{0,25}?\b(?:complain\w*|mentions?|issues?|problems?|negative|criticis\w*|comments?|praise)\b/i;
/** A refusal, when it comes before the ranking word: "cannot show which property gets the most complaints". */
const REFUSES = /\b(?:cannot|can't|can not|could not|couldn't|unable to|not possible|impossible|not enough|too small|too few|no way to|do(?:es)? not (?:show|establish|tell|say|reveal|prove)|doesn't (?:show|establish|tell|say|reveal|prove)|don't (?:show|establish|tell|say|reveal|prove)|not (?:able|clear))\b/i;

/**
 * Sentences that rank or compare properties by how much is said about them ("X appears to
 * get the most complaints", "Y has fewer complaint mentions"). Scoping to the sample does
 * not excuse these: a hedged ranking from eight search results is still a ranking. A
 * refusal passes, but only where the refusal comes before the ranking word in its clause,
 * so "X gets the most complaints, but the sample is too small" is still flagged.
 */
export function rankingClaims(text: string): string[] {
  return sentencesOf(text).filter((sentence) =>
    sentence.split(/;|,? (?:but|however|although|though|yet|while|whereas)\b/i).some((clause) => {
      const m = RANKS.exec(clause);
      return m !== null && !REFUSES.test(clause.slice(0, m.index));
    }),
  );
}

// ---------------------------------------------------------------------------
// The disclosure code appends at runtime
// ---------------------------------------------------------------------------

const CAVEAT_START = "Note: this answer is written from ";

/**
 * Appended by code when the finished answer contains one of the wordings above. Streamed
 * text cannot be taken back, so this discloses the limit; it does not correct the claim.
 * The eval grades the model's text without it (splitCaveat), so a slip still fails there.
 */
export function sampleCaveat(reviewCount: number): string {
  const shown = reviewCount === 1 ? "the 1 review" : `the ${reviewCount} reviews`;
  return `${CAVEAT_START}${shown} a search returned, which may not be every review on the topic. It cannot show how many reviews mention something, or which property has the most.`;
}

/** Split the code-written caveat off the end of an answer. */
export function splitCaveat(answer: string): { text: string; caveat: string | null } {
  const at = answer.lastIndexOf(`\n\n${CAVEAT_START}`);
  if (at < 0) return { text: answer, caveat: null };
  const caveat = answer.slice(at + 2);
  // Only the final paragraph counts: the same words mid-answer are the model's own text.
  if (caveat.includes("\n")) return { text: answer, caveat: null };
  return { text: answer.slice(0, at), caveat };
}
