import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChapter } from "@/lib/repo/chapters";
import { assemblePrompt } from "@/lib/assembler";

// Dev-only JSON dump of the fully assembled prompt for one chapter, for logging
// and inspection. Disabled in production.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ chapterId: string }> },
) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const db = getDb();
  const { chapterId } = await ctx.params;
  const chapter = getChapter(db, Number(chapterId));
  if (!chapter) return NextResponse.json({ error: "not found" }, { status: 404 });

  const url = new URL(req.url);
  const beatsParam = url.searchParams.get("beats");
  const targetBeatIndices = beatsParam
    ? beatsParam.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n))
    : chapter.beats.map((_, i) => i);

  const assembled = assemblePrompt(db, {
    chapterId: chapter.id,
    targetBeatIndices,
  });
  return NextResponse.json(assembled);
}
