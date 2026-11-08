import { describe, expect, it } from "vitest";
import { askStream, type FetchLike, type TransportSignal } from "./askClient";
import { EMPTY_FILTERS } from "./schema";
import { collect, failingStream, manualStream, ndjson, streamFrom, tick } from "./testStreams";

const plan = {
  type: "plan",
  plan: { intent: "review_insight", mode: "specific", searchQuery: "q", filters: EMPTY_FILTERS },
  droppedPropertyNames: [],
};
const delta = (text: string) => ({ type: "delta", text });
const done = { type: "done" };

const respond = (body: ReadableStream<Uint8Array> | null, init: ResponseInit = { status: 200 }): FetchLike =>
  async () => new Response(body, init);

const run = (fetchImpl: FetchLike, signal = new AbortController().signal) =>
  collect(askStream("what do guests say?", { signal, fetchImpl }));

const kinds = (signals: TransportSignal[]) =>
  signals.map((s) => (s.kind === "event" ? s.event.type : s.kind));

describe("askStream: success and terminal events", () => {
  it("streams events through to done", async () => {
    const out = await run(respond(streamFrom([ndjson(plan, delta("a"), delta("b"), done)])));
    expect(kinds(out)).toEqual(["plan", "delta", "delta", "done"]);
  });

  it("sends the question as JSON", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    await run(async (url, init) => {
      seen = { url, init };
      return new Response(streamFrom([ndjson(done)]));
    });
    expect(seen?.url).toBe("/api/ask");
    expect(seen?.init.method).toBe("POST");
    expect(JSON.parse(String(seen?.init.body))).toEqual({ question: "what do guests say?" });
  });

  it("treats an error event as terminal and yields nothing after it", async () => {
    const out = await run(respond(streamFrom([ndjson(delta("a"), { type: "error", message: "x" }, delta("b"))])));
    expect(kinds(out)).toEqual(["delta", "error"]);
  });

  it("stops after done and cancels the reader", async () => {
    const spy = { cancelled: 0 };
    const out = await run(respond(streamFrom([ndjson(done, delta("late"))], spy, { open: true })));
    expect(kinds(out)).toEqual(["done"]);
    expect(spy.cancelled).toBe(1);
  });

  it("yields stream_end when the body ends with no terminal event", async () => {
    const out = await run(respond(streamFrom([ndjson(plan, delta("partial"))])));
    expect(kinds(out)).toEqual(["plan", "delta", "stream_end"]);
  });

  it("skips unknown events and keeps reading", async () => {
    const out = await run(respond(streamFrom([ndjson({ type: "heartbeat" }, delta("a"), done)])));
    expect(kinds(out)).toEqual(["delta", "done"]);
  });
});

describe("askStream: errors", () => {
  it("reports a 400 with its JSON error message", async () => {
    const out = await run(async () => Response.json({ error: "Question too short" }, { status: 400 }));
    expect(out).toEqual([{ kind: "http_error", message: "Question too short" }]);
  });

  it("reports a 500 with an HTML body using a generic message", async () => {
    const out = await run(respond(null, { status: 500 }));
    expect(out).toEqual([{ kind: "http_error", message: "Request failed (500)." }]);
    const html = await run(async () => new Response("<html>oops</html>", { status: 502 }));
    expect(html).toEqual([{ kind: "http_error", message: "Request failed (502)." }]);
  });

  it("reports a rejected fetch as network_error", async () => {
    const out = await run(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(kinds(out)).toEqual(["network_error"]);
  });

  it("treats a 200 with no body as a protocol error, not stream_end", async () => {
    const out = await run(async () => new Response(null, { status: 200 }));
    expect(kinds(out)).toEqual(["protocol_error"]);
  });

  it("reports a reader failure mid-stream as network_error", async () => {
    const out = await run(respond(failingStream([ndjson(delta("a"))], new Error("reset"))));
    expect(kinds(out)).toEqual(["delta", "network_error"]);
  });

  it("reports a malformed line as protocol_error, distinct from a reader failure", async () => {
    const out = await run(respond(streamFrom([ndjson(delta("a")) + "garbage\n"])));
    expect(kinds(out)).toEqual(["delta", "protocol_error"]);
  });

  it("reports an invalid known event as protocol_error and never as an event", async () => {
    const out = await run(respond(streamFrom([ndjson({ type: "delta", text: 5 }, delta("after"))])));
    expect(kinds(out)).toEqual(["protocol_error"]);
  });

  it("keeps the original classification when cancel() rejects", async () => {
    const spy = { cancelled: 0 };
    const malformed = await run(respond(streamFrom(["garbage\n"], spy, { cancelRejects: true, open: true })));
    expect(kinds(malformed)).toEqual(["protocol_error"]);
    expect(spy.cancelled).toBe(1); // cancel really was attempted, and it rejected
    const reader = await run(
      respond(failingStream([], new Error("reset"), { cancelled: 0 }, { cancelRejects: true })),
    );
    expect(kinds(reader)).toEqual(["network_error"]);
  });
});

describe("askStream: abort", () => {
  it("yields nothing when aborted before the response arrives", async () => {
    const abort = new AbortController();
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    const pending = run(fetchImpl, abort.signal);
    await tick();
    abort.abort();
    expect(await pending).toEqual([]);
  });

  it("yields nothing further after an abort, even with buffered events and an EOF", async () => {
    const abort = new AbortController();
    const spy = { cancelled: 0 };
    // Everything is already buffered in a single chunk, then the stream ends.
    const body = streamFrom([ndjson(plan, delta("a"), delta("b"), done)], spy, { open: true });
    const it = askStream("q", { signal: abort.signal, fetchImpl: respond(body) });

    const first = await it.next();
    expect(first.done).toBe(false);
    expect(first.value && kinds([first.value])).toEqual(["plan"]);

    abort.abort();
    const rest: TransportSignal[] = [];
    for await (const s of it) rest.push(s);

    expect(rest).toEqual([]); // no delta, no done, no stream_end, no error, no incomplete
    expect(spy.cancelled).toBe(1);
  });

  it("yields nothing after an abort when more chunks and a close arrive later", async () => {
    const abort = new AbortController();
    const m = manualStream();
    const collected: TransportSignal[] = [];
    const finished = (async () => {
      for await (const s of askStream("q", { signal: abort.signal, fetchImpl: respond(m.stream) })) {
        collected.push(s);
      }
    })();
    m.push(ndjson(plan));
    await tick();
    expect(kinds(collected)).toEqual(["plan"]);

    abort.abort();
    m.push(ndjson(delta("late"), done));
    m.close();
    await finished;

    expect(kinds(collected)).toEqual(["plan"]);
  });

  it("does not report a read failure that happens after an abort", async () => {
    const abort = new AbortController();
    const out = await run(async () => {
      abort.abort();
      return new Response(failingStream([], new Error("aborted read")));
    }, abort.signal);
    expect(out).toEqual([]);
  });
});
