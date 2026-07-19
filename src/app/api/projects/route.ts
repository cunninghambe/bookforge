import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createProject } from "@/lib/repo/projects";
import { getSeries } from "@/lib/repo/series";

// Amendment A16: create a book (project) in a series. title plus seriesId; the
// book is appended at the end of that series in reading order. Validation follows
// the canon route style.
export async function POST(req: Request) {
  const db = getDb();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }
  const seriesId = Number(body.seriesId);
  if (!Number.isFinite(seriesId) || !getSeries(db, seriesId)) {
    return NextResponse.json(
      { error: "seriesId must name an existing series" },
      { status: 400 },
    );
  }
  const project = createProject(db, { title, seriesId });
  return NextResponse.json({ project }, { status: 201 });
}
