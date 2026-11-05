import { describe, it, expect } from "vitest";
import { sanitize } from "./sanitize";

describe("sanitize", () => {
  it("redacts emails", () => {
    expect(sanitize("Email me at test.guest@example.com please")).toBe(
      "Email me at [EMAIL] please",
    );
  });

  it("redacts booking references", () => {
    expect(sanitize("confirmation #BK48213977 for reference")).toContain("[BOOKING_REF]");
    expect(sanitize("Reservation code RES-77812 for reference")).toContain("[BOOKING_REF]");
  });

  it("redacts phone numbers", () => {
    expect(sanitize("Call me on (403) 555-0123 anytime")).toBe("Call me on [PHONE] anytime");
    expect(sanitize("or 403-555-0123")).toBe("or [PHONE]");
  });

  it("leaves ordinary review text alone", () => {
    const t = "We waited 40 minutes at check-in, room 214 was cold.";
    expect(sanitize(t)).toBe(t);
  });
});
