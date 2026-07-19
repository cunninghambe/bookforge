import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getSeries, updateSeriesTitle } from "@/lib/repo/series";

// Amendment A16: rename a series (title only). No delete or archive: removal
// stays a manual database operation (recorded non-goal).
type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const seriesId = Number(id);
  if (!Number.isFinite(seriesId) || !getSeries(db, seriesId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
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
  const series = updateSeriesTitle(db, seriesId, title);
  return NextResponse.json({ series });
}
