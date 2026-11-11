import { describe, expect, it } from "vitest";
import { checksum, planMigrations } from "./migrate";

const f = (name: string, sql: string) => ({ name, sql });

describe("planMigrations", () => {
  it("returns files not yet applied, in filename order", () => {
    const files = [f("0002_b.sql", "b"), f("0001_a.sql", "a")];
    const applied = new Map([["0001_a.sql", checksum("a")]]);
    expect(planMigrations(files, applied).map((m) => m.name)).toEqual(["0002_b.sql"]);
  });

  it("returns nothing when everything is applied", () => {
    const files = [f("0001_a.sql", "a")];
    expect(planMigrations(files, new Map([["0001_a.sql", checksum("a")]]))).toEqual([]);
  });

  it("rejects an applied migration whose contents changed", () => {
    const files = [f("0001_a.sql", "a edited")];
    expect(() => planMigrations(files, new Map([["0001_a.sql", checksum("a")]]))).toThrow(/changed/);
  });

  it("rejects an applied migration that is missing on disk", () => {
    expect(() => planMigrations([], new Map([["0001_a.sql", "x"]]))).toThrow(/missing/);
  });

  it("ignores line-ending differences in the checksum", () => {
    expect(checksum("a\r\nb")).toBe(checksum("a\nb"));
  });
});
