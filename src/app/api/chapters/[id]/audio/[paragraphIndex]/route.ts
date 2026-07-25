import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChapter } from "@/lib/repo/chapters";
import { latestDraft } from "@/lib/repo/drafts";
import { ttsEnabled, voiceId } from "@/lib/audio/config";
import { splitParagraphs } from "@/lib/audio/paragraphs";
import { cacheKey, readCached, writeCached } from "@/lib/audio/cache";
import { detectFfmpeg, chooseAudioFormat, transcodeWavToOpus } from "@/lib/audio/ffmpeg";
import { synthesizeSpeech } from "@/lib/audio/tts";
import { stripEmphasis } from "@/lib/markdown";

type Ctx = { params: Promise<{ id: string; paragraphIndex: string }> };

// GET a single paragraph's audio. Serves from the content-addressed cache on a hit;
// on a miss it synthesizes via the TTS bridge, transcodes to the serving format
// when ffmpeg is present, caches, and serves. 404s when TTS is not configured or
// the paragraph index is out of range; 502s when the TTS service itself fails.
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

  // A21: emphasis is display-only. Paragraph SPLITTING stays on the raw content
  // (indices and voice-note anchoring are unchanged), but the text handed to the
  // synthesizer and used for the cache key is the marker-stripped text, derived
  // once here so the spoken audio and its cache key can never diverge.
  const text = stripEmphasis(paragraphs[index]);
  const key = cacheKey(text, voiceId());
  const { ext, contentType } = chooseAudioFormat(await detectFfmpeg());

  let bytes = readCached(key, ext);
  let serveType = contentType;
  if (!bytes) {
    // D195: the TTS bridge is a network call to an on-box service that can be
    // down, restarting, or erroring. Unhandled, that exception escaped the route
    // and the player got an opaque failure mid-chapter, which is the field
    // report behind this fix. A 502 is the honest answer and the player already
    // knows how to show Retry for it (D165). The underlying message is logged
    // rather than returned: it comes from another service and the client has no
    // use for it (A23 kept service and subprocess text off the wire).
    let wav: Buffer;
    try {
      wav = await synthesizeSpeech(text);
    } catch (err) {
      console.error(
        `tts synthesis failed: chapter=${chapter.id} paragraph=${index}: ${
          (err as Error).message
        }`,
      );
      return NextResponse.json(
        { error: "the speech service is unavailable" },
        { status: 502 },
      );
    }
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
