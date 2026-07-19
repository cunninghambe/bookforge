import { and, asc, eq, lte } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";

type Db = BetterSQLite3Database<typeof schema>;

export type Character = typeof schema.characters.$inferSelect;
export type CharacterState = typeof schema.characterStates.$inferSelect;

// A16: the first series' id, the documented default owner for a character created
// without an explicit series (the API defaults; the UI switcher always names one).
function firstSeriesIdLocal(db: Db): number | null {
  const row = db
    .select({ id: schema.series.id })
    .from(schema.series)
    .orderBy(schema.series.orderIndex, schema.series.id)
    .get();
  return row ? row.id : null;
}

// A16: list characters, optionally scoped to one series. Omit seriesId to list
// every character across all series (kept for the rare global need); pass a
// seriesId to get exactly that series' roster (assembler, chat, extraction, the
// characters page switcher). A character belongs to exactly one series.
export function listCharacters(db: Db, seriesId?: number): Character[] {
  const q = db.select().from(schema.characters);
  const rows =
    typeof seriesId === "number"
      ? q.where(eq(schema.characters.seriesId, seriesId))
      : q;
  return rows.orderBy(asc(schema.characters.name)).all();
}

export function getCharacter(db: Db, id: number): Character | undefined {
  return db
    .select()
    .from(schema.characters)
    .where(eq(schema.characters.id, id))
    .get();
}

export interface CharacterInput {
  name: string;
  // A16: the owning series. Defaults to the first series when omitted (the API's
  // documented default so pre-A16 create calls keep working); the UI always names
  // one via the series switcher.
  seriesId?: number | null;
  role?: string | null;
  voiceRules?: string | null;
  physical?: string | null;
  notes?: string | null;
}

export function createCharacter(db: Db, input: CharacterInput): Character {
  return db
    .insert(schema.characters)
    .values({
      seriesId:
        typeof input.seriesId === "number"
          ? input.seriesId
          : firstSeriesIdLocal(db),
      name: input.name,
      role: input.role ?? null,
      voiceRules: input.voiceRules ?? null,
      physical: input.physical ?? null,
      notes: input.notes ?? null,
    })
    .returning()
    .get();
}

export function updateCharacter(
  db: Db,
  id: number,
  input: Partial<CharacterInput>,
): Character | undefined {
  const patch: Partial<typeof schema.characters.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.role !== undefined) patch.role = input.role;
  if (input.voiceRules !== undefined) patch.voiceRules = input.voiceRules;
  if (input.physical !== undefined) patch.physical = input.physical;
  if (input.notes !== undefined) patch.notes = input.notes;
  if (Object.keys(patch).length === 0) return getCharacter(db, id);
  return db
    .update(schema.characters)
    .set(patch)
    .where(eq(schema.characters.id, id))
    .returning()
    .get();
}

export function deleteCharacter(db: Db, id: number): void {
  db.delete(schema.characterStates)
    .where(eq(schema.characterStates.characterId, id))
    .run();
  db.delete(schema.characters).where(eq(schema.characters.id, id)).run();
}

// State timeline for a character, ordered by book then chapter_order.
export function listStates(db: Db, characterId: number): CharacterState[] {
  return db
    .select()
    .from(schema.characterStates)
    .where(eq(schema.characterStates.characterId, characterId))
    .orderBy(
      asc(schema.characterStates.projectId),
      asc(schema.characterStates.chapterOrder),
    )
    .all();
}

export interface StateInput {
  characterId: number;
  projectId: number;
  chapterOrder: number;
  knows?: string | null;
  feels?: string | null;
  hiding?: string | null;
  // 'manual' for UI-created states, 'extraction:<chapter_id>' for approved
  // lock-time proposals. Defaults to 'manual'.
  source?: string | null;
}

export function addState(db: Db, input: StateInput): CharacterState {
  return db
    .insert(schema.characterStates)
    .values({
      characterId: input.characterId,
      projectId: input.projectId,
      chapterOrder: input.chapterOrder,
      knows: input.knows ?? null,
      feels: input.feels ?? null,
      hiding: input.hiding ?? null,
      source: input.source ?? "manual",
    })
    .returning()
    .get();
}

// Finds a character by exact name, case-insensitive. Used to resolve extraction
// state proposals to an existing character before approval (Amendment A1). A16:
// pass a seriesId to resolve within one series only, so a same-named character in
// another series never matches.
export function findCharacterByName(
  db: Db,
  name: string,
  seriesId?: number,
): Character | undefined {
  const target = name.trim().toLowerCase();
  if (!target) return undefined;
  return listCharacters(db, seriesId).find(
    (c) => c.name.trim().toLowerCase() === target,
  );
}

export function deleteState(db: Db, id: number): void {
  db.delete(schema.characterStates)
    .where(eq(schema.characterStates.id, id))
    .run();
}

// Effective state as of chapter N: the most recent row with chapter_order <= N
// for that character in that book. Used by the context assembler.
export function effectiveState(
  db: Db,
  args: { characterId: number; projectId: number; chapterOrder: number },
): CharacterState | undefined {
  const rows = db
    .select()
    .from(schema.characterStates)
    .where(
      and(
        eq(schema.characterStates.characterId, args.characterId),
        eq(schema.characterStates.projectId, args.projectId),
        lte(schema.characterStates.chapterOrder, args.chapterOrder),
      ),
    )
    .orderBy(asc(schema.characterStates.chapterOrder))
    .all();
  return rows.length ? rows[rows.length - 1] : undefined;
}
