import { z } from "zod";
import { QueryPlanSchema } from "./schema";
import { SourceWireSchema } from "./askWire";

const STORAGE_KEY = "hospitalityiq:last-answer:v1";

const SavedAnswerSchema = z.object({
  version: z.literal(1),
  question: z.string().min(1),
  plan: QueryPlanSchema.nullable(),
  droppedPropertyNames: z.array(z.string()),
  sources: z.array(SourceWireSchema),
  relaxed: z.boolean(),
  answer: z.string(),
});

export type SavedAnswer = z.infer<typeof SavedAnswerSchema>;

export function loadAnswer(): SavedAnswer | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const result = SavedAnswerSchema.safeParse(JSON.parse(raw));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function saveAnswer(answer: SavedAnswer): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(answer));
  } catch {
    // Storage can be unavailable or full; the chat remains usable.
  }
}
