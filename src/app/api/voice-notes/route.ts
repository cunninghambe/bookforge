import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChapter } from "@/lib/repo/chapters";
import { latestDraft } from "@/lib/repo/drafts";
import { createComment } from "@/lib/repo/comments";
import { sttEnabled } from "@/lib/audio/config";
import { transcribeAudio } from "@/lib/audio/stt";
import { anchorForParagraph } from "@/lib/audio/anchor";

// POST a voice note: recorded audio plus a chapter id and the paragraph index that
// was playing or selected. The audio is forwarded to the STT bridge; the transcript
// becomes an inline comment on the chapter's LATEST draft, anchored (quoted_text)
// to the opening sentence of the target paragraph. Returns the created comment and
// the transcript so the client can show it with an inline edit and an undo. 404s
// when STT is not configured.
//
// Accepts either multipart/form-data (field `audio` plus `chapterId` and
// `paragraphIndex`) or JSON ({ chapterId, paragraphIndex, audioBase64, mime }).

interface Parsed {
  audio: Uint8Array;
  filename: string;
  mime: string;
  chapterId: number;
  paragraphIndex: number;
}

async function parseRequest(req: Request): Promise<Parsed | null> {
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("audio");
    if (!(file instanceof Blob)) return null;
    const chapterId = Number(form.get("chapterId"));
    const paragraphIndex = Number(form.get("paragraphIndex"));
    if (!Number.isFinite(chapterId) || !Number.isInteger(paragraphIndex)) {
      return null;
    }
    return {
      audio: new Uint8Array(await file.arrayBuffer()),
      filename: file instanceof File && file.name ? file.name : "note.webm",
      mime: file.type || "audio/webm",
      chapterId,
      paragraphIndex,
    };
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
  const chapterId = Number(body.chapterId);
  const paragraphIndex = Number(body.paragraphIndex);
  const audioBase64 = typeof body.audioBase64 === "string" ? body.audioBase64 : "";
  if (
    !Number.isFinite(chapterId) ||
    !Number.isInteger(paragraphIndex) ||
    audioBase64 === ""
  ) {
    return null;
  }
  return {
    audio: new Uint8Array(Buffer.from(audioBase64, "base64")),
    filename: typeof body.filename === "string" ? body.filename : "note.webm",
    mime: typeof body.mime === "string" ? body.mime : "audio/webm",
    chapterId,
    paragraphIndex,
  };
}

export async function POST(req: Request) {
  if (!sttEnabled()) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const parsed = await parseRequest(req);
  if (!parsed) {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const db = getDb();
  const chapter = getChapter(db, parsed.chapterId);
  if (!chapter) {
    return NextResponse.json({ error: "chapter not found" }, { status: 404 });
  }
  const draft = latestDraft(db, chapter.id);
  if (!draft) {
    return NextResponse.json({ error: "no draft to anchor to" }, { status: 409 });
  }
  const anchor = anchorForParagraph(draft.content, parsed.paragraphIndex);
  if (!anchor) {
    return NextResponse.json({ error: "paragraph out of range" }, { status: 400 });
  }

  const transcript = await transcribeAudio(
    parsed.audio,
    parsed.filename,
    parsed.mime,
  );
  if (transcript === "") {
    return NextResponse.json({ error: "empty transcript" }, { status: 422 });
  }

  const comment = createComment(db, {
    draftId: draft.id,
    quotedText: anchor.quotedText,
    comment: transcript,
    spanStart: anchor.spanStart,
    spanEnd: anchor.spanEnd,
  });
  return NextResponse.json({ comment, transcript });
}
