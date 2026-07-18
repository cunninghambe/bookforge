import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChapter } from "@/lib/repo/chapters";
import { latestDraft } from "@/lib/repo/drafts";
import { ttsEnabled, voiceId } from "@/lib/audio/config";
import { splitParagraphs } from "@/lib/audio/paragraphs";
import { cacheKey, readCached, writeCached } from "@/lib/audio/cache";
import { detectFfmpeg, chooseAudioFormat, transcodeWavToOpus } from "@/lib/audio/ffmpeg";
import { synthesizeSpeech } from "@/lib/audio/tts";

type Ctx = { params: Promise<{ id: string; paragraphIndex: string }> };

// GET a single paragraph's audio. Serves from the content-addressed cache on a hit;
// on a miss it synthesizes via the TTS bridge, transcodes to the serving format
// when ffmpeg is present, caches, and serves. 404s when TTS is not configured or
// the paragraph index is out of range.
export async function GET(_req: Request, ctx: Ctx) {
  if (!ttsEnabled()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const db = getDb();
  const { id, paragraphIndex } = await ctx.params;
  const chapter = getChapter(db, Number(id));
  if (!chapter) return NextResponse.json({ error: "not found" }, { status: 404 });

  const index = Number(paragraphIndex);
  const draft = latestDraft(db, chapter.id);
  const paragraphs = splitParagraphs(draft?.content ?? "");
  if (!Number.isInteger(index) || index < 0 || index >= paragraphs.length) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const text = paragraphs[index];
  const key = cacheKey(text, voiceId());
  const { ext, contentType } = chooseAudioFormat(await detectFfmpeg());

  let bytes = readCached(key, ext);
  let serveType = contentType;
  if (!bytes) {
    const wav = await synthesizeSpeech(text);
    if (ext === "opus") {
      try {
        bytes = await transcodeWavToOpus(wav);
      } catch {
        // Transcode hiccup: serve the WAV as is rather than surfacing an error.
        bytes = wav;
        serveType = "audio/wav";
      }
    } else {
      bytes = wav;
    }
    // Cache only under the format we actually produced.
    writeCached(key, serveType === "audio/wav" ? "wav" : ext, bytes);
  }

  return new NextResponse(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": serveType,
      "Content-Length": String(bytes.byteLength),
      "Cache-Control": "private, max-age=3600",
    },
  });
}
