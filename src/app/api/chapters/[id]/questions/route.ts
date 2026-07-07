import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { listQuestions } from "@/lib/repo/chapters";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await ctx.params;
  const chapterId = Number(id);
  if (!Number.isFinite(chapterId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  return NextResponse.json({ questions: listQuestions(db, chapterId) });
}
