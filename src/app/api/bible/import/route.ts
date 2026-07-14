import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { runBibleImport } from "@/lib/bibleImport";

// Series-bible importer (Amendment A3). Reads the pasted bible (or one chunk of a
// long one) with the bible-purpose model, returns categorized proposals
// (facts, characters, states) for the approval checklist. Nothing is written here;
// approval goes through POST /api/bible/approve. Long inputs are split on paragraph
// boundaries at ~24,000 chars per call and processed sequentially; parse failures
// surface the raw text per chunk.
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
    return NextResponse.json({ error: "bible text required" }, { status: 400 });
  }
  const fixtureKey =
    typeof body.fixtureKey === "string" ? body.fixtureKey : undefined;

  const result = await runBibleImport(db, { text, fixtureKey });
  return NextResponse.json({ ok: true, ...result });
}
