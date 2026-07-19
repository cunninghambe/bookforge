import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createCharacter, listCharacters } from "@/lib/repo/characters";
import { firstSeriesId } from "@/lib/repo/series";

// A16: characters are scoped by series. GET returns one series' roster when a
// seriesId query param is present, else every character across all series (kept
// so pre-A16 global callers still work). POST defaults an omitted seriesId to the
// first series (the documented default that keeps pre-A16 create calls working);
// the characters page always names one via its switcher.
export async function GET(req: Request) {
  const db = getDb();
  const url = new URL(req.url);
  const seriesIdRaw = url.searchParams.get("seriesId");
  const seriesId =
    seriesIdRaw !== null && Number.isFinite(Number(seriesIdRaw))
      ? Number(seriesIdRaw)
      : undefined;
  return NextResponse.json({ characters: listCharacters(db, seriesId) });
}

export async function POST(req: Request) {
  const db = getDb();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const name = body.name;
  if (typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "name required" }, { status: 400 });
  }
  const seriesId =
    typeof body.seriesId === "number" ? body.seriesId : firstSeriesId(db);
  const character = createCharacter(db, {
    name: name.trim(),
    seriesId,
    role: typeof body.role === "string" ? body.role : null,
    voiceRules: typeof body.voiceRules === "string" ? body.voiceRules : null,
    physical: typeof body.physical === "string" ? body.physical : null,
    notes: typeof body.notes === "string" ? body.notes : null,
  });
  return NextResponse.json({ character }, { status: 201 });
}
