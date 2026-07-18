import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { orderToUiChapter } from "@/lib/chapterNumbering";
import { flagsForThread } from "@/lib/threadFlags";
import {
  getThread,
  listTouches,
  updateThread,
  isThreadStatus,
  type ThreadStatus,
  type TouchWithChapter,
} from "@/lib/repo/threads";

// Amendment A12: one thread's detail plus its touch timeline (GET) and edits
// (PATCH: name, note, resolve, retire, characters). Chapter numbers are 1-based
// (A2). Resolve and retire are author-equivalent status changes, done here.

type Ctx = { params: Promise<{ id: string }> };

function shapeTouch(t: TouchWithChapter) {
  return {
    id: t.id,
    threadId: t.threadId,
    chapterId: t.chapterId,
    chapter: orderToUiChapter(t.chapterOrder),
    kind: t.kind,
    evidence: t.evidence,
    source: t.source,
  };
}

export async function GET(req: Request, ctx: Ctx) {
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
  const touches = listTouches(db, threadId);

  // Flags are evaluated against a book. Default to the thread's own book; a
  // series-wide thread needs an explicit ?projectId= to be flagged.
  const url = new URL(req.url);
  const projectIdRaw = url.searchParams.get("projectId");
  const flagBook =
    thread.projectId ??
    (projectIdRaw !== null && Number.isFinite(Number(projectIdRaw))
      ? Number(projectIdRaw)
      : null);
  const flags = flagBook !== null ? flagsForThread(db, thread, flagBook) : null;

  return NextResponse.json({
    thread,
    touches: touches.map(shapeTouch),
    flags,
  });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const threadId = Number(id);
  if (!Number.isFinite(threadId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  if (!getThread(db, threadId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  if (body.status !== undefined && !isThreadStatus(body.status)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }

  const thread = updateThread(db, threadId, {
    name:
      typeof body.name === "string" && body.name.trim()
        ? body.name.trim()
        : undefined,
    note: typeof body.note === "string" ? body.note : undefined,
    status: isThreadStatus(body.status)
      ? (body.status as ThreadStatus)
      : undefined,
    characterAId:
      body.characterAId === null
        ? null
        : typeof body.characterAId === "number"
          ? body.characterAId
          : undefined,
    characterBId:
      body.characterBId === null
        ? null
        : typeof body.characterBId === "number"
          ? body.characterBId
          : undefined,
  });
  return NextResponse.json({ thread });
}
