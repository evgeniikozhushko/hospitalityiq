import OpenAI from "openai";
import { wrapOpenAI } from "langsmith/wrappers";
import { env } from "./env";

/**
 * How long one request may take before it is abandoned and retried (the SDK default
 * is 10 minutes). It bounds the wait for a response to start, which is what a stuck
 * planner or embedding call looks like.
 */
export const OPENAI_TIMEOUT_MS = 60_000;

const client = new OpenAI({
  apiKey: env.OPENAI_API_KEY,
  baseURL: env.OPENAI_BASE_URL,
  timeout: OPENAI_TIMEOUT_MS,
  maxRetries: 2,
});

// Opt-in tracing: with LANGSMITH_TRACING unset or false the client is untouched.
export const openai =
  process.env.LANGSMITH_TRACING === "true" ? wrapOpenAI(client) : client;

// text-embedding-3-small returns 1536-dimensional vectors.
export const EMBEDDING_DIMENSIONS = 1536;

/** Embed many texts in one request (order of results matches input). */
export async function embed(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const res = await openai.embeddings.create({
    model: env.OPENAI_EMBEDDING_MODEL,
    input: texts,
  });
  return res.data.map((d) => d.embedding);
}
