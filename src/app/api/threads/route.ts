import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { orderToUiChapter } from "@/lib/chapterNumbering";
import { threadsWithFlagsForBook } from "@/lib/threadFlags";
import {
  createThread,
  isThreadStatus,
  isThreadType,
  type ThreadStatus,
  type ThreadType,
  type TouchWithChapter,
} from "@/lib/repo/threads";

// Amendment A12: thread list and creation for the braid view (Phase 2 UI). The
// list is always scoped to a book (flags are computed against that book's locked
// frontier) and includes series-wide threads. Every chapter number returned is
// 1-based (A2).

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

export async function GET(req: Request) {
  const db = getDb();
  const url = new URL(req.url);
  const projectIdRaw = url.searchParams.get("projectId");
  const projectId = Number(projectIdRaw);
  if (projectIdRaw === null || !Number.isFinite(projectId)) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }
  const statusRaw = url.searchParams.get("status");
  const status = isThreadStatus(statusRaw) ? (statusRaw as ThreadStatus) : undefined;

  const rows = threadsWithFlagsForBook(db, projectId, { status });
  return NextResponse.json({
    threads: rows.map((r) => ({
      ...r.thread,
      flags: r.flags,
      touches: r.touches.map(shapeTouch),
    })),
  });
}

export async function POST(req: Request) {
  const db = getDb();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  if (!isThreadType(body.type)) {
    return NextResponse.json({ error: "invalid type" }, { status: 400 });
  }
  const status = isThreadStatus(body.status)
    ? (body.status as ThreadStatus)
    : undefined;

  const thread = createThread(db, {
    projectId: typeof body.projectId === "number" ? body.projectId : null,
    name,
    type: body.type as ThreadType,
    status,
    characterAId:
      typeof body.characterAId === "number" ? body.characterAId : null,
    characterBId:
      typeof body.characterBId === "number" ? body.characterBId : null,
    note: typeof body.note === "string" ? body.note : null,
  });
  return NextResponse.json({ thread }, { status: 201 });
}
