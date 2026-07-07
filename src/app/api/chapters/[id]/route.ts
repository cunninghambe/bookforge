import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  CHAPTER_STATUSES,
  type ChapterStatus,
  deleteChapter,
  getChapter,
  updateChapter,
} from "@/lib/repo/chapters";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const chapter = getChapter(db, Number(id));
  if (!chapter) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ chapter });
}

export async function PATCH(req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const chapterId = Number(id);
  if (!getChapter(db, chapterId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const status = body.status as string | undefined;
  if (status !== undefined && !CHAPTER_STATUSES.includes(status as ChapterStatus)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const chapter = updateChapter(db, chapterId, {
    title: str(body.title),
    pov: str(body.pov),
    synopsis: str(body.synopsis),
    beats: Array.isArray(body.beats)
      ? (body.beats.filter((b) => typeof b === "string") as string[])
      : undefined,
    summary: str(body.summary),
    status: status as ChapterStatus | undefined,
  });
  return NextResponse.json({ chapter });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  deleteChapter(db, Number(id));
  return NextResponse.json({ ok: true });
}
