import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChapter, updateChapter } from "@/lib/repo/chapters";
import { latestDraft } from "@/lib/repo/drafts";
import { listUnresolvedComments } from "@/lib/repo/comments";
import { logLlmCall } from "@/lib/repo/llm";
import { getLlmClient } from "@/lib/llm/client";
import { summaryPrompt } from "@/lib/llm/prompts";

// Locks a chapter (SPEC section 6). Enabled only when every comment on the latest
// draft is resolved. Generates and stores the chapter summary (UTILITY_MODEL,
// purpose "summary"), then sets status to 'locked'. Canon extraction is a separate
// call (POST /api/chapters/[id]/extract-canon) so proposals pass the approval gate.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await ctx.params;
  const chapterId = Number(id);
  const chapter = getChapter(db, chapterId);
  if (!chapter) return NextResponse.json({ error: "not found" }, { status: 404 });

  const draft = latestDraft(db, chapterId);
  if (!draft) {
    return NextResponse.json(
      { error: "chapter has no draft to lock" },
      { status: 400 },
    );
  }
  const unresolved = listUnresolvedComments(db, draft.id);
  if (unresolved.length > 0) {
    return NextResponse.json(
      { error: "resolve all comments before locking", unresolved: unresolved.length },
      { status: 400 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Empty body allowed.
  }
  const fixtureKey =
    typeof body.fixtureKey === "string" ? body.fixtureKey : undefined;

  const client = getLlmClient();
  const model = process.env.UTILITY_MODEL ?? "claude-sonnet-4-6";
  const res = await client.complete({
    purpose: "summary",
    model,
    prompt: summaryPrompt({
      chapterTitle: chapter.title ?? `Chapter ${chapter.orderIndex + 1}`,
      pov: chapter.pov ?? "omniscient",
      text: draft.content,
    }),
    maxTokens: 512,
    fixtureKey,
  });
  logLlmCall(db, {
    purpose: "summary",
    chapterId,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  });

  const summary = res.text.trim();
  const updated = updateChapter(db, chapterId, { summary, status: "locked" });
  return NextResponse.json({ chapter: updated, summary });
}
