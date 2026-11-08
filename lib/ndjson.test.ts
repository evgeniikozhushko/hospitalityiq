import { describe, expect, it } from "vitest";
import { NdjsonSyntaxError, parseNdjson } from "./ndjson";
import { bytes, collect, failingStream, manualStream, ndjson, streamFrom, tick } from "./testStreams";

describe("parseNdjson: framing", () => {
  it("handles a chunk boundary in the middle of a line", async () => {
    const stream = streamFrom(['{"a":', '1}\n{"b":2}\n']);
    expect(await collect(parseNdjson(stream))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("handles several events in one chunk", async () => {
    const stream = streamFrom([ndjson({ a: 1 }, { b: 2 }, { c: 3 })]);
    expect(await collect(parseNdjson(stream))).toEqual([{ a: 1 }, { b: 2 }, { c: 3 }]);
  });

  it("parses a final line without a newline", async () => {
    const stream = streamFrom(['{"a":1}\n{"b":2}']);
    expect(await collect(parseNdjson(stream))).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("skips blank lines and tolerates \\r\\n", async () => {
    const stream = streamFrom(['{"a":1}\r\n\r\n\n{"b":2}\r\n']);
    expect(await collect(parseNdjson(stream))).toEqual([{ a: 1 }, { b: 2 }]);
  });
});

describe("parseNdjson: UTF-8", () => {
  const payload = bytes(ndjson({ text: "café 🍷 ñ 日本" }));
  const expected = [{ text: "café 🍷 ñ 日本" }];

  it("decodes identically when split at every byte boundary", async () => {
    for (let i = 1; i < payload.length; i++) {
      const stream = streamFrom([payload.slice(0, i), payload.slice(i)]);
      expect(await collect(parseNdjson(stream))).toEqual(expected);
    }
  });

  it("decodes when delivered one byte at a time", async () => {
    const stream = streamFrom(Array.from(payload, (b) => new Uint8Array([b])));
    expect(await collect(parseNdjson(stream))).toEqual(expected);
  });

  it("flushes the decoder for a final line with no newline split mid-character", async () => {
    const full = bytes('{"text":"é🍷"}');
    const stream = streamFrom([full.slice(0, 11), full.slice(11)]);
    expect(await collect(parseNdjson(stream))).toEqual([{ text: "é🍷" }]);
  });
});

describe("parseNdjson: failure kinds", () => {
  it("throws NdjsonSyntaxError for a malformed line, after yielding earlier events", async () => {
    const stream = streamFrom([ndjson({ a: 1 }) + "not json\n" + ndjson({ b: 2 })]);
    const seen: unknown[] = [];
    let error: unknown;
    try {
      for await (const v of parseNdjson(stream)) seen.push(v);
    } catch (e) {
      error = e;
    }
    expect(seen).toEqual([{ a: 1 }]);
    expect(error).toBeInstanceOf(NdjsonSyntaxError);
  });

  it("passes a reader failure through, and it is not an NdjsonSyntaxError", async () => {
    const boom = new Error("boom");
    const stream = failingStream([ndjson({ a: 1 })], boom);
    const seen: unknown[] = [];
    let error: unknown;
    try {
      for await (const v of parseNdjson(stream)) seen.push(v);
    } catch (e) {
      error = e;
    }
    expect(seen).toEqual([{ a: 1 }]);
    expect(error).toBe(boom);
    expect(error).not.toBeInstanceOf(NdjsonSyntaxError);
  });
});

describe("parseNdjson: cleanup", () => {
  it("does not cancel the source after a normal EOF, and releases the lock", async () => {
    const spy = { cancelled: 0 };
    const stream = streamFrom([ndjson({ a: 1 })], spy);
    await collect(parseNdjson(stream));
    expect(spy.cancelled).toBe(0);
    expect(stream.locked).toBe(false);
  });

  it("cancels the source and releases the lock when the consumer exits early", async () => {
    const spy = { cancelled: 0 };
    const stream = streamFrom([ndjson({ a: 1 }, { b: 2 })], spy, { open: true });
    const it = parseNdjson(stream);
    await it.next();
    await it.return();
    expect(spy.cancelled).toBe(1);
    expect(stream.locked).toBe(false);
  });

  it("cancels the source and releases the lock after a syntax error", async () => {
    const spy = { cancelled: 0 };
    const stream = streamFrom(["nope\n"], spy, { open: true });
    await expect(collect(parseNdjson(stream))).rejects.toBeInstanceOf(NdjsonSyntaxError);
    expect(spy.cancelled).toBe(1);
    expect(stream.locked).toBe(false);
  });

  it("cancels the source and ends when aborted mid-stream", async () => {
    const m = manualStream();
    const abort = new AbortController();
    const seen: unknown[] = [];
    const done = (async () => {
      for await (const v of parseNdjson(m.stream, abort.signal)) seen.push(v);
    })();
    m.push(ndjson({ a: 1 }));
    await tick();
    abort.abort();
    await done;
    expect(seen).toEqual([{ a: 1 }]);
    expect(m.spy.cancelled).toBe(1);
    expect(m.stream.locked).toBe(false);
  });

  describe("when cancel() itself rejects", () => {
    it("still surfaces a malformed line as NdjsonSyntaxError and releases the lock", async () => {
      const spy = { cancelled: 0 };
      const stream = streamFrom(["nope\n"], spy, { cancelRejects: true, open: true });
      await expect(collect(parseNdjson(stream))).rejects.toBeInstanceOf(NdjsonSyntaxError);
      expect(spy.cancelled).toBe(1); // cancel really was attempted, and it rejected
      expect(stream.locked).toBe(false);
    });

    it("still surfaces the original reader failure and releases the lock", async () => {
      const boom = new Error("boom");
      // reader.cancel() on an errored stream rejects with the stream's error: the rejection path
      const stream = failingStream([], boom, { cancelled: 0 }, { cancelRejects: true });
      await expect(collect(parseNdjson(stream))).rejects.toBe(boom);
      expect(stream.locked).toBe(false);
    });

    it("lets an early consumer exit complete without throwing", async () => {
      const spy = { cancelled: 0 };
      const stream = streamFrom([ndjson({ a: 1 }, { b: 2 })], spy, { cancelRejects: true, open: true });
      const it = parseNdjson(stream);
      await it.next();
      await expect(it.return()).resolves.toBeDefined();
      expect(spy.cancelled).toBe(1);
      expect(stream.locked).toBe(false);
    });
  });
});
