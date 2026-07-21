import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getLlmClient } from "@/lib/llm/client";
import { modelFor } from "@/lib/modelFor";
import { importBibleChunk, bibleDedupContext } from "@/lib/bibleImport";
import { getProject } from "@/lib/repo/projects";
import { firstSeriesId } from "@/lib/repo/series";

// Series-bible importer, PER-CHUNK call (Amendment A20). Runs exactly ONE chunk of
// the bible: one model call (purpose "bible", logged), returning that chunk's
// proposals and any parse failure. A request can never outlive a single model call
// (the fix D166 documents: the old all-in-one request died as a 500 after minutes).
// The dedup context (current locked canon plus roster, series-scoped per A16) is
// rebuilt per request, byte-identical to the context runBibleImport builds once, so
// the prompt bytes match across the run. Per-call model and parse failures arrive
// inside the returned parseFailure (A2.2); a request-level error (bad body, DB load)
// surfaces its reason here, never a bare failure. Nothing is written; approval stays
// the separate gated POST /api/bible/approve.
export async function POST(req: Request) {
  const db = getDb();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const text = typeof body.text === "string" ? body.text : "";
  if (!text.trim()) {
    return NextResponse.json({ error: "chunk text required" }, { status: 400 });
  }
  const position = Number(body.position);
  const totalChunks = Number(body.totalChunks);
  const fixtureKey =
    typeof body.fixtureKey === "string" ? body.fixtureKey : undefined;

  // A16: resolve the dedup scope to a series exactly as the old single-request route
  // did. A book scope resolves to the book's series; a series-wide scope (or an
  // absent/unknown scope) resolves to the first series (the documented default).
  let seriesId: number | undefined;
  if (typeof body.scope === "number") {
    seriesId = getProject(db, body.scope)?.seriesId ?? undefined;
  } else if (body.scope !== "series" && Number.isFinite(Number(body.scope))) {
    seriesId = getProject(db, Number(body.scope))?.seriesId ?? undefined;
  }
  if (seriesId === undefined) seriesId = firstSeriesId(db) ?? undefined;

  try {
    const outcome = await importBibleChunk(db, getLlmClient(), {
      chunk: text,
      position: Number.isFinite(position) ? position : 1,
      totalChunks: Number.isFinite(totalChunks) ? totalChunks : 1,
      context: bibleDedupContext(db, seriesId),
      model: modelFor(db, "bible"),
      fixtureKey,
    });
    return NextResponse.json(outcome);
  } catch (err) {
    // A2.2: the underlying reason, never a bare failure. Per-call LLM and parse
    // failures already arrive inside outcome.parseFailure; this path is a
    // request-level error (canon/roster load).
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Bible import failed: ${message}` },
      { status: 400 },
    );
  }
}
