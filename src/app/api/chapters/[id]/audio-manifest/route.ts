import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChapter } from "@/lib/repo/chapters";
import { latestDraft } from "@/lib/repo/drafts";
import { ttsEnabled, voiceId } from "@/lib/audio/config";
import { detectFfmpeg, chooseAudioFormat } from "@/lib/audio/ffmpeg";
import { isCached } from "@/lib/audio/cache";
import { buildManifest } from "@/lib/audio/manifest";

type Ctx = { params: Promise<{ id: string }> };

// GET the audio manifest for a chapter's latest draft: paragraph count, serving
// format, and per-paragraph cache state. 404s when TTS is not configured, so a
// fresh clone shows no trace of the feature.
export async function GET(_req: Request, ctx: Ctx) {
  if (!ttsEnabled()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const db = getDb();
  const { id } = await ctx.params;
  const chapter = getChapter(db, Number(id));
  if (!chapter) return NextResponse.json({ error: "not found" }, { status: 404 });

  const draft = latestDraft(db, chapter.id);
  const content = draft?.content ?? "";
  const { format, ext } = chooseAudioFormat(await detectFfmpeg());
  const manifest = buildManifest({
    chapterId: chapter.id,
    content,
    voiceId: voiceId(),
    format,
    ext,
    probeCached: isCached,
  });
  return NextResponse.json(manifest);
}
