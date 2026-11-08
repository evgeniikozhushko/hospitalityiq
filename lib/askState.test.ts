import { describe, expect, it } from "vitest";
import { askReducer, initialAskState, isTerminal, type AskAction, type AskState } from "./askState";
import type { AskEvent } from "./askWire";
import type { TransportSignal } from "./askClient";
import { EMPTY_FILTERS } from "./schema";
import { source } from "./testFixtures";

const reviewPlan = {
  intent: "review_insight" as const,
  mode: "aggregate" as const,
  searchQuery: "q",
  filters: EMPTY_FILTERS,
};

const submit = (id: number, question = `q${id}`): AskAction => ({ type: "submit", id, question });
const sig = (id: number, signal: TransportSignal): AskAction => ({ type: "signal", id, signal });
const ev = (id: number, event: AskEvent) => sig(id, { kind: "event", event });
const apply = (actions: AskAction[], from: AskState = initialAskState) => actions.reduce(askReducer, from);

const plan = (id: number) => ev(id, { type: "plan", plan: reviewPlan, droppedPropertyNames: ["X"] });
const sources = (id: number, relaxed = false) => ev(id, { type: "sources", sources: [source], relaxed });
const delta = (id: number, text: string) => ev(id, { type: "delta", text });
const done = (id: number) => ev(id, { type: "done" });

describe("answer path", () => {
  it("walks connecting -> planned -> sources -> streaming -> complete", () => {
    let s = apply([submit(1, "hello")]);
    expect(s).toMatchObject({ status: "connecting", activeId: 1, lastQuestion: "hello" });
    s = apply([plan(1)], s);
    expect(s).toMatchObject({ status: "planned", droppedPropertyNames: ["X"] });
    s = apply([sources(1, true)], s);
    expect(s).toMatchObject({ status: "sources", relaxed: true, sources: [source] });
    s = apply([delta(1, "Hel"), delta(1, "lo")], s);
    expect(s).toMatchObject({ status: "streaming", answer: "Hello" });
    s = apply([done(1)], s);
    expect(s.status).toBe("complete");
    expect(s.answer).toBe("Hello");
  });

  it("settles declined and no_data on arrival with the server message", () => {
    const declined = apply([
      submit(1),
      plan(1),
      ev(1, { type: "declined", intent: "campaign", message: "not yet" }),
    ]);
    expect(declined).toMatchObject({ status: "declined", message: "not yet" });
    const noData = apply([submit(1), plan(1), ev(1, { type: "no_data", message: "none" })]);
    expect(noData).toMatchObject({ status: "no_data", message: "none" });
  });

  it("does not flip declined or no_data to incomplete/complete on the trailing done or stream_end", () => {
    const declined = apply([submit(1), ev(1, { type: "declined", intent: "off_topic", message: "m" })]);
    expect(apply([done(1)], declined).status).toBe("declined");
    expect(apply([sig(1, { kind: "stream_end" })], declined).status).toBe("declined");
    const noData = apply([submit(1), ev(1, { type: "no_data", message: "m" })]);
    expect(apply([done(1)], noData).status).toBe("no_data");
    expect(apply([sig(1, { kind: "stream_end" })], noData).status).toBe("no_data");
  });
});

describe("failures keep partial state", () => {
  const partial = [submit(1), plan(1), sources(1), delta(1, "partial")];

  it.each([
    ["an error event", ev(1, { type: "error", message: "boom" }), "boom"],
    ["http_error", sig(1, { kind: "http_error", message: "h" }), "h"],
    ["network_error", sig(1, { kind: "network_error", message: "n" }), "n"],
    ["protocol_error", sig(1, { kind: "protocol_error", message: "p" }), "p"],
  ])("%s gives error and keeps the partial answer and sources", (_name, action, message) => {
    const s = apply([...partial, action]);
    expect(s).toMatchObject({ status: "error", error: message, answer: "partial", sources: [source] });
  });

  it("stream_end gives incomplete and keeps the partial answer", () => {
    const s = apply([...partial, sig(1, { kind: "stream_end" })]);
    expect(s).toMatchObject({ status: "incomplete", answer: "partial", sources: [source] });
  });
});

describe("guards", () => {
  it("ignores actions from a stale request id", () => {
    const s = apply([submit(1), submit(2), plan(1), delta(1, "old"), sig(1, { kind: "stream_end" })]);
    expect(s).toMatchObject({ activeId: 2, status: "connecting", answer: "", plan: null });
  });

  it("ignores every action after a terminal status", () => {
    const terminal = apply([submit(1), delta(1, "a"), done(1)]);
    expect(isTerminal(terminal.status)).toBe(true);
    for (const action of [
      delta(1, "more"),
      plan(1),
      sources(1),
      sig(1, { kind: "network_error", message: "x" }),
      sig(1, { kind: "stream_end" }),
      ev(1, { type: "error", message: "x" }),
    ]) {
      expect(askReducer(terminal, action)).toBe(terminal);
    }
  });

  it("ignores signals before any submission", () => {
    expect(askReducer(initialAskState, delta(0, "x"))).toBe(initialAskState);
  });
});

describe("submit is handled before the guards", () => {
  const dirty = (finish: AskAction[]) =>
    apply([submit(1, "first"), plan(1), sources(1, true), delta(1, "text"), ...finish]);

  const cases: [string, AskState][] = [
    ["complete", dirty([done(1)])],
    ["error", dirty([ev(1, { type: "error", message: "boom" })])],
    ["incomplete", dirty([sig(1, { kind: "stream_end" })])],
    ["declined", apply([submit(1), ev(1, { type: "declined", intent: "campaign", message: "m" })])],
    ["no_data", apply([submit(1), ev(1, { type: "no_data", message: "m" })])],
    ["streaming (mid-stream)", dirty([])],
  ];

  it.each(cases)("starts a clean new request after %s", (_name, before) => {
    const after = askReducer(before, submit(2, "second"));
    expect(after).toEqual({
      ...initialAskState,
      activeId: 2,
      lastQuestion: "second",
      status: "connecting",
    });
    // and the new request then works normally
    expect(apply([delta(2, "new")], after)).toMatchObject({ status: "streaming", answer: "new" });
  });
});
