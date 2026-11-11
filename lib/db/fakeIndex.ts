import type { IndexPoint, StoredPoint, VectorIndex } from "./vectorIndex";

/** In-memory VectorIndex for tests, with switches to simulate Qdrant failures. */
export class FakeIndex implements VectorIndex {
  points = new Map<string, IndexPoint>();
  failUpsert = false;
  failRemove = false;
  calls = { upsert: 0, setPayload: 0, remove: 0 };

  async upsert(points: IndexPoint[]) {
    this.calls.upsert++;
    if (this.failUpsert) throw new Error("qdrant down");
    for (const p of points) this.points.set(p.id, { ...p, payload: { ...p.payload } });
  }
  async setPayload(items: { id: string; payload: Record<string, unknown> }[]) {
    this.calls.setPayload++;
    for (const it of items) {
      const p = this.points.get(it.id);
      if (p) p.payload = { ...p.payload, ...it.payload };
    }
  }
  async remove(ids: string[]) {
    this.calls.remove++;
    if (this.failRemove) throw new Error("qdrant down");
    for (const id of ids) this.points.delete(id);
  }
  async listPoints(): Promise<StoredPoint[]> {
    return [...this.points.values()].map((p) => ({
      id: p.id,
      source: p.payload.source as string | undefined,
      reviewId: p.payload.reviewId as string | undefined,
      textHash: p.payload.textHash as string | undefined,
    }));
  }
}

/** Deterministic fake embedding; counts how many texts were embedded. */
export function fakeEmbed() {
  const embedded: string[] = [];
  const fn = async (texts: string[]) => {
    embedded.push(...texts);
    return texts.map((t) => [t.length, 1]);
  };
  return Object.assign(fn, { embedded });
}
