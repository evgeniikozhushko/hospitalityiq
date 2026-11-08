/**
 * Pure reducer for one chat exchange. `submit` is handled before any guard (it starts a new
 * request); every other action must belong to the active request and arrive before a terminal
 * status, otherwise it is ignored.
 */
import type { QueryPlan, Source } from "./schema";
import type { TransportSignal } from "./askClient";

export type AskStatus =
  | "idle"
  | "connecting" // submitted, nothing received yet
  | "planned" // plan received
  | "sources" // sources received, waiting for the first delta
  | "streaming"
  | "complete"
  | "declined"
  | "no_data"
  | "error"
  | "incomplete";

const TERMINAL: ReadonlySet<AskStatus> = new Set([
  "complete",
  "declined",
  "no_data",
  "error",
  "incomplete",
]);

export function isTerminal(status: AskStatus): boolean {
  return TERMINAL.has(status);
}

export type AskState = {
  activeId: number;
  lastQuestion: string | null;
  status: AskStatus;
  plan: QueryPlan | null;
  droppedPropertyNames: string[];
  sources: Source[];
  relaxed: boolean;
  answer: string;
  /** declined / no_data message from the server */
  message: string | null;
  error: string | null;
};

export const initialAskState: AskState = {
  activeId: 0,
  lastQuestion: null,
  status: "idle",
  plan: null,
  droppedPropertyNames: [],
  sources: [],
  relaxed: false,
  answer: "",
  message: null,
  error: null,
};

export type AskAction =
  | { type: "submit"; id: number; question: string }
  | { type: "signal"; id: number; signal: TransportSignal };

export function askReducer(state: AskState, action: AskAction): AskState {
  if (action.type === "submit") {
    return {
      ...initialAskState,
      activeId: action.id,
      lastQuestion: action.question,
      status: "connecting",
    };
  }

  if (action.id !== state.activeId || isTerminal(state.status) || state.status === "idle") {
    return state;
  }

  const signal = action.signal;
  switch (signal.kind) {
    case "http_error":
    case "network_error":
    case "protocol_error":
      return { ...state, status: "error", error: signal.message };
    case "stream_end":
      return { ...state, status: "incomplete" };
    case "event": {
      const event = signal.event;
      switch (event.type) {
        case "plan":
          return {
            ...state,
            status: "planned",
            plan: event.plan,
            droppedPropertyNames: event.droppedPropertyNames,
          };
        case "declined":
        case "no_data":
          return { ...state, status: event.type, message: event.message };
        case "sources":
          return { ...state, status: "sources", sources: event.sources, relaxed: event.relaxed };
        case "delta":
          return { ...state, status: "streaming", answer: state.answer + event.text };
        case "done":
          return { ...state, status: "complete" };
        case "error":
          return { ...state, status: "error", error: event.message };
      }
    }
  }
}
