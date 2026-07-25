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
  // A23 / D187: this used to coerce a missing or non-string content to "", and
  // saveWorkingDraft updates the latest draft row IN PLACE, so a request
  // carrying {} silently replaced a finished chapter with an empty string with
  // no version to recover from. The in-place update is correct for its purpose
  // and stays; the coercion was the danger.
  if (typeof body.content !== "string") {
    return NextResponse.json(
      { error: "content must be a string" },
      { status: 400 },
    );
  }
  // D187: and it worked on LOCKED chapters, which have no business changing
  // through this route at all.
  if (chapter.status === "locked") {
    return NextResponse.json(
      { error: "chapter is locked" },
      { status: 409 },
    );
  }
  const content = body.content;
  const draft = saveWorkingDraft(db, chapterId, content);
  if (chapter.status === "planned" || chapter.status === "interrogating") {
    updateChapter(db, chapterId, { status: "drafting" });
  }
  return NextResponse.json({ draft });
}
