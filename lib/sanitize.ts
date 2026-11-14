/**
 * Removes personal data from review text before it is embedded.
 * Runs on every review, so nothing sensitive reaches OpenAI or Qdrant.
 *
 * Covered: emails, phone numbers, booking/confirmation/reservation numbers,
 * card-like digit runs. Not covered (by design, revisit with the team):
 * staff first names ("Sarah at the front desk was great"), which marketing
 * may want to keep for recognition.
 *
 * This text is what gets embedded, tagged, quoted and hashed, so a pattern that
 * fires on ordinary words damages every later step. Each pattern therefore needs
 * digits: words alone are never replaced.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Emails
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]"],
  // Booking / confirmation / reservation references, e.g. "confirmation #ABC12345".
  // The reference itself must contain a digit, so "booking process", "reservation
  // included" and "confirmation email" are left alone. Whole keywords only: a bare
  // "res" or "conf" prefix would match "restaurant" and "conference".
  [
    /\b(?:booking|confirmation|reservation)\s*(?:number|no\.?|#|code|ref(?:erence)?)?\s*[:#]?\s*(?=[A-Z0-9-]*\d)[A-Z0-9][A-Z0-9-]{4,}\b/gi,
    "[BOOKING_REF]",
  ],
  // Card-like runs of 13-19 digits (with optional spaces/dashes between digits)
  [/\b\d(?:[ -]?\d){12,18}\b/g, "[NUMBER]"],
  // Phone numbers, e.g. (403) 555-0123, 403-555-0123, +1 403 555 0123.
  // Not preceded by a digit, so it never bites the tail off a longer number.
  [/(?<!\d)(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[PHONE]"],
];

export function sanitize(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  // Tidy spacing but keep the guest's line breaks: paragraphs are shown as written.
  return out
    .replace(/\r\n?/g, "\n")
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/[^\S\n]*\n[^\S\n]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
