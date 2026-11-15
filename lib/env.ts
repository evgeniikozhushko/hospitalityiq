import { z } from "zod";

/** A variable left as `NAME=` in .env.local is an empty string: treat it as not set. */
const blankAsUnset = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

// Validates environment variables once, so a missing key fails loudly at
// startup instead of deep inside an API call.
const EnvSchema = z.object({
  OPENAI_API_KEY: z.string().min(1, "OPENAI_API_KEY is missing"),
  // Optional: route through an OpenAI-compatible proxy (e.g. LiteLLM).
  OPENAI_BASE_URL: z.preprocess(blankAsUnset, z.string().url().optional()),
  OPENAI_EMBEDDING_MODEL: z.preprocess(blankAsUnset, z.string().default("text-embedding-3-small")),
  // Writes the streamed answer.
  OPENAI_CHAT_MODEL: z.preprocess(blankAsUnset, z.string().default("gpt-5.4-mini")),
  // Turns the question into intent + filters. Defaults to the chat model.
  OPENAI_PLANNER_MODEL: z.string().optional(),
  QDRANT_URL: z.preprocess(blankAsUnset, z.string().default("http://localhost:6333")),
  QDRANT_API_KEY: z.string().optional(),
  QDRANT_COLLECTION: z.preprocess(blankAsUnset, z.string().default("reviews")),
});

export const env = EnvSchema.parse(process.env);
