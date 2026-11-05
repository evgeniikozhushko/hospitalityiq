/**
 * Removes personal data from review text before it is embedded.
 * Runs on every review, so nothing sensitive reaches OpenAI or Qdrant.
 *
 * Covered: emails, phone numbers, booking/confirmation/reservation numbers,
 * card-like digit runs. Not covered (by design, revisit with the team):
 * staff first names ("Sarah at the front desk was great"), which marketing
 * may want to keep for recognition.
 */

const PATTERNS: Array<[RegExp, string]> = [
  // Emails
  [/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[EMAIL]"],
  // Booking / confirmation / reservation references, e.g. "confirmation #ABC12345"
  [
    /\b(booking|confirmation|reservation|conf\.?|res\.?)\s*(number|no\.?|#|code)?\s*[:#]?\s*[A-Z0-9-]{5,}\b/gi,
    "[BOOKING_REF]",
  ],
  // Card-like runs of 13-19 digits (with optional spaces/dashes)
  [/\b(?:\d[ -]?){13,19}\b/g, "[NUMBER]"],
  // Phone numbers, e.g. (403) 555-0123, 403-555-0123, +1 403 555 0123
  [/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[PHONE]"],
];

export function sanitize(text: string): string {
  let out = text;
  for (const [pattern, replacement] of PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out.replace(/\s{2,}/g, " ").trim();
}
