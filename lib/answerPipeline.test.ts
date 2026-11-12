/**
 * Routing in the answer pipeline without a database: every external call is stubbed.
 * Exact counts against real SQL are in answerPipeline.db.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { answerWith, type AnswerDeps, type AnswerEvent, type StatsDb } from "./answerPipeline";
import { FALLBACK_SUFFIX } from "./route";
import { DECLINE_MESSAGES, EMPTY_FILTERS, type PlannerOutput, type Source } from "./schema";
import { STATS_UNAVAILABLE_NOTE } from "./statsAnswer";

const SOURCE: Source = {
  n: 1,
  reviewId: "r1",
  propertyName: "Lodge",
  propertyType: "hotel",
  rating: 4,
  createdAt: "2026-01-05T10:00:00Z",
  text: "Parking was easy.",
  score: 0.9,
};

const statsPlan = (p: Partial<PlannerOutput> = {}): PlannerOutput => ({
  intent: "review_insight",
  mode: "specific",
  searchQuery: "parking",
  filters: EMPTY_FILTERS,
  route: "statistics",
  stat: { kind: "mentions", themes: ["parking"], topic: "parking", sentiment: null },
  ...p,
});

function deps(plan: PlannerOutput, over: Partial<AnswerDeps> = {}) {
  const d = {
    listProperties: vi.fn(async () => ["Lodge"]),
    plan: vi.fn(async () => plan),
    retrieve: vi.fn(async () => ({ sources: [SOURCE], relaxed: false })),
    streamAnswer: vi.fn(async function* () {
      yield "MODEL ANSWER";
    }),
    statsDb: vi.fn(() => null),
    stats: { tagSource: "manual" as const, taxonomyVersion: "v1", source: "google_business_profile", provisional: true },
    today: "2026-11-10",
    logError: vi.fn(),
    ...over,
  } satisfies AnswerDeps;
  return d;
}

async function run(d: AnswerDeps) {
  const events: AnswerEvent[] = [];
  for await (const e of answerWith("q", d)) events.push(e);
  const text = events.flatMap((e) => (e.type === "delta" ? [e.text] : [])).join("");
  return { events, types: events.map((e) => e.type), text };
}

describe("answerWith: questions that never touch the database", () => {
  it("keeps a retrieval question on retrieval, with no note", async () => {
    const d = deps(statsPlan({ route: "retrieval", stat: null }));
    const { types, text } = await run(d);
    expect(types).toEqual(["plan", "sources", "delta", "done"]);
    expect(text).toBe("MODEL ANSWER");
    expect(d.statsDb).not.toHaveBeenCalled();
    expect(vi.mocked(d.retrieve).mock.calls[0][0].mode).toBe("specific");
  });

  it("declines a non-review intent even when the planner chose statistics", async () => {
    const d = deps(statsPlan({ intent: "financial" }));
    const { events } = await run(d);
    expect(events[1]).toEqual({ type: "declined", intent: "financial", message: DECLINE_MESSAGES.financial });
    expect(d.statsDb).not.toHaveBeenCalled();
    expect(d.retrieve).not.toHaveBeenCalled();
  });

  it("passes today to the planner", async () => {
    const d = deps(statsPlan({ route: "retrieval", stat: null }));
    await run(d);
    expect(d.plan).toHaveBeenCalledWith("q", ["Lodge"], "2026-11-10");
  });

  it("includes the route in the plan event", async () => {
    const { events } = await run(deps(statsPlan()));
    expect(events[0]).toMatchObject({ type: "plan", plan: { route: "statistics", stat: { kind: "mentions" } } });
  });
});

describe("answerWith: infrastructure failures fall back to retrieval", () => {
  it("falls back with a note when no read-only database is configured", async () => {
    const d = deps(statsPlan());
    const { types, text } = await run(d);
    expect(types).toEqual(["plan", "sources", "delta", "delta", "done"]);
    expect(text).toBe(`${STATS_UNAVAILABLE_NOTE}\n\nMODEL ANSWER`);
    expect(vi.mocked(d.retrieve).mock.calls[0][0].mode).toBe("aggregate");
    expect(d.logError).toHaveBeenCalledOnce();
  });

  it("falls back when the database is unreachable, logging but never showing the error", async () => {
    const db = { query: vi.fn(async () => Promise.reject(new Error("connect ECONNREFUSED 127.0.0.1:5433"))) } as unknown as StatsDb;
    const d = deps(statsPlan(), { statsDb: vi.fn(() => db) });
    const { text } = await run(d);
    expect(text).toBe(`${STATS_UNAVAILABLE_NOTE}\n\nMODEL ANSWER`);
    expect(text).not.toMatch(/ECONNREFUSED/);
    expect(d.logError).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ message: expect.stringMatching(/ECONNREFUSED/) }));
  });

  it("tells the model nothing about counts: the note is shown, not prompted", async () => {
    const d = deps(statsPlan());
    await run(d);
    expect(vi.mocked(d.streamAnswer).mock.calls[0][0].input).not.toContain(STATS_UNAVAILABLE_NOTE);
  });

  it("still shows no-data when the fallback search finds nothing", async () => {
    const d = deps(statsPlan(), { retrieve: vi.fn(async () => ({ sources: [], relaxed: false })) });
    const { types } = await run(d);
    expect(types).toEqual(["plan", "no_data", "done"]);
  });
});

describe("answerWith: gate fallbacks use the themes from the database", () => {
  const themesDb = {
    query: vi.fn(async (sql: string) => {
      if (/FROM themes/.test(sql)) {
        return { rows: [{ slug: "parking", label: "Parking" }, { slug: "food", label: "Food" }, { slug: "other", label: "Other" }] };
      }
      throw new Error(`unexpected query: ${sql}`);
    }),
  } as unknown as StatsDb;

  it("falls back with the gate's note for a topic narrower than a theme", async () => {
    const d = deps(statsPlan({ stat: { kind: "mentions", themes: [], topic: "breakfast", sentiment: null } }), {
      statsDb: vi.fn(() => themesDb),
    });
    const { text } = await run(d);
    expect(text).toBe(
      `I can only count broad themes (Parking, Food), not breakfast specifically. ${FALLBACK_SUFFIX}\n\nMODEL ANSWER`,
    );
    expect(vi.mocked(d.retrieve).mock.calls[0][0].mode).toBe("aggregate");
    expect(d.logError).not.toHaveBeenCalled();
  });
});
