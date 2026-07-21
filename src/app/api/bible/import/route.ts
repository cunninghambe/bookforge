import { NextResponse } from "next/server";
import { chunkBible } from "@/lib/bibleChunks";

// Series-bible importer, PLAN call (Amendment A20). The original design ran every
// chunk's model call inside this one request; on a real bible the request outlived
// the serving chain and died as a 500 after minutes (D166: a 24k-char chunk alone
// asked the model for 12,000 to 15,000 output tokens, far past the deployment
// transport's per-call output cap, so the call errored, and a whole bible is several
// such calls in one request). This endpoint now only PLANS: it validates the pasted
// text, splits it on paragraph boundaries with chunkBible, and returns the chunk
// texts and count. The client then drives the run one chunk per request against
// POST /api/bible/import/chunk (which resolves the A16 scope and rebuilds the dedup
// context), so no HTTP request ever spans more than one model call. No model call and
// nothing written here.
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) {
    return NextResponse.json({ error: "bible text required" }, { status: 400 });
  }

  const chunks = chunkBible(text);
  return NextResponse.json({ ok: true, count: chunks.length, chunks });
}
