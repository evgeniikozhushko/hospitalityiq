/** Shared fixtures for tests. Not used by app code. */
import type { Source } from "./schema";

export const source: Source = {
  n: 1,
  reviewId: "r1",
  propertyName: "Banff Caribou Lodge",
  propertyType: "hotel",
  rating: 2,
  createdAt: "2025-01-02",
  text: "Room was cold.",
  score: 0.8,
};
