import { asc, eq } from "drizzle-orm";
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

export function getProject(db: Db, id: number): Project | undefined {
  return db
    .select()
    .from(schema.projects)
    .where(eq(schema.projects.id, id))
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
