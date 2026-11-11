/** The few Qdrant operations the sync needs, so tests can use an in-memory fake. */
export type IndexPoint = { id: string; vector: number[]; payload: Record<string, unknown> };

/** What reconciliation needs to know about a stored point. */
export type StoredPoint = {
  id: string;
  /** Payload `source`; undefined when the point has none. */
  source?: string;
  reviewId?: string;
  textHash?: string;
};

export interface VectorIndex {
  upsert(points: IndexPoint[]): Promise<void>;
  setPayload(items: { id: string; payload: Record<string, unknown> }[]): Promise<void>;
  remove(ids: string[]): Promise<void>;
  /** Every point in the collection (payload fields above only). */
  listPoints(): Promise<StoredPoint[]>;
}

export type Embed = (texts: string[]) => Promise<number[][]>;
