import { describe, expect, it } from "vitest";
import { assertSafeTestDatabase } from "./testGuard";

const admin = "postgres://hiq_migrator:x@localhost:5433/hiq";
const readonly = "postgres://hiq_app_ro:x@localhost:5433/hiq";
const test = "postgres://hiq_migrator:x@localhost:5434/hiq_test";

describe("assertSafeTestDatabase", () => {
  it("accepts a local, separate, _test database", () => {
    expect(assertSafeTestDatabase({ admin, readonly, test }, {})).toBe(test);
  });

  it("requires DATABASE_URL_TEST", () => {
    expect(() => assertSafeTestDatabase({ admin }, {})).toThrow(/not set/);
  });

  it("rejects the admin database", () => {
    expect(() => assertSafeTestDatabase({ admin, test: admin }, {})).toThrow(/ADMIN/);
  });

  it("rejects the read-only database even under another user", () => {
    const sameDb = "postgres://someone:x@localhost:5433/hiq";
    expect(() => assertSafeTestDatabase({ readonly, test: sameDb }, {})).toThrow(/READONLY/);
  });

  it("rejects a remote host named hiq_test", () => {
    const remote = "postgres://u:x@db.example.com:5432/hiq_test";
    expect(() => assertSafeTestDatabase({ admin, test: remote }, {})).toThrow(/not local/);
  });

  it("allows a remote host only with the explicit override", () => {
    const remote = "postgres://u:x@db.example.com:5432/hiq_test";
    expect(assertSafeTestDatabase({ admin, test: remote }, { HIQ_ALLOW_REMOTE_TEST_DB: "1" })).toBe(
      remote,
    );
  });

  it("rejects a database name that does not end in _test", () => {
    expect(() =>
      assertSafeTestDatabase({ test: "postgres://u:x@localhost:5434/scratch" }, {}),
    ).toThrow(/_test/);
  });

  it("rejects an invalid URL", () => {
    expect(() => assertSafeTestDatabase({ test: "not a url" }, {})).toThrow(/valid URL/);
  });
});
