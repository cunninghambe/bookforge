import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { orderToUiChapter, uiChapterToOrder } from "@/lib/chapterNumbering";
import { chapterAtOrder } from "@/lib/repo/chapters";
import {
  addTouch,
  getThread,
  isTouchKind,
  type TouchKind,
} from "@/lib/repo/threads";

// Amendment A12: add a manual touch to a thread. The body carries a 1-based
// chapter number (A2), a touch kind, and optional evidence. source is 'manual'.
// For a series-wide thread the caller passes projectId to say which book's chapter
// the touch lands in; a book-scoped thread uses its own book.

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const threadId = Number(id);
  if (!Number.isFinite(threadId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  const thread = getThread(db, threadId);
  if (!thread) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const uiChapter = Number(body.chapter);
  if (!Number.isInteger(uiChapter) || uiChapter < 1) {
    return NextResponse.json(
      { error: "chapter must be a 1-based chapter number" },
      { status: 400 },
    );
  }
  if (!isTouchKind(body.kind)) {
    return NextResponse.json({ error: "invalid kind" }, { status: 400 });
  }

  // The book the chapter lives in: the thread's own book, or an explicit
  // projectId for a series-wide thread.
  const projectId =
    thread.projectId ??
    (typeof body.projectId === "number" ? body.projectId : null);
  if (projectId === null) {
    return NextResponse.json(
      { error: "projectId required for a series-wide thread" },
      { status: 400 },
    );
  }

  const chapter = chapterAtOrder(db, projectId, uiChapterToOrder(uiChapter));
  if (!chapter) {
    return NextResponse.json(
      { error: `no chapter ${uiChapter} in book ${projectId}` },
      { status: 400 },
    );
  }

  const touch = addTouch(db, {
    threadId,
    chapterId: chapter.id,
    kind: body.kind as TouchKind,
    evidence:
      typeof body.evidence === "string" && body.evidence.trim()
        ? body.evidence.trim()
        : null,
    source: "manual",
  });
  return NextResponse.json(
    { touch: { ...touch, chapter: orderToUiChapter(chapter.orderIndex) } },
    { status: 201 },
  );
}
