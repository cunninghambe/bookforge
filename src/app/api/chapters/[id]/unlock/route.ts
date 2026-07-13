import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChapter } from "@/lib/repo/chapters";
import { unlockChapter } from "@/lib/repo/extraction";

// Unlocks a locked chapter so it can be edited (SPEC section 6.d). Flags the
// summary and extracted facts as stale for regeneration: status returns to
// 'review', the summary is cleared, and facts extracted from this chapter drop
// from locked to provisional (leaving prompt assembly until re-approved).
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await ctx.params;
  const chapterId = Number(id);
  const chapter = getChapter(db, chapterId);
  if (!chapter) return NextResponse.json({ error: "not found" }, { status: 404 });
  if (chapter.status !== "locked") {
    return NextResponse.json(
      { error: "chapter is not locked" },
      { status: 400 },
    );
  }
  const updated = unlockChapter(db, chapterId);
  return NextResponse.json({ chapter: updated });
}
