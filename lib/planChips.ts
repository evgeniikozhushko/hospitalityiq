import type { QueryFilters } from "./schema";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Human-readable labels for the filters the planner extracted from the question. */
export function planChips(filters: QueryFilters): string[] {
  const chips: string[] = [];
  for (const type of filters.propertyTypes ?? []) chips.push(`Property type: ${type}`);
  for (const name of filters.propertyNames ?? []) chips.push(`Property: ${name}`);

  const { minRating: min, maxRating: max } = filters;
  if (min !== null && max !== null) {
    chips.push(min === max ? `Rating: ${min}★` : `Rating: ${min}–${max}★`);
  } else if (min !== null) {
    chips.push(`Rating: ${min}★ and up`);
  } else if (max !== null) {
    chips.push(`Rating: ${max}★ and below`);
  }

  const months = (filters.months ?? []).map((m) => MONTHS[m - 1]).filter(Boolean);
  if (months.length) chips.push(`Months: ${months.join(", ")}`);
  if (filters.since) chips.push(`Since ${filters.since}`);
  if (filters.until) chips.push(`Until ${filters.until}`);
  return chips;
}
