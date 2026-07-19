import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { runBibleImport } from "@/lib/bibleImport";
import { getProject } from "@/lib/repo/projects";
import { firstSeriesId } from "@/lib/repo/series";

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

  // A16: scope the dedup context (known canon + roster) to the target series. A
  // book scope resolves to the book's series; a series-wide scope (or an absent
  // scope) resolves to the first series (the documented default).
  let seriesId: number | undefined;
  if (typeof body.scope === "number") {
    seriesId = getProject(db, body.scope)?.seriesId ?? undefined;
  } else if (body.scope !== "series" && Number.isFinite(Number(body.scope))) {
    seriesId = getProject(db, Number(body.scope))?.seriesId ?? undefined;
  }
  if (seriesId === undefined) seriesId = firstSeriesId(db) ?? undefined;

  const result = await runBibleImport(db, { text, fixtureKey, seriesId });
  return NextResponse.json({ ok: true, ...result });
}
