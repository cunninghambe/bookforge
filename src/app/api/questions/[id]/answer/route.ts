import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createCanon } from "@/lib/repo/canon";
import { answerQuestion, getChapter, getQuestion } from "@/lib/repo/chapters";

// Saves an answer and converts it into a provisional plot_decision canon fact,
// linked back to the question via resulting_fact_id. The user locks the fact later.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await ctx.params;
  const questionId = Number(id);
  const question = getQuestion(db, questionId);
  if (!question) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const answer = typeof body.answer === "string" ? body.answer.trim() : "";
  if (answer.length === 0) {
    return NextResponse.json({ error: "answer required" }, { status: 400 });
  }

  const chapter = getChapter(db, question.chapterId);
  const projectId = chapter?.projectId ?? null;

  // The fact content is the decision, phrased as a durable statement.
  const content = `${question.question} ${answer}`;
  const fact = createCanon(db, {
    type: "plot_decision",
    content,
    status: "provisional",
    projectId,
    source: `interrogation:${question.chapterId}`,
  });

  const updated = answerQuestion(db, questionId, answer, fact.id);
  return NextResponse.json({ question: updated, fact });
}
