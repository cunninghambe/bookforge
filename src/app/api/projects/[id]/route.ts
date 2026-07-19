import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProject, updateProjectTitle } from "@/lib/repo/projects";

// Amendment A16: rename a book (title only). No delete or archive: removal stays
// a manual database operation (recorded non-goal). Note: this shares the
// /api/projects/[id] path prefix with the existing export/import/sweep routes,
// which live under further sub-paths, so there is no collision.
type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const projectId = Number(id);
  if (!Number.isFinite(projectId) || !getProject(db, projectId)) {
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
  const project = updateProjectTitle(db, projectId, title);
  return NextResponse.json({ project });
}
