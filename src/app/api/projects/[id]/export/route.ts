import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import { buildExport } from "@/lib/export";

// Export (SPEC section 8). Downloads a single Markdown file of every locked
// chapter's latest draft version, in order.
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await ctx.params;
  const project = getProject(db, Number(id));
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  const { filename, content } = buildExport(db, project);
  return new NextResponse(content, {
    status: 200,
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
