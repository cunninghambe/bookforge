import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { CANON_TYPES, type CanonType } from "@/lib/repo/canon";
import {
  approveExtraction,
  type ApprovedFact,
  type ApprovedNewThread,
  type ApprovedState,
  type ApprovedThreadAttach,
} from "@/lib/repo/extraction";
import {
  isThreadType,
  isTouchKind,
  type ThreadType,
  type TouchKind,
} from "@/lib/repo/threads";

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

  // A12: approved thread attaches (existing thread id + touch kind) and new-thread
  // proposals (name + type + touch kind). Invalid kinds/types are dropped here so
  // the gate only persists well-formed touches.
  const threadAttaches: ApprovedThreadAttach[] = [];
  if (Array.isArray(body.threadAttaches)) {
    for (const raw of body.threadAttaches) {
      if (!raw || typeof raw !== "object") continue;
      const a = raw as Record<string, unknown>;
      if (typeof a.threadId !== "number") continue;
      if (!isTouchKind(a.kind)) continue;
      threadAttaches.push({
        threadId: a.threadId,
        kind: a.kind as TouchKind,
        evidence:
          typeof a.evidence === "string" && a.evidence.trim()
            ? a.evidence.trim()
            : null,
      });
    }
  }

  const newThreads: ApprovedNewThread[] = [];
  if (Array.isArray(body.newThreads)) {
    for (const raw of body.newThreads) {
      if (!raw || typeof raw !== "object") continue;
      const n = raw as Record<string, unknown>;
      const name = typeof n.name === "string" ? n.name.trim() : "";
      if (!name) continue;
      if (!isThreadType(n.type)) continue;
      if (!isTouchKind(n.kind)) continue;
      newThreads.push({
        name,
        type: n.type as ThreadType,
        kind: n.kind as TouchKind,
        evidence:
          typeof n.evidence === "string" && n.evidence.trim()
            ? n.evidence.trim()
            : null,
      });
    }
  }

  if (
    facts.length === 0 &&
    states.length === 0 &&
    threadAttaches.length === 0 &&
    newThreads.length === 0
  ) {
    return NextResponse.json(
      { error: "nothing approved" },
      { status: 400 },
    );
  }

  const result = approveExtraction(db, {
    chapterId,
    facts,
    states,
    threadAttaches,
    newThreads,
  });
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
    createdThreads: result.createdThreads,
    createdTouches: result.createdTouches,
  });
}
