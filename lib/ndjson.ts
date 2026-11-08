/**
 * Incremental NDJSON parser for a fetch response body.
 *
 * - UTF-8 safe across chunk boundaries (one streaming TextDecoder, flushed at EOF).
 * - Buffers partial lines, skips blank lines, tolerates \r\n, parses a final line without a newline.
 * - Failure kinds are distinguishable by type: NdjsonSyntaxError for a complete line that is not
 *   valid JSON; anything the reader itself throws is passed through untouched.
 * - Cleanup never masks the original error: cancel() and releaseLock() failures are swallowed.
 */

export class NdjsonSyntaxError extends Error {
  readonly line: string;
  constructor(line: string) {
    super("Invalid JSON line in NDJSON stream");
    this.name = "NdjsonSyntaxError";
    this.line = line;
  }
}

function parseLine(raw: string): { value: unknown } | null {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  if (line.trim() === "") return null;
  try {
    return { value: JSON.parse(line) };
  } catch {
    throw new NdjsonSyntaxError(line);
  }
}

export async function* parseNdjson(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let reachedEof = false;

  const cancelReader = () => {
    reader.cancel().catch(() => {});
  };
  // Aborting cancels the reader, which resolves any pending read() with done: true.
  if (signal?.aborted) cancelReader();
  else signal?.addEventListener("abort", cancelReader, { once: true });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        reachedEof = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const parsed = parseLine(line);
        if (parsed) yield parsed.value;
      }
    }
    buffer += decoder.decode(); // flush
    const tail = parseLine(buffer);
    if (tail) yield tail.value;
  } finally {
    signal?.removeEventListener("abort", cancelReader);
    if (!reachedEof) {
      try {
        await reader.cancel();
      } catch {
        // never mask the original error
      }
    }
    try {
      reader.releaseLock();
    } catch {
      // already released or errored
    }
  }
}
