import { asc, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { SEED_STYLE_RULES } from "../db/migrate";
import { createCanon } from "./canon";
import { createProject, type Project } from "./projects";

type Db = BetterSQLite3Database<typeof schema>;

// Amendment A16: series are the first-class container that scopes canon,
// characters, and threads. A book (project) belongs to exactly one series.

export type Series = typeof schema.series.$inferSelect;

export function listSeries(db: Db): Series[] {
  return db
    .select()
    .from(schema.series)
    .orderBy(asc(schema.series.orderIndex), asc(schema.series.id))
    .all();
}

export function getSeries(db: Db, id: number): Series | undefined {
  return db.select().from(schema.series).where(eq(schema.series.id, id)).get();
}

// The default series id: the lowest-ordered series. Used as the fallback owner
// wherever a caller creates a series-wide item without naming its series (the API
// defaults to the first series; see DECISIONS). Returns null only on a database
// with no series at all, which never happens after migrate + seed.
export function firstSeriesId(db: Db): number | null {
  const row = listSeries(db)[0];
  return row ? row.id : null;
}

export function updateSeriesTitle(
  db: Db,
  id: number,
  title: string,
): Series | undefined {
  return db
    .update(schema.series)
    .set({ title })
    .where(eq(schema.series.id, id))
    .returning()
    .get();
}

export interface CreateSeriesInput {
  title: string;
  // The default title of the first book created in the new series. Editable from
  // the home page afterwards.
  firstBookTitle?: string;
}

export interface CreateSeriesResult {
  series: Series;
  firstBook: Project;
}

// Creates a series, COPIES the five seed style rules into it as locked series-wide
// style_rule facts (source 'seed'), and creates its first book with a default
// title, so the author lands ready to write (SPEC A16). The copied rules are
// independent of every other series' copies: a series can retire or edit its own
// without touching another's.
export function createSeries(db: Db, input: CreateSeriesInput): CreateSeriesResult {
  const maxRow = db
    .select({ max: sql<number>`COALESCE(MAX(${schema.series.orderIndex}), -1)` })
    .from(schema.series)
    .get();
  const orderIndex = (maxRow?.max ?? -1) + 1;

  const series = db
    .insert(schema.series)
    .values({ title: input.title, orderIndex })
    .returning()
    .get();

  for (const content of SEED_STYLE_RULES) {
    createCanon(db, {
      projectId: null,
      seriesId: series.id,
      type: "style_rule",
      content,
      status: "locked",
      source: "seed",
    });
  }

  const firstBook = createProject(db, {
    title: input.firstBookTitle?.trim() || "Book 1",
    seriesId: series.id,
  });

  return { series, firstBook };
}
