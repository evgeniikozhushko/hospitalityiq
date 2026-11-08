import { describe, expect, it } from "vitest";
import { tokenizeAnswer, type Block, type Inline } from "./answerText";

const text = (t: string): Inline => ({ kind: "text", text: t });
const cite = (n: number): Inline => ({ kind: "citation", n });
const para = (...children: Inline[]): Block => ({ kind: "paragraph", children });
const tok = (s: string, valid: number[] = [1, 2, 3, 4], streaming = false) =>
  tokenizeAnswer(s, valid, { streaming });

describe("citations", () => {
  it("links citations that exist in the sources", () => {
    expect(tok("Cold rooms [1].")).toEqual([para(text("Cold rooms "), cite(1), text("."))]);
  });

  it("links adjacent citations", () => {
    expect(tok("Both [1][4]")).toEqual([para(text("Both "), cite(1), cite(4))]);
  });

  it.each(["[9]", "[0]", "[01]", "[1, 2]", "[a]", "[ 1 ]"])("leaves %s as plain text", (literal) => {
    const blocks = tok(`See ${literal} here`, [1, 2]);
    expect(blocks).toEqual([para(text(`See ${literal} here`))]);
  });

  it("resolves a citation split across streamed chunks by parsing the accumulated text", () => {
    const chunks = ["Cold [", "1", "] rooms"];
    let acc = "";
    const seen: Block[][] = [];
    for (const c of chunks) {
      acc += c;
      seen.push(tok(acc, [1], true));
    }
    // paragraph lines are trimmed, so the held-back text ends at "Cold"
    expect(seen[0]).toEqual([para(text("Cold"))]); // "[" held back
    expect(seen[1]).toEqual([para(text("Cold"))]); // "[1" held back
    expect(seen[2]).toEqual([para(text("Cold "), cite(1), text(" rooms"))]);
  });

  it("holds back a trailing partial citation while streaming, but shows it literally once the stream ends", () => {
    expect(tok("Rooms [", [1], true)).toEqual([para(text("Rooms"))]);
    expect(tok("Rooms [1", [1], true)).toEqual([para(text("Rooms"))]);
    expect(tok("Rooms [", [1], false)).toEqual([para(text("Rooms ["))]);
    expect(tok("Rooms [1", [1], false)).toEqual([para(text("Rooms [1"))]);
  });

  it("does not hold back a completed citation while streaming", () => {
    expect(tok("Rooms [1]", [1], true)).toEqual([para(text("Rooms "), cite(1))]);
  });
});

describe("markdown subset", () => {
  it("builds bullet lists from -, * and •", () => {
    for (const marker of ["-", "*", "•"]) {
      expect(tok(`${marker} one [1]\n${marker} two`)).toEqual([
        { kind: "list", ordered: false, items: [[text("one "), cite(1)], [text("two")]] },
      ]);
    }
  });

  it("builds numbered lists", () => {
    expect(tok("1. first\n2) second")).toEqual([
      { kind: "list", ordered: true, items: [[text("first")], [text("second")]] },
    ]);
  });

  it("renders bold, with citations inside it", () => {
    expect(tok("A **big [1] deal** here")).toEqual([
      para(text("A "), { kind: "bold", children: [text("big "), cite(1), text(" deal")] }, text(" here")),
    ]);
  });

  it("does not mistake a leading **bold** for a bullet", () => {
    expect(tok("**Heading** text")).toEqual([
      para({ kind: "bold", children: [text("Heading")] }, text(" text")),
    ]);
  });

  it("separates a lead-in paragraph from a following list", () => {
    expect(tok("Short answer.\n\n- point")).toEqual([
      para(text("Short answer.")),
      { kind: "list", ordered: false, items: [[text("point")]] },
    ]);
    expect(tok("Short answer.\n- point")).toEqual([
      para(text("Short answer.")),
      { kind: "list", ordered: false, items: [[text("point")]] },
    ]);
  });

  it("leaves an unclosed ** literal", () => {
    expect(tok("a **b")).toEqual([para(text("a **b"))]);
  });
});

describe("safety", () => {
  it("keeps HTML-looking text as literal text tokens", () => {
    const input = '<script>alert(1)</script> <img src=x onerror="steal()"> &amp; <b>no</b>';
    expect(tok(input)).toEqual([para(text(input))]);
  });

  it("never produces anything but text, bold and citation tokens", () => {
    const blocks = tok("<a href='javascript:x'>hi</a> [1] **b**");
    const kinds = new Set<string>();
    const walk = (inl: Inline[]) =>
      inl.forEach((i) => {
        kinds.add(i.kind);
        if (i.kind === "bold") walk(i.children);
      });
    for (const b of blocks) {
      if (b.kind === "paragraph") walk(b.children);
      else b.items.forEach(walk);
    }
    expect([...kinds].every((k) => ["text", "bold", "citation"].includes(k))).toBe(true);
  });
});
