/**
 * Ask a question from the terminal and watch the full pipeline.
 * Usage: npm run ask -- "what do guests praise at our restaurants?"
 */
import { answerQuestion } from "../lib/answer";
import { closeReadonlyPool } from "../lib/db/readonlyPool";

async function main() {
  const question = process.argv.slice(2).join(" ");
  if (!question) throw new Error('Pass a question, e.g. npm run ask -- "cold rooms in winter"');

  for await (const e of answerQuestion(question)) {
    switch (e.type) {
      case "plan":
        console.log("PLAN", JSON.stringify(e.plan, null, 2));
        if (e.droppedPropertyNames.length) {
          console.log("Dropped unknown properties:", e.droppedPropertyNames.join(", "));
        }
        break;
      case "declined":
        console.log(`\nDECLINED (${e.intent}): ${e.message}`);
        break;
      case "no_data":
        console.log(`\nNO DATA: ${e.message}`);
        break;
      case "sources":
        console.log(`\nSOURCES${e.relaxed ? " (filters relaxed)" : ""}`);
        for (const s of e.sources) {
          console.log(
            `  [${s.n}] ${s.score.toFixed(3)}  ${s.propertyName}  ${s.rating}★  ${s.createdAt.slice(0, 10)}  ${s.text.slice(0, 80)}…`,
          );
        }
        console.log("\nANSWER");
        break;
      case "stats":
        console.log(`\nSTATISTICS (${e.outcome.kind}, exact count from Postgres)\n\nANSWER`);
        break;
      case "delta":
        process.stdout.write(e.text);
        break;
      case "done":
        process.stdout.write("\n");
        break;
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  // The read-only pool keeps the process alive until its idle clients time out.
  .finally(() => closeReadonlyPool());