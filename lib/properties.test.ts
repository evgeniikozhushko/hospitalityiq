import { describe, expect, it, vi } from "vitest";
import { createPropertyLister, PROPERTY_LIST_TTL_MS } from "./properties";

const down = async (): Promise<string[]> => {
  throw new Error("connection refused");
};

describe("createPropertyLister", () => {
  it("reads the database and never asks the index when the database answers", async () => {
    const fallback = vi.fn(async () => ["From Index"]);
    const list = createPropertyLister({ primary: async () => ["Lodge", "Bistro"], fallback });
    expect(await list()).toEqual(["Bistro", "Lodge"]);
    expect(fallback).not.toHaveBeenCalled();
  });

  it("sorts by code unit and removes duplicates, whatever the source returns", async () => {
    const list = createPropertyLister({ primary: async () => ["b", "Zeta", "a", "Zeta", "Écrin"], fallback: down });
    expect(await list()).toEqual(["Zeta", "a", "b", "Écrin"]);
  });

  it("uses the index when no database is configured", async () => {
    const list = createPropertyLister({ primary: null, fallback: async () => ["Lodge"] });
    expect(await list()).toEqual(["Lodge"]);
  });

  it("uses the index when the database is down, and logs it", async () => {
    const logError = vi.fn();
    const list = createPropertyLister({ primary: down, fallback: async () => ["Lodge"], logError });
    expect(await list()).toEqual(["Lodge"]);
    expect(logError).toHaveBeenCalledWith("property list unavailable from the database", expect.any(Error));
  });

  it("asks the index too when the database is empty", async () => {
    const list = createPropertyLister({ primary: async () => [], fallback: async () => ["Lodge"] });
    expect(await list()).toEqual(["Lodge"]);
  });

  it("never caches an empty list: properties appear after the first ingest without a restart", async () => {
    let names: string[] = [];
    const primary = vi.fn(async () => names);
    const list = createPropertyLister({ primary, fallback: async () => [] });
    expect(await list()).toEqual([]);
    names = ["Lodge"];
    expect(await list()).toEqual(["Lodge"]);
    expect(primary).toHaveBeenCalledTimes(2);
  });

  it("caches a non-empty list until it expires, then picks up new properties", async () => {
    let t = 0;
    let names = ["Lodge"];
    const primary = vi.fn(async () => names);
    const list = createPropertyLister({ primary, fallback: down, now: () => t });
    expect(await list()).toEqual(["Lodge"]);
    names = ["Lodge", "Spa"];
    t = PROPERTY_LIST_TTL_MS - 1;
    expect(await list()).toEqual(["Lodge"]);
    expect(primary).toHaveBeenCalledTimes(1);
    t = PROPERTY_LIST_TTL_MS;
    expect(await list()).toEqual(["Lodge", "Spa"]);
  });

  it("keeps the last good list when every source is down", async () => {
    let t = 0;
    let fail = false;
    const primary = async () => {
      if (fail) throw new Error("down");
      return ["Lodge"];
    };
    const list = createPropertyLister({ primary, fallback: down, now: () => t });
    expect(await list()).toEqual(["Lodge"]);
    fail = true;
    t = PROPERTY_LIST_TTL_MS + 1;
    expect(await list()).toEqual(["Lodge"]);
  });

  it("returns an empty list, not an error, when nothing has ever answered", async () => {
    const logError = vi.fn();
    const list = createPropertyLister({ primary: down, fallback: down, logError });
    expect(await list()).toEqual([]);
    expect(logError).toHaveBeenCalledTimes(2);
  });

  it("shares one lookup between questions that arrive together", async () => {
    const primary = vi.fn(async () => ["Lodge"]);
    const list = createPropertyLister({ primary, fallback: down });
    expect(await Promise.all([list(), list(), list()])).toEqual([["Lodge"], ["Lodge"], ["Lodge"]]);
    expect(primary).toHaveBeenCalledTimes(1);
  });
});
