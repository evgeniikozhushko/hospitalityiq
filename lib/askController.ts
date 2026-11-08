/**
 * Orchestrates requests for the chat UI: monotonic request ids, aborting the superseded request,
 * retry of the last submitted question, and disposal on unmount.
 *
 * Race safety: every dispatched action carries the id of the submission it belongs to, and nothing
 * is dispatched once that id is no longer current or the request's signal is aborted.
 */
import { askStream, type FetchLike } from "./askClient";
import type { AskAction } from "./askState";

export type AskController = {
  submit(question: string): Promise<void>;
  /** Resubmits the last submitted question (never the current textarea text). */
  retry(): Promise<void>;
  dispose(): void;
};

export function createAskController({
  dispatch,
  fetchImpl,
}: {
  dispatch: (action: AskAction) => void;
  fetchImpl?: FetchLike;
}): AskController {
  let currentId = 0;
  let active: AbortController | null = null;
  let lastQuestion: string | null = null;
  let disposed = false;

  async function run(question: string): Promise<void> {
    if (disposed) return;
    active?.abort();
    const id = ++currentId;
    const abort = new AbortController();
    active = abort;
    lastQuestion = question;
    dispatch({ type: "submit", id, question });

    const isCurrent = () => !disposed && id === currentId && !abort.signal.aborted;
    try {
      for await (const signal of askStream(question, { signal: abort.signal, fetchImpl })) {
        if (!isCurrent()) break;
        dispatch({ type: "signal", id, signal });
      }
    } catch {
      if (isCurrent()) {
        dispatch({
          type: "signal",
          id,
          signal: { kind: "protocol_error", message: "Something went wrong." },
        });
      }
    } finally {
      if (active === abort) active = null;
    }
  }

  return {
    submit: run,
    retry: () => (lastQuestion === null ? Promise.resolve() : run(lastQuestion)),
    dispose() {
      disposed = true;
      currentId++;
      active?.abort();
      active = null;
    },
  };
}
