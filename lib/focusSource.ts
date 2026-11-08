export type FocusTarget = {
  scrollIntoView(options?: ScrollIntoViewOptions): void;
  focus(options?: FocusOptions): void;
};

export const sourceElementId = (n: number) => `source-${n}`;

/** Scrolls to the cited source card, then moves focus to it. Returns false if it is missing. */
export function activateCitation(
  n: number,
  deps: {
    getElementById: (id: string) => FocusTarget | null;
    prefersReducedMotion: boolean;
  },
): boolean {
  const el = deps.getElementById(sourceElementId(n));
  if (!el) return false;
  el.scrollIntoView({ behavior: deps.prefersReducedMotion ? "auto" : "smooth", block: "nearest" });
  el.focus({ preventScroll: true });
  return true;
}
