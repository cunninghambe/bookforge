import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listChapters, reorderChapters } from "@/lib/repo/chapters";

export async function POST(req: Request) {
  const db = getDb();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const projectId = Number(body.projectId);
  const orderedIds = Array.isArray(body.orderedIds)
    ? body.orderedIds.map(Number).filter((n) => Number.isFinite(n))
    : [];
  if (!Number.isFinite(projectId) || orderedIds.length === 0) {
    return NextResponse.json(
      { error: "projectId and orderedIds required" },
      { status: 400 },
    );
  }
  reorderChapters(db, projectId, orderedIds);
  return NextResponse.json({ chapters: listChapters(db, projectId) });
}
