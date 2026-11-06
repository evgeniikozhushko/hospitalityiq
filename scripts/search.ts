/**
 * Quick retrieval check from the terminal.
 * Usage: npm run search -- "what do guests complain about in winter?"
 */
import { embed } from "../lib/openai";
import { qdrant, COLLECTION } from "../lib/qdrant";

async function main() {
  const query = process.argv.slice(2).join(" ");
  if (!query) throw new Error('Pass a question, e.g. npm run search -- "cold rooms"');

  const [vector] = await embed([query]);
  // query() is Qdrant's universal search API (search() was removed in v1.20+).
  const { points } = await qdrant.query(COLLECTION, {
    query: vector,
    limit: 5,
    with_payload: true,
  });

  for (const r of points) {
    const p = r.payload as Record<string, unknown>;
    console.log(`\n${r.score.toFixed(3)}  ${p.propertyName}  (${p.rating}★, ${p.createdAt})`);
    console.log(`  ${p.text}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
