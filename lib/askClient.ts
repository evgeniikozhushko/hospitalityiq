/**
 * Transport for POST /api/ask: fetch + NDJSON + validation, turned into request-agnostic signals.
 * Signals carry no request id; the controller tags them.
 *
 * An intentional abort is never reported: once `signal.aborted` is true nothing more is yielded.
 */
import { NdjsonSyntaxError, parseNdjson } from "./ndjson";
import { parseWireEvent, type AskEvent } from "./askWire";

export type TransportSignal =
  | { kind: "event"; event: AskEvent }
  | { kind: "http_error"; message: string }
  | { kind: "network_error"; message: string }
  | { kind: "protocol_error"; message: string }
  | { kind: "stream_end" };

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Resolved at call time so a page-level fetch override takes effect. */
export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

export const ASK_ENDPOINT = "/api/ask";

export async function* askStream(
  question: string,
  { signal, fetchImpl = defaultFetch }: { signal: AbortSignal; fetchImpl?: FetchLike },
): AsyncGenerator<TransportSignal, void, undefined> {
  let res: Response;
  try {
    res = await fetchImpl(ASK_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question }),
      signal,
    });
  } catch {
    if (signal.aborted) return;
    yield { kind: "network_error", message: "Could not reach the server." };
    return;
  }

  if (signal.aborted) {
    res.body?.cancel().catch(() => {});
    return;
  }

  if (!res.ok) {
    let message = `Request failed (${res.status}).`;
    try {
      const json: unknown = await res.json();
      if (json && typeof json === "object" && typeof (json as { error?: unknown }).error === "string") {
        message = (json as { error: string }).error;
      }
    } catch {
      // body was not JSON; keep the generic message
    }
    if (signal.aborted) return;
    yield { kind: "http_error", message };
    return;
  }

  if (!res.body) {
    yield { kind: "protocol_error", message: "The response had no body." };
    return;
  }

  try {
    for await (const raw of parseNdjson(res.body, signal)) {
      if (signal.aborted) return;
      const parsed = parseWireEvent(raw);
      if (parsed.kind === "unknown") continue;
      if (parsed.kind === "invalid") {
        yield { kind: "protocol_error", message: "Unexpected response from the server." };
        return;
      }
      yield { kind: "event", event: parsed.event };
      // Terminal: stop reading; leaving the loop cancels the reader in parseNdjson's finally.
      if (parsed.event.type === "done" || parsed.event.type === "error") return;
    }
  } catch (err) {
    if (signal.aborted) return;
    if (err instanceof NdjsonSyntaxError) {
      yield { kind: "protocol_error", message: "Unreadable response from the server." };
    } else {
      yield { kind: "network_error", message: "Connection lost." };
    }
    return;
  }

  if (signal.aborted) return;
  yield { kind: "stream_end" };
}
