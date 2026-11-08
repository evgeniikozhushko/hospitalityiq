import { describe, expect, it } from "vitest";
import { createAskController } from "./askController";
import type { FetchLike } from "./askClient";
import { askReducer, initialAskState, type AskAction, type AskState } from "./askState";
import { manualStream, ndjson, streamFrom, tick } from "./testStreams";

const delta = (text: string) => ({ type: "delta", text });
const done = { type: "done" };

type Call = { question: string; signal: AbortSignal };

function setup(handler: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const dispatched: AskAction[] = [];
  let state: AskState = initialAskState;
  const fetchImpl: FetchLike = async (_url, init) => {
    const call = {
      question: JSON.parse(String(init.body)).question as string,
      signal: init.signal as AbortSignal,
    };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  const controller = createAskController({
    dispatch(action) {
      dispatched.push(action);
      state = askReducer(state, action);
    },
    fetchImpl,
  });
  return { controller, calls, dispatched, get state() { return state; } };
}

const okStream = (...events: unknown[]) => new Response(streamFrom([ndjson(...events)]));

describe("askController", () => {
  it("runs a request to completion through the reducer", async () => {
    const t = setup(() => okStream(delta("Hi"), done));
    await t.controller.submit("hello");
    expect(t.state).toMatchObject({ status: "complete", answer: "Hi", lastQuestion: "hello" });
  });

  it("aborts a running request when a new question is submitted, and ignores its late output", async () => {
    const first = manualStream();
    const t = setup((_call, i) => (i === 0 ? new Response(first.stream) : okStream(delta("B answer"), done)));

    const p1 = t.controller.submit("A");
    await tick();
    first.push(ndjson(delta("A part")));
    await tick();
    expect(t.state.answer).toBe("A part");

    await t.controller.submit("B");
    expect(t.calls[0].signal.aborted).toBe(true);

    // late chunks, a close and an EOF from the superseded request
    first.push(ndjson(delta("A late"), done));
    first.close();
    await p1;

    expect(t.state).toMatchObject({ status: "complete", answer: "B answer", lastQuestion: "B" });
    expect(t.dispatched.filter((a) => a.type === "signal" && a.id === 1).length).toBe(1); // only "A part"
  });

  it("can submit again after completion and after an error", async () => {
    let n = 0;
    const t = setup(() => {
      n++;
      if (n === 1) return okStream(delta("one"), done);
      if (n === 2) return okStream({ type: "error", message: "boom" });
      return okStream(delta("three"), done);
    });
    await t.controller.submit("q1");
    expect(t.state.status).toBe("complete");
    await t.controller.submit("q2");
    expect(t.state).toMatchObject({ status: "error", error: "boom" });
    await t.controller.submit("q3");
    expect(t.state).toMatchObject({ status: "complete", answer: "three", error: null });
  });

  it("retry resubmits the last submitted question", async () => {
    const t = setup(() => okStream(delta("x"), done));
    await t.controller.submit("A");
    await t.controller.submit("B");
    await t.controller.retry();
    expect(t.calls.map((c) => c.question)).toEqual(["A", "B", "B"]);
    expect(t.state.lastQuestion).toBe("B");
  });

  it("retry does nothing before any submission", async () => {
    const t = setup(() => okStream(done));
    await t.controller.retry();
    expect(t.calls).toEqual([]);
    expect(t.dispatched).toEqual([]);
  });

  it("dispose aborts the active request, is idempotent, and stops all dispatches", async () => {
    const m = manualStream();
    const t = setup(() => new Response(m.stream));
    const p = t.controller.submit("A");
    await tick();
    m.push(ndjson(delta("part")));
    await tick();
    const before = t.dispatched.length;

    t.controller.dispose();
    t.controller.dispose();
    m.push(ndjson(delta("late"), done));
    m.close();
    await p;

    expect(t.calls[0].signal.aborted).toBe(true);
    expect(t.dispatched.length).toBe(before);
    // an abort is not a failure
    expect(t.state.status).toBe("streaming");
    expect(["error", "incomplete"]).not.toContain(t.state.status);

    await t.controller.submit("after dispose");
    expect(t.calls.length).toBe(1);
  });

  it("an abort of the previous request never produces an error or incomplete state", async () => {
    const m = manualStream();
    const t = setup((_call, i) => (i === 0 ? new Response(m.stream) : okStream(delta("ok"), done)));
    const p1 = t.controller.submit("A");
    await tick();
    await t.controller.submit("B");
    m.close();
    await p1;
    expect(t.state.status).toBe("complete");
    expect(t.dispatched.some((a) => a.type === "signal" && a.id === 1 && a.signal.kind !== "event")).toBe(false);
  });
});
