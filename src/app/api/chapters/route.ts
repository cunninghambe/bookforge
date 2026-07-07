import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createChapter, listChapters } from "@/lib/repo/chapters";

export async function GET(req: Request) {
  const db = getDb();
  const url = new URL(req.url);
  const projectId = Number(url.searchParams.get("projectId"));
  if (!Number.isFinite(projectId)) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }
  return NextResponse.json({ chapters: listChapters(db, projectId) });
}

export async function POST(req: Request) {
  const db = getDb();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const projectId = Number(body.projectId);
  if (!Number.isFinite(projectId)) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const chapter = createChapter(db, {
    projectId,
    title: str(body.title),
    pov: str(body.pov),
    synopsis: str(body.synopsis),
    beats: Array.isArray(body.beats)
      ? (body.beats.filter((b) => typeof b === "string") as string[])
      : undefined,
  });
  return NextResponse.json({ chapter }, { status: 201 });
}
