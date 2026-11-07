import { describe, it, expect, vi } from "vitest";
import { retrieve, TOP_K, type RetrieveDeps, type SearchHit } from "./retrieve";
import { EMPTY_FILTERS, type QueryPlan } from "./schema";

const hit: SearchHit = {
  score: 0.8,
  payload: {
    reviewId: "r1",
    propertyName: "Sample Mountain Lodge",
    propertyType: "hotel",
    rating: 2,
    createdAt: "2026-01-29T03:10:00Z",
    text: "Room was cold",
  },
};

const plan = (filters: Partial<QueryPlan["filters"]>, mode: QueryPlan["mode"] = "specific"): QueryPlan => ({
  intent: "review_insight",
  mode,
  searchQuery: "cold room",
  filters: { ...EMPTY_FILTERS, ...filters },
});

function deps(...responses: SearchHit[][]) {
  const search = vi.fn<RetrieveDeps["search"]>();
  for (const r of responses) search.mockResolvedValueOnce(r);
  return { embed: async () => [[0.1, 0.2]], search };
}

describe("retrieve", () => {
  it("returns numbered sources without retrying when the first search hits", async () => {
    const d = deps([hit]);
    const res = await retrieve(plan({ months: [1] }), d);
    expect(d.search).toHaveBeenCalledTimes(1);
    expect(res.relaxed).toBe(false);
    expect(res.sources[0]).toMatchObject({ n: 1, reviewId: "r1", rating: 2 });
  });

  it("retries once with property filters only when a date filter finds nothing", async () => {
    const d = deps([], [hit]);
    const res = await retrieve(plan({ propertyTypes: ["hotel"], since: "2020-01-01", months: [7] }), d);
    expect(d.search).toHaveBeenCalledTimes(2);
    expect(d.search.mock.calls[1][0].filter).toEqual({
      must: [{ key: "propertyType", match: { any: ["hotel"] } }],
    });
    expect(res.relaxed).toBe(true);
    expect(res.sources).toHaveLength(1);
  });

  it("does not retry when only property filters were set", async () => {
    const d = deps([]);
    const res = await retrieve(plan({ propertyTypes: ["theatre"] }), d);
    expect(d.search).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ sources: [], relaxed: false });
  });

  it("uses a wider limit for aggregate questions", async () => {
    const d = deps([hit]);
    await retrieve(plan({}, "aggregate"), d);
    expect(d.search.mock.calls[0][0].limit).toBe(TOP_K.aggregate);
  });
});
