import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { assemblableCanon } from "@/lib/repo/canon";
import {
  createQuestions,
  getChapter,
  listQuestions,
  updateChapter,
} from "@/lib/repo/chapters";
import { logLlmCall } from "@/lib/repo/llm";
import { getLlmClient } from "@/lib/llm/client";
import { modelFor } from "@/lib/modelFor";
import { parseJson } from "@/lib/llm/json";
import { interrogationPrompt, normalizeQuestions } from "@/lib/llm/prompts";
import { orderToUiChapter } from "@/lib/chapterNumbering";

// Runs the interrogation prompt (model resolved per purpose, A8), stores the
// returned questions, and moves the chapter into the interrogating state.
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await ctx.params;
  const chapterId = Number(id);
  const chapter = getChapter(db, chapterId);
  if (!chapter) return NextResponse.json({ error: "not found" }, { status: 404 });

  const canon = assemblableCanon(db, { projectId: chapter.projectId }).map(
    (f) => f.content,
  );
  const prompt = interrogationPrompt({
    chapterTitle: chapter.title ?? `Chapter ${orderToUiChapter(chapter.orderIndex)}`,
    pov: chapter.pov ?? "omniscient",
    synopsis: chapter.synopsis ?? "",
    beats: chapter.beats,
    lockedCanon: canon,
  });

  const client = getLlmClient();
  const model = modelFor(db, "interrogation");
  let result;
  try {
    result = await client.complete({
      purpose: "interrogation",
      model,
      prompt,
      maxTokens: 1024,
    });
  } catch (err) {
    return NextResponse.json(
      { error: `LLM error: ${(err as Error).message}` },
      { status: 502 },
    );
  }

  logLlmCall(db, {
    purpose: "interrogation",
    chapterId,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    model,
  });

  const parsed = parseJson<unknown>(result.text);
  if (!parsed.ok) {
    return NextResponse.json(
      { error: "could not parse questions", raw: result.text },
      { status: 502 },
    );
  }
  const questions = normalizeQuestions(parsed.value);
  if (questions.length === 0) {
    return NextResponse.json(
      { error: "no questions returned", raw: result.text },
      { status: 502 },
    );
  }

  createQuestions(db, chapterId, questions);
  updateChapter(db, chapterId, { status: "interrogating" });
  return NextResponse.json({ questions: listQuestions(db, chapterId) });
}
