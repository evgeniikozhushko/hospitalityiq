import { describe, expect, it } from "vitest";
import { alertRole, type AlertKind } from "./alertRole";
import { activateCitation, sourceElementId, type FocusTarget } from "./focusSource";
import { askReducer, initialAskState, type AskStatus } from "./askState";
import { statusMessage } from "./askStatus";

describe("statusMessage", () => {
  it("is identical for states that differ only in the answer text", () => {
    let s = askReducer(initialAskState, { type: "submit", id: 1, question: "q" });
    s = askReducer(s, { type: "signal", id: 1, signal: { kind: "event", event: { type: "delta", text: "a" } } });
    const first = statusMessage(s);
    for (const text of ["b", "cc", "a much longer streamed delta"]) {
      s = askReducer(s, { type: "signal", id: 1, signal: { kind: "event", event: { type: "delta", text } } });
      expect(statusMessage(s)).toBe(first);
    }
    expect(first).not.toBe("");
  });

  it("is the same at sources and streaming, so the first delta does not re-announce", () => {
    expect(statusMessage({ status: "sources" })).toBe(statusMessage({ status: "streaming" }));
    expect(statusMessage({ status: "connecting" })).toBe(statusMessage({ status: "planned" }));
  });

  it("is empty for error, incomplete and idle", () => {
    for (const status of ["error", "incomplete", "idle"] as AskStatus[]) {
      expect(statusMessage({ status })).toBe("");
    }
  });

  it("has distinct text at each announced phase", () => {
    const phases: AskStatus[] = ["connecting", "streaming", "complete", "no_data", "declined"];
    const texts = phases.map((status) => statusMessage({ status }));
    expect(new Set(texts).size).toBe(phases.length);
    expect(texts.every((t) => t !== "")).toBe(true);
  });
});

describe("alertRole", () => {
  const expected: Record<AlertKind, "alert" | "note"> = {
    error: "alert",
    incomplete: "alert",
    relaxed: "note",
    dropped_properties: "note",
    declined: "note",
    no_data: "note",
  };
  it.each(Object.entries(expected))("%s -> %s", (kind, role) => {
    expect(alertRole(kind as AlertKind)).toBe(role);
  });
});

describe("activateCitation", () => {
  const makeTarget = () => {
    const calls: string[] = [];
    const args: Record<string, unknown> = {};
    const target: FocusTarget = {
      scrollIntoView(o) {
        calls.push("scroll");
        args.scroll = o;
      },
      focus(o) {
        calls.push("focus");
        args.focus = o;
      },
    };
    return { target, calls, args };
  };

  it("scrolls and then focuses the card, without a second scroll", () => {
    const { target, calls, args } = makeTarget();
    const ids: string[] = [];
    const ok = activateCitation(3, {
      getElementById: (id) => (ids.push(id), target),
      prefersReducedMotion: false,
    });
    expect(ok).toBe(true);
    expect(ids).toEqual([sourceElementId(3)]);
    expect(calls).toEqual(["scroll", "focus"]);
    expect(args.scroll).toEqual({ behavior: "smooth", block: "nearest" });
    expect(args.focus).toEqual({ preventScroll: true });
  });

  it("scrolls instantly under reduced motion", () => {
    const { target, args } = makeTarget();
    activateCitation(1, { getElementById: () => target, prefersReducedMotion: true });
    expect(args.scroll).toEqual({ behavior: "auto", block: "nearest" });
  });

  it("is safe when the card is missing", () => {
    expect(activateCitation(9, { getElementById: () => null, prefersReducedMotion: false })).toBe(false);
  });
});
