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

// A17: one approved touch inside a scan group. Unlike a lock-time approval, a
// scan touch names its own chapter, because one merged group can span several
// scanned chapters; the source is stamped 'scan:<chapter_id>' per touch.
export interface ScanApprovedTouch {
  chapterId: number;
  kind: TouchKind;
  evidence?: string | null;
}

// A17: an approved attach group adds touches to an existing thread.
export interface ScanApprovedAttach {
  threadId: number;
  touches: ScanApprovedTouch[];
}

// A17: an approved new-thread group creates the thread and all its approved
// touches together, atomically.
export interface ScanApprovedNew {
  name: string;
  type: ThreadType;
  touches: ScanApprovedTouch[];
}

export interface ApproveScanInput {
  projectId: number;
  attaches: ScanApprovedAttach[];
  newThreads: ScanApprovedNew[];
}

export type ApproveScanResult =
  | { ok: true; createdThreads: Thread[]; createdTouches: ThreadTouch[] }
  | { ok: false; error: string; unmatched: string[] };

// The scan approval gate (Amendment A17). Only the touches the author explicitly
// approved land here. Every referenced chapter must be a LOCKED chapter of this
// book and every attach must target a thread that still exists; any dangling
// reference rejects the WHOLE call (atomic, no trace), exactly like
// approveExtraction, so a partial run never half-writes. Approved attaches insert
// touches on the existing thread; approved new-thread groups create the thread and
// its touches together. Every touch is sourced 'scan:<chapter_id>' so its
// provenance is distinguishable from lock-time 'extraction:<chapter_id>'.
export function approveScan(db: Db, input: ApproveScanInput): ApproveScanResult {
  const unmatched = new Set<string>();
  const chapterValid = new Map<number, boolean>();
  const isLockedChapter = (chapterId: number): boolean => {
    const cached = chapterValid.get(chapterId);
    if (cached !== undefined) return cached;
    const ch = getChapter(db, chapterId);
    const ok =
      !!ch && ch.projectId === input.projectId && ch.status === "locked";
    chapterValid.set(chapterId, ok);
    return ok;
  };

  for (const a of input.attaches) {
    if (!getThread(db, a.threadId)) unmatched.add(`thread ${a.threadId}`);
    for (const t of a.touches) {
      if (!isLockedChapter(t.chapterId)) unmatched.add(`chapter ${t.chapterId}`);
    }
  }
  for (const n of input.newThreads) {
    for (const t of n.touches) {
      if (!isLockedChapter(t.chapterId)) unmatched.add(`chapter ${t.chapterId}`);
    }
  }
  if (unmatched.size > 0) {
    return {
      ok: false,
      error: "some proposals reference an unknown thread or a non-locked chapter",
      unmatched: [...unmatched],
    };
  }

  const createdThreads: Thread[] = [];
  const createdTouches: ThreadTouch[] = [];
  db.transaction(() => {
    for (const a of input.attaches) {
      for (const t of a.touches) {
        createdTouches.push(
          addTouch(db, {
            threadId: a.threadId,
            chapterId: t.chapterId,
            kind: t.kind,
            evidence: t.evidence ?? null,
            source: `scan:${t.chapterId}`,
          }),
        );
      }
    }
    for (const n of input.newThreads) {
      const thread = createThread(db, {
        projectId: input.projectId,
        name: n.name,
        type: n.type,
        status: "open",
      });
      createdThreads.push(thread);
      for (const t of n.touches) {
        createdTouches.push(
          addTouch(db, {
            threadId: thread.id,
            chapterId: t.chapterId,
            kind: t.kind,
            evidence: t.evidence ?? null,
            source: `scan:${t.chapterId}`,
          }),
        );
      }
    }
  });

  return { ok: true, createdThreads, createdTouches };
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
