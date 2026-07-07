import { and, asc, desc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";

type Db = BetterSQLite3Database<typeof schema>;

export type Draft = typeof schema.drafts.$inferSelect;

// Latest (highest version) draft for a chapter.
export function latestDraft(db: Db, chapterId: number): Draft | undefined {
  return db
    .select()
    .from(schema.drafts)
    .where(eq(schema.drafts.chapterId, chapterId))
    .orderBy(desc(schema.drafts.version))
    .get();
}

export function getDraft(db: Db, id: number): Draft | undefined {
  return db.select().from(schema.drafts).where(eq(schema.drafts.id, id)).get();
}

export function listDrafts(db: Db, chapterId: number): Draft[] {
  return db
    .select()
    .from(schema.drafts)
    .where(eq(schema.drafts.chapterId, chapterId))
    .orderBy(asc(schema.drafts.version))
    .all();
}

function nextVersion(db: Db, chapterId: number): number {
  const row = db
    .select({ max: sql<number>`COALESCE(MAX(${schema.drafts.version}), 0)` })
    .from(schema.drafts)
    .where(eq(schema.drafts.chapterId, chapterId))
    .get();
  return (row?.max ?? 0) + 1;
}

// Creates a brand new draft version with the given content.
export function createDraftVersion(
  db: Db,
  chapterId: number,
  content: string,
): Draft {
  return db
    .insert(schema.drafts)
    .values({ chapterId, version: nextVersion(db, chapterId), content })
    .returning()
    .get();
}

// Saves the working draft: updates the latest version in place, or creates
// version 1 if none exists. Used while drafting scene-by-scene so a chapter has a
// single evolving working draft until a revision or lock creates a new version.
export function saveWorkingDraft(
  db: Db,
  chapterId: number,
  content: string,
): Draft {
  const current = latestDraft(db, chapterId);
  if (!current) return createDraftVersion(db, chapterId, content);
  return db
    .update(schema.drafts)
    .set({ content })
    .where(eq(schema.drafts.id, current.id))
    .returning()
    .get();
}
