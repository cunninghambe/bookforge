import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import { CANON_TYPES, type CanonType } from "@/lib/repo/canon";
import {
  approveBible,
  type ApprovedBibleFact,
  type ApprovedBibleCharacter,
  type ApprovedBibleState,
} from "@/lib/repo/bible";

// The approval gate for the series-bible importer (Amendment A3). Only the
// proposals the author explicitly approved are sent here. Approved facts become
// LOCKED canon (source 'bible') at the chosen scope; approved characters are
// created, or updated when they carry the id of an existing row; approved states
// (book scope only) land at chapter_order 0 (source 'bible'). A state naming a
// character that cannot be resolved even after this batch's character creations
// rejects the whole call: nothing is created.
export async function POST(req: Request) {
  const db = getDb();

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const str = (v: unknown) =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  // Scope: "series" or a valid book id.
  let scope: "series" | number;
  if (body.scope === "series") {
    scope = "series";
  } else {
    const n = Number(body.scope);
    if (!Number.isFinite(n) || !getProject(db, n)) {
      return NextResponse.json(
        { error: "scope must be 'series' or a valid book id" },
        { status: 400 },
      );
    }
    scope = n;
  }

  const facts: ApprovedBibleFact[] = [];
  if (Array.isArray(body.facts)) {
    for (const raw of body.facts) {
      if (!raw || typeof raw !== "object") continue;
      const f = raw as Record<string, unknown>;
      const content = str(f.content);
      if (!content) continue;
      if (!(CANON_TYPES as readonly string[]).includes(f.type as string)) continue;
      facts.push({ type: f.type as CanonType, content });
    }
  }

  const characters: ApprovedBibleCharacter[] = [];
  if (Array.isArray(body.characters)) {
    for (const raw of body.characters) {
      if (!raw || typeof raw !== "object") continue;
      const c = raw as Record<string, unknown>;
      const name = str(c.name);
      if (!name) continue;
      characters.push({
        id: typeof c.id === "number" ? c.id : null,
        name,
        role: str(c.role),
        voiceRules: str(c.voiceRules),
        physical: str(c.physical),
        notes: str(c.notes),
      });
    }
  }

  const states: ApprovedBibleState[] = [];
  if (Array.isArray(body.states)) {
    for (const raw of body.states) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      states.push({
        characterId: typeof s.characterId === "number" ? s.characterId : null,
        character: str(s.character),
        knows: str(s.knows),
        feels: str(s.feels),
        hiding: str(s.hiding),
      });
    }
  }

  if (facts.length === 0 && characters.length === 0 && states.length === 0) {
    return NextResponse.json({ error: "nothing approved" }, { status: 400 });
  }

  const result = approveBible(db, { scope, facts, characters, states });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, unmatched: result.unmatched },
      { status: 400 },
    );
  }
  return NextResponse.json({
    ok: true,
    createdFacts: result.createdFacts,
    createdCharacters: result.createdCharacters,
    updatedCharacters: result.updatedCharacters,
    createdStates: result.createdStates,
  });
}
