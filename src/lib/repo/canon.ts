import { and, desc, eq, inArray, isNull, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { getProject } from "./projects";

type Db = BetterSQLite3Database<typeof schema>;

// A16: resolve the series a canon fact belongs to. A book fact inherits its
// book's series; a series-wide fact names its series explicitly, else defaults to
// the first series (the API's documented default when a caller omits it). Kept
// local to avoid importing the series repo (which imports this module).
function resolveSeriesId(
  db: Db,
  args: { projectId?: number | null; seriesId?: number | null },
): number | null {
  if (typeof args.seriesId === "number") return args.seriesId;
  if (typeof args.projectId === "number") {
    return getProject(db, args.projectId)?.seriesId ?? firstSeriesIdLocal(db);
  }
  return firstSeriesIdLocal(db);
}

function firstSeriesIdLocal(db: Db): number | null {
  const row = db
    .select({ id: schema.series.id })
    .from(schema.series)
    .orderBy(schema.series.orderIndex, schema.series.id)
    .get();
  return row ? row.id : null;
}

export const CANON_TYPES = [
  "world_rule",
  "style_rule",
  "timeline_event",
  "character_fact",
  "plot_decision",
] as const;
export type CanonType = (typeof CANON_TYPES)[number];

export const CANON_STATUSES = ["locked", "provisional", "retired"] as const;
export type CanonStatus = (typeof CANON_STATUSES)[number];

export type CanonFact = typeof schema.canonFacts.$inferSelect;

export interface CanonFilter {
  type?: CanonType;
  status?: CanonStatus;
  // scope: "series" = project_id NULL, a number = that book, undefined = all.
  scope?: "series" | number;
  // A16: narrow to one series (across scopes). Omit to list across all series
  // (the default global browse). Combines with scope: scope "series" + seriesId
  // is that series' series-wide facts.
  seriesId?: number;
}

export function listCanon(db: Db, filter: CanonFilter = {}): CanonFact[] {
  const conds: SQL[] = [];
  if (filter.type) conds.push(eq(schema.canonFacts.type, filter.type));
  if (filter.status) conds.push(eq(schema.canonFacts.status, filter.status));
  if (typeof filter.seriesId === "number") {
    conds.push(eq(schema.canonFacts.seriesId, filter.seriesId));
  }
  if (filter.scope === "series") {
    conds.push(isNull(schema.canonFacts.projectId));
  } else if (typeof filter.scope === "number") {
    conds.push(eq(schema.canonFacts.projectId, filter.scope));
  }
  const where = conds.length ? and(...conds) : undefined;
  return db
    .select()
    .from(schema.canonFacts)
    .where(where)
    .orderBy(desc(schema.canonFacts.createdAt), desc(schema.canonFacts.id))
    .all();
}

export function getCanon(db: Db, id: number): CanonFact | undefined {
  return db
    .select()
    .from(schema.canonFacts)
    .where(eq(schema.canonFacts.id, id))
    .get();
}

export interface CreateCanonInput {
  projectId?: number | null;
  // A16: the owning series. Inferred from projectId when omitted (a book fact),
  // else defaults to the first series (a series-wide fact with no explicit
  // series). The MCP tool layer is stricter and rejects omitting both.
  seriesId?: number | null;
  type: CanonType;
  content: string;
  status?: CanonStatus;
  source?: string;
}

export function createCanon(db: Db, input: CreateCanonInput): CanonFact {
  const row = db
    .insert(schema.canonFacts)
    .values({
      projectId: input.projectId ?? null,
      seriesId: resolveSeriesId(db, {
        projectId: input.projectId,
        seriesId: input.seriesId,
      }),
      type: input.type,
      content: input.content,
      status: input.status ?? "provisional",
      source: input.source ?? "manual",
    })
    .returning()
    .get();
  return row;
}

export interface UpdateCanonInput {
  content?: string;
  type?: CanonType;
  status?: CanonStatus;
  projectId?: number | null;
}

export function updateCanon(
  db: Db,
  id: number,
  input: UpdateCanonInput,
): CanonFact | undefined {
  const patch: Partial<typeof schema.canonFacts.$inferInsert> = {};
  if (input.content !== undefined) patch.content = input.content;
  if (input.type !== undefined) patch.type = input.type;
  if (input.status !== undefined) patch.status = input.status;
  if (input.projectId !== undefined) patch.projectId = input.projectId;
  if (Object.keys(patch).length === 0) return getCanon(db, id);
  return db
    .update(schema.canonFacts)
    .set(patch)
    .where(eq(schema.canonFacts.id, id))
    .returning()
    .get();
}

export function deleteCanon(db: Db, id: number): void {
  db.delete(schema.canonFacts).where(eq(schema.canonFacts.id, id)).run();
}

// Bulk paste: one fact per line, created provisional. Blank lines are skipped.
export function bulkCreateCanon(
  db: Db,
  args: {
    lines: string;
    type: CanonType;
    projectId?: number | null;
    seriesId?: number | null;
  },
): CanonFact[] {
  const created: CanonFact[] = [];
  const lines = args.lines
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  for (const content of lines) {
    created.push(
      createCanon(db, {
        projectId: args.projectId ?? null,
        seriesId: args.seriesId ?? null,
        type: args.type,
        content,
        status: "provisional",
        source: "manual",
      }),
    );
  }
  return created;
}

// Facts that are eligible for prompt assembly: locked and not retired, in scope.
// A16: "in scope" is this book, plus series-wide (project_id NULL) facts of THIS
// book's series, never another series' series-wide facts. Defined here to keep
// canon logic together; used by the context assembler, chat, sweep, extraction.
export function assemblableCanon(
  db: Db,
  args: { projectId: number; types?: CanonType[] },
): CanonFact[] {
  const seriesId = getProject(db, args.projectId)?.seriesId ?? null;
  const conds: SQL[] = [eq(schema.canonFacts.status, "locked")];
  if (args.types && args.types.length > 0) {
    conds.push(inArray(schema.canonFacts.type, args.types));
  }
  const rows = db
    .select()
    .from(schema.canonFacts)
    .where(and(...conds))
    .orderBy(schema.canonFacts.id)
    .all();
  return rows.filter(
    (r) =>
      r.projectId === args.projectId ||
      (r.projectId === null && r.seriesId === seriesId),
  );
}
