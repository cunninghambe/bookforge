import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { CANON_TYPES, type CanonType } from "@/lib/repo/canon";
import {
  approveExtraction,
  type ApprovedFact,
  type ApprovedState,
} from "@/lib/repo/extraction";

// The approval gate (SPEC section 6 + Amendment A1). Only the proposals the author
// explicitly approved are sent here. Approved facts become LOCKED canon sourced to
// the chapter; approved states insert at chapter_order = locked order_index + 1.
// A state naming a character that does not resolve to an existing row is rejected
// for the whole call: the author must map it to a character or create one first.
export async function POST(req: Request) {
  const db = getDb();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const chapterId = Number(body.chapterId);
  if (!Number.isFinite(chapterId)) {
    return NextResponse.json({ error: "chapterId required" }, { status: 400 });
  }

  const facts: ApprovedFact[] = [];
  if (Array.isArray(body.facts)) {
    for (const raw of body.facts) {
      if (!raw || typeof raw !== "object") continue;
      const f = raw as Record<string, unknown>;
      const type = f.type;
      const content = typeof f.content === "string" ? f.content.trim() : "";
      if (!content) continue;
      if (!(CANON_TYPES as readonly string[]).includes(type as string)) continue;
      facts.push({ type: type as CanonType, content });
    }
  }

  const states: ApprovedState[] = [];
  if (Array.isArray(body.states)) {
    for (const raw of body.states) {
      if (!raw || typeof raw !== "object") continue;
      const s = raw as Record<string, unknown>;
      const str = (v: unknown) =>
        typeof v === "string" && v.trim() ? v.trim() : null;
      states.push({
        characterId:
          typeof s.characterId === "number" ? s.characterId : null,
        character: str(s.character),
        knows: str(s.knows),
        feels: str(s.feels),
        hiding: str(s.hiding),
      });
    }
  }

  if (facts.length === 0 && states.length === 0) {
    return NextResponse.json(
      { error: "nothing approved" },
      { status: 400 },
    );
  }

  const result = approveExtraction(db, { chapterId, facts, states });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, unmatched: result.unmatched },
      { status: 400 },
    );
  }
  return NextResponse.json({
    ok: true,
    createdFacts: result.createdFacts,
    createdStates: result.createdStates,
  });
}
