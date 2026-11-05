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
  const results = await qdrant.search(COLLECTION, {
    vector,
    limit: 5,
    with_payload: true,
  });

  for (const r of results) {
    const p = r.payload as Record<string, unknown>;
    console.log(`\n${r.score.toFixed(3)}  ${p.propertyName}  (${p.rating}★, ${p.createdAt})`);
    console.log(`  ${p.text}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
