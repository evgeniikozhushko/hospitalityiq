/**
 * The calendar date a question is asked on, in the portfolio's local time
 * (docs/routing-plan.md, decision 3). Computed once per question and used both by
 * the planner (to resolve "last year") and by the route gate (to end an open trend).
 * The UTC date is wrong here: on Banff evenings it is already tomorrow.
 */
export const PORTFOLIO_TIMEZONE = "America/Edmonton";

export function localToday(now: Date = new Date(), timeZone: string = PORTFOLIO_TIMEZONE): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
