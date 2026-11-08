/**
 * Turns the model's answer text into plain render data. No HTML is ever produced: the UI maps
 * these tokens to React elements, so anything else stays literal text.
 *
 * Always call with the whole accumulated answer (never per chunk) so citations split across
 * streamed deltas resolve correctly.
 */

export type Inline =
  | { kind: "text"; text: string }
  | { kind: "bold"; children: Inline[] }
  | { kind: "citation"; n: number };

export type Block =
  | { kind: "paragraph"; children: Inline[] }
  | { kind: "list"; ordered: boolean; items: Inline[][] };

const BULLET = /^\s*[-*•]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const INLINE = /\*\*(.+?)\*\*|\[([1-9]\d*)\]/g;

function pushText(out: Inline[], text: string) {
  if (!text) return;
  const last = out[out.length - 1];
  if (last?.kind === "text") last.text += text;
  else out.push({ kind: "text", text });
}

function parseInline(text: string, valid: ReadonlySet<number>, allowBold: boolean): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const index = match.index ?? 0;
    pushText(out, text.slice(last, index));
    last = index + match[0].length;
    if (match[1] !== undefined) {
      if (allowBold) out.push({ kind: "bold", children: parseInline(match[1], valid, false) });
      else pushText(out, match[0]);
    } else {
      const n = Number(match[2]);
      if (valid.has(n)) out.push({ kind: "citation", n });
      else pushText(out, match[0]);
    }
  }
  pushText(out, text.slice(last));
  return out;
}

export function tokenizeAnswer(
  text: string,
  validNumbers: Iterable<number>,
  { streaming }: { streaming: boolean },
): Block[] {
  const valid = new Set(validNumbers);
  // While streaming, hold back a trailing partial citation ("[" or "[1") instead of flashing it.
  const source = streaming ? text.replace(/\[\d*$/, "") : text;

  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;

  const flushParagraph = () => {
    if (paragraph.length) {
      blocks.push({ kind: "paragraph", children: parseInline(paragraph.join(" "), valid, true) });
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list) {
      blocks.push({
        kind: "list",
        ordered: list.ordered,
        items: list.items.map((item) => parseInline(item, valid, true)),
      });
      list = null;
    }
  };

  for (const line of source.split(/\r?\n/)) {
    if (line.trim() === "") {
      flushParagraph();
      flushList();
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet ? null : ORDERED.exec(line);
    const item = bullet ?? ordered;
    if (item) {
      flushParagraph();
      const isOrdered = ordered !== null;
      if (list && list.ordered !== isOrdered) flushList();
      list ??= { ordered: isOrdered, items: [] };
      list.items.push(item[1]);
    } else {
      flushList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  flushList();
  return blocks;
}
