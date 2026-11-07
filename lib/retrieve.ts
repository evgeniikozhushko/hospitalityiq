/**
 * Retrieval with one relaxed retry. Dependencies are injected so the retry
 * logic can be tested without OpenAI or Qdrant (see retrieve.test.ts).
 */
import type { Schemas } from "@qdrant/js-client-rest";
import { buildFilter, hasNonPropertyFilters, propertyOnly } from "./filters";
import type { QueryPlan, Source } from "./schema";

export const TOP_K = { specific: 8, aggregate: 40 } as const;

export type SearchHit = { score: number; payload: Record<string, unknown> };

export type RetrieveDeps = {
  embed: (texts: string[]) => Promise<number[][]>;
  search: (args: {
    vector: number[];
    filter: Schemas["Filter"] | undefined;
    limit: number;
  }) => Promise<SearchHit[]>;
};

export type RetrieveResult = {
  sources: Source[];
  /** True when the strict filters found nothing and we retried with property filters only. */
  relaxed: boolean;
};

export async function retrieve(plan: QueryPlan, deps: RetrieveDeps): Promise<RetrieveResult> {
  const [vector] = await deps.embed([plan.searchQuery]);
  const limit = TOP_K[plan.mode];

  let hits = await deps.search({ vector, filter: buildFilter(plan.filters), limit });
  let relaxed = false;

  if (hits.length === 0 && hasNonPropertyFilters(plan.filters)) {
    hits = await deps.search({ vector, filter: buildFilter(propertyOnly(plan.filters)), limit });
    relaxed = hits.length > 0;
  }

  return { sources: hits.map((h, i) => toSource(h, i + 1)), relaxed };
}

function toSource(hit: SearchHit, n: number): Source {
  const p = hit.payload;
  return {
    n,
    reviewId: String(p.reviewId),
    propertyName: String(p.propertyName),
    propertyType: p.propertyType as Source["propertyType"],
    rating: Number(p.rating),
    createdAt: String(p.createdAt),
    text: String(p.text),
    score: hit.score,
  };
}
