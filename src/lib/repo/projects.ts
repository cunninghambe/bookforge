import { asc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";

type Db = BetterSQLite3Database<typeof schema>;

export type Project = typeof schema.projects.$inferSelect;

export function listProjects(db: Db): Project[] {
  return db
    .select()
    .from(schema.projects)
    .orderBy(asc(schema.projects.orderIndex))
    .all();
}

// A16: a series' books, in reading order. order_index is scoped within a series,
// so ties across series never interleave a single series' books.
export function listProjectsBySeries(db: Db, seriesId: number): Project[] {
  return db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.seriesId, seriesId))
    .orderBy(asc(schema.projects.orderIndex), asc(schema.projects.id))
    .all();
}

export function getProject(db: Db, id: number): Project | undefined {
  return db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
    .get();
}

// A16: the first book of a series (lowest order_index), used to deep-link a
// series-wide thread search hit to "the first book of ITS series".
export function firstProjectOfSeries(
  db: Db,
  seriesId: number,
): Project | undefined {
  return listProjectsBySeries(db, seriesId)[0];
}

export interface CreateProjectInput {
  title: string;
  seriesId: number;
}

// A16: create a book at the end of its series. order_index is the next position
// within that series (0-based), so a new series' first book is order 0 exactly
// like the trilogy's Book 1.
export function createProject(db: Db, input: CreateProjectInput): Project {
  const maxRow = db
    .select({ max: sql<number>`COALESCE(MAX(${schema.projects.orderIndex}), -1)` })
    .from(schema.projects)
    .where(eq(schema.projects.seriesId, input.seriesId))
    .get();
  const nextIndex = (maxRow?.max ?? -1) + 1;
  return db
    .insert(schema.projects)
    .values({
      title: input.title,
      orderIndex: nextIndex,
      seriesId: input.seriesId,
    })
    .returning()
    .get();
}

export function updateProjectTitle(
  db: Db,
  id: number,
  title: string,
): Project | undefined {
  return db
    .update(schema.projects)
    .set({ title })
    .where(eq(schema.projects.id, id))
    .returning()
    .get();
}
