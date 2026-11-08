import type { AskState } from "./askState";

/**
 * Text for the single polite status region. Derived from the phase only, never from the answer
 * text, so streaming deltas never change it. Empty for error/incomplete (their alerts announce).
 */
export function statusMessage(state: Pick<AskState, "status">): string {
  switch (state.status) {
    case "connecting":
    case "planned":
      return "Searching reviews.";
    case "sources":
    case "streaming":
      return "Writing the answer.";
    case "complete":
      return "Answer complete.";
    case "no_data":
      return "No matching reviews found.";
    case "declined":
      return "That question can't be answered yet.";
    case "idle":
    case "error":
    case "incomplete":
      return "";
  }
}
