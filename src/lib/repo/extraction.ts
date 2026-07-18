import { and, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { createCanon, type CanonFact, type CanonType } from "./canon";
import {
  addState,
  findCharacterByName,
  getCharacter,
  type CharacterState,
} from "./characters";
import { getChapter, updateChapter } from "./chapters";
import {
  addTouch,
  createThread,
  getThread,
  type Thread,
  type ThreadTouch,
  type ThreadType,
  type TouchKind,
} from "./threads";

type Db = BetterSQLite3Database<typeof schema>;

// One approved fact proposal becomes a LOCKED canon fact sourced to the chapter.
export interface ApprovedFact {
  type: CanonType;
  content: string;
}

// One approved state proposal. The character must resolve to an existing row:
// either an explicit characterId or a name that matches (Amendment A1). knows /
// feels / hiding are editable before approval.
export interface ApprovedState {
  characterId?: number | null;
  character?: string | null;
  knows?: string | null;
  feels?: string | null;
  hiding?: string | null;
}

// A12: one approved attach becomes a thread_touch on an EXISTING thread, sourced
// to the chapter. The thread must still exist at approval time.
export interface ApprovedThreadAttach {
  threadId: number;
  kind: TouchKind;
  evidence?: string | null;
}

// A12: one approved new-thread proposal becomes a thread plus its first touch,
// created atomically inside the same approval transaction.
export interface ApprovedNewThread {
  name: string;
  type: ThreadType;
  kind: TouchKind;
  evidence?: string | null;
}

export interface ApproveInput {
  chapterId: number;
  facts: ApprovedFact[];
  states: ApprovedState[];
  // A12: optional so every existing caller (facts + states only) is unchanged.
  threadAttaches?: ApprovedThreadAttach[];
  newThreads?: ApprovedNewThread[];
}

export type ApproveResult =
  | {
      ok: true;
      createdFacts: CanonFact[];
      createdStates: CharacterState[];
      createdThreads: Thread[];
      createdTouches: ThreadTouch[];
    }
  | { ok: false; error: string; unmatched: string[] };

// Resolves an approved state to an existing character id, or null if it cannot be
// matched. An explicit, existing characterId wins; otherwise the name is matched
// exactly (case-insensitive).
function resolveCharacterId(db: Db, s: ApprovedState): number | null {
  if (typeof s.characterId === "number" && getCharacter(db, s.characterId)) {
    return s.characterId;
  }
  if (s.character) {
    const found = findCharacterByName(db, s.character);
    if (found) return found.id;
  }
  return null;
}

// The approval gate (SPEC section 6 + Amendment A1). Nothing lands without an
// explicit approval, and nothing lands at all if any approved state names a
// character that does not resolve to an existing row: the whole call is rejected
// so the author can map or create the character first. Approved facts become
// LOCKED canon; approved states insert at chapter_order = locked order_index + 1.
export function approveExtraction(db: Db, input: ApproveInput): ApproveResult {
  const chapter = getChapter(db, input.chapterId);
  if (!chapter) {
    return { ok: false, error: "chapter not found", unmatched: [] };
  }
  const source = `extraction:${chapter.id}`;
  const targetOrder = chapter.orderIndex + 1;

  // Resolve every state first; do not create anything if one is unmatched.
  const resolved: Array<{ characterId: number; s: ApprovedState }> = [];
  const unmatched: string[] = [];
  for (const s of input.states) {
    const cid = resolveCharacterId(db, s);
    if (cid === null) {
      unmatched.push((s.character ?? "").trim() || "(unnamed)");
    } else {
      resolved.push({ characterId: cid, s });
    }
  }
  // A12: an approved attach must target a thread that still exists. A dangling
  // threadId rejects the whole call, like an unmatched state, so nothing lands.
  const attachTargets: ApprovedThreadAttach[] = [];
  for (const a of input.threadAttaches ?? []) {
    if (!getThread(db, a.threadId)) {
      unmatched.push(`thread ${a.threadId}`);
    } else {
      attachTargets.push(a);
    }
  }
  if (unmatched.length > 0) {
    return {
      ok: false,
      error: "some proposals reference an unknown character or thread",
      unmatched,
    };
  }

  const createdFacts: CanonFact[] = [];
  const createdStates: CharacterState[] = [];
  const createdThreads: Thread[] = [];
  const createdTouches: ThreadTouch[] = [];
  db.transaction(() => {
    for (const f of input.facts) {
      createdFacts.push(
        createCanon(db, {
          projectId: chapter.projectId,
          type: f.type,
          content: f.content,
          status: "locked",
          source,
        }),
      );
    }
    for (const { characterId, s } of resolved) {
      createdStates.push(
        addState(db, {
          characterId,
          projectId: chapter.projectId,
          chapterOrder: targetOrder,
          knows: s.knows ?? null,
          feels: s.feels ?? null,
          hiding: s.hiding ?? null,
          source,
        }),
      );
    }
    // A12: approved attaches add a touch on this chapter to the existing thread.
    for (const a of attachTargets) {
      createdTouches.push(
        addTouch(db, {
          threadId: a.threadId,
          chapterId: chapter.id,
          kind: a.kind,
          evidence: a.evidence ?? null,
          source,
        }),
      );
    }
    // A12: approved new-thread proposals create the thread and its first touch
    // together, atomically, in the same book as the chapter.
    for (const n of input.newThreads ?? []) {
      const thread = createThread(db, {
        projectId: chapter.projectId,
        name: n.name,
        type: n.type,
        status: "open",
      });
      createdThreads.push(thread);
      createdTouches.push(
        addTouch(db, {
          threadId: thread.id,
          chapterId: chapter.id,
          kind: n.kind,
          evidence: n.evidence ?? null,
          source,
        }),
      );
    }
  });

  return { ok: true, createdFacts, createdStates, createdThreads, createdTouches };
}

// Facts extracted from a given chapter (source 'extraction:<chapterId>').
export function extractedFacts(db: Db, chapterId: number): CanonFact[] {
  return db
    .select()
    .from(schema.canonFacts)
    .where(eq(schema.canonFacts.source, `extraction:${chapterId}`))
    .all();
}

// Unlocking a locked chapter (SPEC section 6.d). Editing requires an explicit
// unlock, which flags the summary and the extracted facts as stale for
// regeneration. Representation (judgment call, D24): status returns to 'review',
// the summary is cleared so a re-lock regenerates it, and every fact extracted
// from this chapter drops from 'locked' to 'provisional' so it leaves prompt
// assembly and must pass the approval gate again. Extracted state rows are left
// intact; a re-lock re-proposes deltas. This never softens the approval gate: it
// removes facts from canon rather than adding any.
export function unlockChapter(db: Db, chapterId: number) {
  const chapter = getChapter(db, chapterId);
  if (!chapter) return undefined;
  db.transaction(() => {
    db.update(schema.canonFacts)
      .set({ status: "provisional" })
      .where(
        and(
          eq(schema.canonFacts.status, "locked"),
          eq(schema.canonFacts.source, `extraction:${chapterId}`),
        ),
      )
      .run();
    updateChapter(db, chapterId, { status: "review", summary: null });
  });
  return getChapter(db, chapterId);
}
