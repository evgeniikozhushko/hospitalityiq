/** Real VectorIndex backed by the configured Qdrant collection. */
import type { IndexPoint, StoredPoint, VectorIndex } from "./db/vectorIndex";
import { COLLECTION, qdrant } from "./qdrant";

export const qdrantIndex: VectorIndex = {
  async upsert(points: IndexPoint[]) {
    await qdrant.upsert(COLLECTION, {
      wait: true,
      points: points.map((p) => ({ id: p.id, vector: p.vector, payload: p.payload })),
    });
  },

  async setPayload(items) {
    if (items.length === 0) return;
    await qdrant.batchUpdate(COLLECTION, {
      wait: true,
      operations: items.map((it) => ({ set_payload: { payload: it.payload, points: [it.id] } })),
    });
  },

  async remove(ids) {
    if (ids.length === 0) return;
    await qdrant.delete(COLLECTION, { wait: true, points: ids });
  },

  async listPoints() {
    const out: StoredPoint[] = [];
    let offset: string | number | Record<string, unknown> | null | undefined = undefined;
    do {
      const page = await qdrant.scroll(COLLECTION, {
        limit: 500,
        offset: offset as string | number | undefined,
        with_payload: ["reviewId", "source", "textHash"],
        with_vector: false,
      });
      for (const p of page.points) {
        const pl = (p.payload ?? {}) as Record<string, unknown>;
        out.push({
          id: String(p.id),
          source: typeof pl.source === "string" ? pl.source : undefined,
          reviewId: typeof pl.reviewId === "string" ? pl.reviewId : undefined,
          textHash: typeof pl.textHash === "string" ? pl.textHash : undefined,
        });
      }
      offset = page.next_page_offset as typeof offset;
    } while (offset !== null && offset !== undefined);
    return out;
  },
};
