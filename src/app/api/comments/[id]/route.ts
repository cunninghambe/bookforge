import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getComment, updateComment } from "@/lib/repo/comments";

type Ctx = { params: Promise<{ id: string }> };

// Edits a comment's text and/or its resolved flag.
export async function PATCH(req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const commentId = Number(id);
  if (!Number.isFinite(commentId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  if (!getComment(db, commentId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const updated = updateComment(db, commentId, {
    comment: typeof body.comment === "string" ? body.comment : undefined,
    resolved:
      typeof body.resolved === "boolean" ? body.resolved : undefined,
  });
  return NextResponse.json({ comment: updated });
}
