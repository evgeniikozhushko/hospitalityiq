import { z } from "zod";
import { answerQuestion } from "@/lib/answer";

const BodySchema = z.object({
  question: z.string().trim().min(3).max(500),
});

/**
 * POST /api/ask  { "question": "..." }
 * Streams newline-delimited JSON events (see AnswerEvent in lib/answer.ts).
 */
export async function POST(request: Request) {
  const parsed = BodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Body must be JSON: { question: string (3-500 chars) }" },
      { status: 400 },
    );
  }

  const encoder = new TextEncoder();
  const events = answerQuestion(parsed.data.question);

  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { value, done } = await events.next();
        if (done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
      } catch (err) {
        console.error("ask failed", err);
        controller.enqueue(
          encoder.encode(JSON.stringify({ type: "error", message: "Something went wrong answering that question." }) + "\n"),
        );
        controller.close();
      }
    },
    async cancel() {
      await events.return(undefined);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
