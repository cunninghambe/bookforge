import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChapter, updateChapter } from "@/lib/repo/chapters";
import { saveWorkingDraft } from "@/lib/repo/drafts";

// Upserts the chapter's working draft (latest version) with the full editor text.
// Also nudges the chapter into 'drafting' if it was still planned/interrogating.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await ctx.params;
  const chapterId = Number(id);
  const chapter = getChapter(db, chapterId);
  if (!chapter) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const content = typeof body.content === "string" ? body.content : "";
  const draft = saveWorkingDraft(db, chapterId, content);
  if (chapter.status === "planned" || chapter.status === "interrogating") {
    updateChapter(db, chapterId, { status: "drafting" });
  }
  return NextResponse.json({ draft });
}
