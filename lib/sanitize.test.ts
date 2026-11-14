import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { sanitize } from "./sanitize";

describe("sanitize", () => {
  it("redacts emails", () => {
    expect(sanitize("Email me at test.guest@example.com please")).toBe(
      "Email me at [EMAIL] please",
    );
  });

  it("redacts booking references", () => {
    expect(sanitize("confirmation #BK48213977 for reference")).toBe("[BOOKING_REF] for reference");
    expect(sanitize("Reservation code RES-77812 for reference")).toBe("[BOOKING_REF] for reference");
    expect(sanitize("my booking number: 4471-AB9 was lost")).toBe("my [BOOKING_REF] was lost");
    expect(sanitize("Booking ref 88213X")).toBe("[BOOKING_REF]");
  });

  it("redacts phone numbers", () => {
    expect(sanitize("Call me on (403) 555-0123 anytime")).toBe("Call me on [PHONE] anytime");
    expect(sanitize("or 403-555-0123")).toBe("or [PHONE]");
    expect(sanitize("or +1 403 555 0123")).toBe("or [PHONE]");
  });

  it("redacts card-like digit runs", () => {
    expect(sanitize("card 4111 1111 1111 1111 was charged twice")).toBe("card [NUMBER] was charged twice");
  });

  it("leaves ordinary review text alone", () => {
    const t = "We waited 40 minutes at check-in, room 214 was cold.";
    expect(sanitize(t)).toBe(t);
  });

  // These sentences were rewritten by an earlier pattern that needed no digit.
  it.each([
    "The restaurant was lovely and the booking process was easy.",
    "Our reservation included breakfast and the conference room was great.",
    "Booking online was simple. Confirmation email arrived quickly.",
    "The resort had a responsive front desk.",
    "Reservations are essential; our reservation was honoured without fuss.",
    "Best restaurant in Banff, booking recommended for weekends.",
    "The booking engine quoted $1,250 for 3 nights in 2025.",
    "We stayed in 2019, 2021 and 2023.",
  ])("never rewrites hospitality words: %s", (t) => {
    expect(sanitize(t)).toBe(t);
  });

  it("does not bite the tail off a longer number", () => {
    expect(sanitize("order 99914035550123")).toBe("order [NUMBER]");
    expect(sanitize("ticket 554035550123")).toBe("ticket 554035550123");
  });

  it("keeps line breaks and tidies other spacing", () => {
    expect(sanitize("Great stay.\n\nWould   return.")).toBe("Great stay.\n\nWould return.");
    expect(sanitize("One.  \r\n  Two.\n\n\n\nThree.\t\tFour. ")).toBe("One.\nTwo.\n\nThree. Four.");
  });

  // Stored text decides the text hash; a change here re-embeds reviews and marks
  // hand tags stale, so it must be deliberate.
  it("changes only what it should in the fixtures", () => {
    const changed: Record<string, string> = {};
    for (const file of ["data/sample-reviews.json", "data/synthetic/reviews.json"]) {
      const locations = JSON.parse(readFileSync(file, "utf8")) as {
        reviews: { reviewId: string; comment?: string }[];
      }[];
      for (const r of locations.flatMap((l) => l.reviews)) {
        if (r.comment && sanitize(r.comment) !== r.comment) changed[r.reviewId] = sanitize(r.comment);
      }
    }
    // The three fixtures that carry planted contact details, and nothing else.
    expect(Object.keys(changed).sort()).toEqual(["fixture-002", "fixture-003", "fixture-102"]);
    expect(changed["fixture-002"]).toMatch(/Email me at \[EMAIL\], \[BOOKING_REF\]\.$/);
    expect(changed["fixture-003"]).toContain("Call me on [PHONE] if");
    expect(changed["fixture-102"]).toContain("[BOOKING_REF] for reference.");
  });
});
