import { afterEach, describe, expect, it, vi } from "vitest";
import { loadAnswer, saveAnswer, type SavedAnswer } from "./askPersistence";
import { askReducer, initialAskState } from "./askState";
import { source } from "./testFixtures";

const saved: SavedAnswer = {
  version: 1,
  question: "What did guests say?",
  plan: null,
  droppedPropertyNames: ["Unknown"],
  sources: [source],
  relaxed: true,
  answer: "An answer [1]",
};

afterEach(() => vi.unstubAllGlobals());

describe("saved answers", () => {
  it("round trips an answer and restores its display state", () => {
    let value = "";
    vi.stubGlobal("sessionStorage", {
      setItem: (_key: string, text: string) => { value = text; },
      getItem: () => value,
    });
    saveAnswer(saved);
    const restored = loadAnswer();
    expect(restored).toEqual(saved);
    expect(askReducer(initialAskState, { type: "restore", saved: restored! })).toMatchObject({
      status: "complete", lastQuestion: saved.question, answer: saved.answer,
      sources: saved.sources, relaxed: true, droppedPropertyNames: ["Unknown"],
    });
  });

  it.each(["not json", JSON.stringify({ ...saved, version: 2 }), JSON.stringify({ ...saved, sources: [{}] })])(
    "ignores invalid stored data", (value) => {
      vi.stubGlobal("sessionStorage", { getItem: () => value });
      expect(loadAnswer()).toBeNull();
    },
  );

  it("continues working when storage is unavailable", () => {
    vi.stubGlobal("sessionStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
    });
    expect(loadAnswer()).toBeNull();
    expect(() => saveAnswer(saved)).not.toThrow();
  });
});
