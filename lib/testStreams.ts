/** Helpers for building mock response bodies in tests. Not used by app code. */

const encoder = new TextEncoder();
export const bytes = (s: string) => encoder.encode(s);

export type StreamSpy = { cancelled: number };

/** A finite stream that enqueues all chunks, then closes. */
export function streamFrom(
  chunks: (string | Uint8Array)[],
  spy: StreamSpy = { cancelled: 0 },
  opts: { cancelRejects?: boolean; open?: boolean } = {},
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(typeof c === "string" ? bytes(c) : c);
      // `open` leaves the stream unclosed, like a live connection. (cancel() on an already-closed
      // stream is a no-op, so cleanup tests need an open one to observe cancellation.)
      if (!opts.open) controller.close();
    },
    cancel() {
      spy.cancelled++;
      if (opts.cancelRejects) throw new Error("cancel failed");
    },
  });
}

/** Emits the chunks one per pull, then fails the stream with `error`. */
export function failingStream(
  chunks: string[],
  error: Error,
  spy: StreamSpy = { cancelled: 0 },
  opts: { cancelRejects?: boolean } = {},
): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(bytes(chunks[i++]));
      else throw error;
    },
    cancel() {
      spy.cancelled++;
      if (opts.cancelRejects) throw new Error("cancel failed");
    },
  });
}

/** A stream the test feeds by hand. Pushing after cancel/close is a no-op. */
export function manualStream(spy: StreamSpy = { cancelled: 0 }) {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      ended = true;
      spy.cancelled++;
    },
  });
  return {
    stream,
    spy,
    push(chunk: string) {
      if (ended) return;
      try {
        controller.enqueue(bytes(chunk));
      } catch {
        // stream already closed or cancelled
      }
    },
    close() {
      if (ended) return;
      ended = true;
      try {
        controller.close();
      } catch {
        // already closed
      }
    },
  };
}

export const ndjson = (...events: unknown[]) => events.map((e) => JSON.stringify(e) + "\n").join("");

export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const v of it) out.push(v);
  return out;
}

export const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
