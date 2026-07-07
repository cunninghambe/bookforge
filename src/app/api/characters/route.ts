import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createCharacter, listCharacters } from "@/lib/repo/characters";

export async function GET() {
  const db = getDb();
  return NextResponse.json({ characters: listCharacters(db) });
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
  const character = createCharacter(db, {
    name: name.trim(),
    role: typeof body.role === "string" ? body.role : null,
    voiceRules: typeof body.voiceRules === "string" ? body.voiceRules : null,
    physical: typeof body.physical === "string" ? body.physical : null,
    notes: typeof body.notes === "string" ? body.notes : null,
  });
  return NextResponse.json({ character }, { status: 201 });
}
