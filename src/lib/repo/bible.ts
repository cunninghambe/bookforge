import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { createCanon, type CanonFact, type CanonType } from "./canon";
import {
  addState,
  createCharacter,
  findCharacterByName,
  getCharacter,
  updateCharacter,
  type Character,
  type CharacterState,
} from "./characters";
import { getProject } from "./projects";
import { firstSeriesId } from "./series";

type Db = BetterSQLite3Database<typeof schema>;

// The approval side of the series-bible importer (Amendment A3). The same gate
// discipline as every other approval path: nothing lands without an explicit
// approval, and the whole call is rejected (nothing created) if any approved state
// names a character that cannot be resolved even after this batch's own character
// creations.

// One approved fact proposal becomes a LOCKED canon fact with source 'bible' at the
// chosen scope.
export interface ApprovedBibleFact {
  type: CanonType;
  content: string;
}

// One approved character proposal. An id set means it matched an existing row and
// is applied as an UPDATE (only the non-empty provided fields are written, so an
// empty proposal field never wipes existing data). No id means a new row is
// created.
export interface ApprovedBibleCharacter {
  id?: number | null;
  name: string;
  role?: string | null;
  voiceRules?: string | null;
  physical?: string | null;
  notes?: string | null;
}

// One approved state proposal. Resolves to a character by explicit id, else by name
// (case-insensitive), including characters created earlier in this same batch.
export interface ApprovedBibleState {
  characterId?: number | null;
  character?: string | null;
  knows?: string | null;
  feels?: string | null;
  hiding?: string | null;
}

export interface BibleApproveInput {
  // "series" = series-wide (project_id null for facts). A number = that book.
  // States require a book scope (a number); a series scope with any state is
  // rejected.
  scope: "series" | number;
  // A16: the owning series for created facts and characters. For a book scope it
  // is derived from the book (ignored if passed); for a series scope it names the
  // series, defaulting to the first series when omitted.
  seriesId?: number;
  facts: ApprovedBibleFact[];
  characters: ApprovedBibleCharacter[];
  states: ApprovedBibleState[];
}

export type BibleApproveResult =
  | {
      ok: true;
      createdFacts: CanonFact[];
      createdCharacters: Character[];
      updatedCharacters: Character[];
      createdStates: CharacterState[];
    }
  | { ok: false; error: string; unmatched: string[] };

// Sentinel used to roll the whole transaction back when a state cannot resolve, so
// nothing is created (the atomic gate). Caught immediately outside the transaction.
class UnmatchedStates extends Error {
  constructor(public unmatched: string[]) {
    super("some state proposals name an unknown character");
  }
}

function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

export function approveBible(db: Db, input: BibleApproveInput): BibleApproveResult {
  const projectId = input.scope === "series" ? null : input.scope;
  const source = "bible";
  // A16: the series every created fact and character lands in. A book scope
  // inherits the book's series; a series scope uses the named series, else the
  // first series (the documented default).
  const seriesId =
    typeof projectId === "number"
      ? getProject(db, projectId)?.seriesId ?? firstSeriesId(db) ?? undefined
      : input.seriesId ?? firstSeriesId(db) ?? undefined;

  // States require a book scope. Enforced on the server even though the UI hides
  // the states section for a series-wide import.
  if (input.states.length > 0 && input.scope === "series") {
    return {
      ok: false,
      error: "character states require a book scope, not series-wide",
      unmatched: [],
    };
  }

  const createdFacts: CanonFact[] = [];
  const createdCharacters: Character[] = [];
  const updatedCharacters: Character[] = [];
  const createdStates: CharacterState[] = [];

  try {
    db.transaction(() => {
      // 1. Characters first, so a same-batch state can resolve against a row this
      //    call is creating.
      for (const c of input.characters) {
        if (typeof c.id === "number" && getCharacter(db, c.id)) {
          // UPDATE: only apply the non-empty provided fields.
          const patch: {
            role?: string | null;
            voiceRules?: string | null;
            physical?: string | null;
            notes?: string | null;
          } = {};
          if (nonEmpty(c.role) !== null) patch.role = nonEmpty(c.role);
          if (nonEmpty(c.voiceRules) !== null) patch.voiceRules = nonEmpty(c.voiceRules);
          if (nonEmpty(c.physical) !== null) patch.physical = nonEmpty(c.physical);
          if (nonEmpty(c.notes) !== null) patch.notes = nonEmpty(c.notes);
          const updated = updateCharacter(db, c.id, patch);
          if (updated) updatedCharacters.push(updated);
        } else {
          const created = createCharacter(db, {
            name: c.name,
            seriesId,
            role: nonEmpty(c.role),
            voiceRules: nonEmpty(c.voiceRules),
            physical: nonEmpty(c.physical),
            notes: nonEmpty(c.notes),
          });
          createdCharacters.push(created);
        }
      }

      // 2. Resolve every state now that this batch's characters exist. An explicit,
      //    existing characterId wins; otherwise the name is matched case-insensitively
      //    (which now includes the rows just created).
      const resolved: Array<{ characterId: number; s: ApprovedBibleState }> = [];
      const unmatched: string[] = [];
      for (const s of input.states) {
        let cid: number | null = null;
        if (typeof s.characterId === "number" && getCharacter(db, s.characterId)) {
          cid = s.characterId;
        } else if (s.character) {
          const found = findCharacterByName(db, s.character, seriesId);
          if (found) cid = found.id;
        }
        if (cid === null) {
          unmatched.push((s.character ?? "").trim() || "(unnamed)");
        } else {
          resolved.push({ characterId: cid, s });
        }
      }
      if (unmatched.length > 0) {
        throw new UnmatchedStates(unmatched);
      }

      // 3. Facts become LOCKED canon at the chosen scope, source 'bible'.
      for (const f of input.facts) {
        createdFacts.push(
          createCanon(db, {
            projectId,
            seriesId,
            type: f.type,
            content: f.content,
            status: "locked",
            source,
          }),
        );
      }

      // 4. States land at chapter_order 0 (effective from the book's first chapter
      //    onward), source 'bible'.
      for (const { characterId, s } of resolved) {
        createdStates.push(
          addState(db, {
            characterId,
            projectId: projectId as number, // a book scope is guaranteed when states exist
            chapterOrder: 0,
            knows: nonEmpty(s.knows),
            feels: nonEmpty(s.feels),
            hiding: nonEmpty(s.hiding),
            source,
          }),
        );
      }
    });
  } catch (err) {
    if (err instanceof UnmatchedStates) {
      return {
        ok: false,
        error: "some state proposals name an unknown character",
        unmatched: err.unmatched,
      };
    }
    throw err;
  }

  return {
    ok: true,
    createdFacts,
    createdCharacters,
    updatedCharacters,
    createdStates,
  };
}
