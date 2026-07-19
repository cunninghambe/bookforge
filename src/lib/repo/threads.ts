import { and, asc, eq, isNull, or, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { getProject } from "./projects";

type Db = BetterSQLite3Database<typeof schema>;

// A16: resolve the series a thread belongs to. A book thread inherits its book's
// series; a series-wide thread names its series explicitly, else defaults to the
// first series (the repo default; the MCP tool layer is stricter).
function resolveThreadSeriesId(
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

// Amendment A12: story threads. A thread is a standing narrative line; a touch is
// one chapter's contact with it. project_id NULL means series-wide, like canon.

export const THREAD_TYPES = ["arc", "mystery", "promise", "relationship"] as const;
export type ThreadType = (typeof THREAD_TYPES)[number];

export const THREAD_STATUSES = ["open", "resolved", "retired"] as const;
export type ThreadStatus = (typeof THREAD_STATUSES)[number];

export const TOUCH_KINDS = ["advance", "complicate", "payoff", "mention"] as const;
export type TouchKind = (typeof TOUCH_KINDS)[number];

export type Thread = typeof schema.threads.$inferSelect;
export type ThreadTouch = typeof schema.threadTouches.$inferSelect;

// A touch enriched with its chapter's 0-based order and book, so flag and
// assembly logic never has to re-join. chapterOrder stays 0-based (the A2 1-based
// conversion happens only at the UI/tool boundary).
export interface TouchWithChapter extends ThreadTouch {
  chapterOrder: number;
  chapterProjectId: number;
}

export function isThreadType(v: unknown): v is ThreadType {
  return typeof v === "string" && (THREAD_TYPES as readonly string[]).includes(v);
}

export function isThreadStatus(v: unknown): v is ThreadStatus {
  return typeof v === "string" && (THREAD_STATUSES as readonly string[]).includes(v);
}

export function isTouchKind(v: unknown): v is TouchKind {
  return typeof v === "string" && (TOUCH_KINDS as readonly string[]).includes(v);
}

export interface ThreadFilter {
  // A book id. When set, the result includes that book's threads AND series-wide
  // (project_id NULL) threads OF THAT BOOK'S SERIES (A16), so a book view sees the
  // threads it must keep warm and never another series' series-wide threads. Omit
  // to list every thread.
  projectId?: number;
  status?: ThreadStatus;
}

export function listThreads(db: Db, filter: ThreadFilter = {}): Thread[] {
  const conds: SQL[] = [];
  if (typeof filter.projectId === "number") {
    const seriesId = getProject(db, filter.projectId)?.seriesId ?? null;
    // This book's own threads, plus series-wide threads of this book's series.
    conds.push(
      or(
        eq(schema.threads.projectId, filter.projectId),
        and(
          isNull(schema.threads.projectId),
          seriesId === null
            ? isNull(schema.threads.seriesId)
            : eq(schema.threads.seriesId, seriesId),
        ),
      )!,
    );
  }
  if (filter.status) conds.push(eq(schema.threads.status, filter.status));
  const where = conds.length ? and(...conds) : undefined;
  return db
    .select()
    .from(schema.threads)
    .where(where)
    .orderBy(asc(schema.threads.id))
    .all();
}

export function getThread(db: Db, id: number): Thread | undefined {
  return db
    .select()
    .from(schema.threads)
    .where(eq(schema.threads.id, id))
    .get();
}

export interface CreateThreadInput {
  projectId?: number | null;
  // A16: the owning series. Inferred from projectId for a book thread; defaults to
  // the first series for a series-wide thread when omitted (the MCP tool layer is
  // stricter and rejects omitting both).
  seriesId?: number | null;
  name: string;
  type: ThreadType;
  status?: ThreadStatus;
  characterAId?: number | null;
  characterBId?: number | null;
  note?: string | null;
}

export function createThread(db: Db, input: CreateThreadInput): Thread {
  return db
    .insert(schema.threads)
    .values({
      projectId: input.projectId ?? null,
      seriesId: resolveThreadSeriesId(db, {
        projectId: input.projectId,
        seriesId: input.seriesId,
      }),
      name: input.name,
      type: input.type,
      status: input.status ?? "open",
      characterAId: input.characterAId ?? null,
      characterBId: input.characterBId ?? null,
      note: input.note ?? null,
    })
    .returning()
    .get();
}

export interface UpdateThreadInput {
  name?: string;
  note?: string | null;
  status?: ThreadStatus;
  characterAId?: number | null;
  characterBId?: number | null;
}

export function updateThread(
  db: Db,
  id: number,
  input: UpdateThreadInput,
): Thread | undefined {
  const patch: Partial<typeof schema.threads.$inferInsert> = {};
  if (input.name !== undefined) patch.name = input.name;
  if (input.note !== undefined) patch.note = input.note;
  if (input.status !== undefined) patch.status = input.status;
  if (input.characterAId !== undefined) patch.characterAId = input.characterAId;
  if (input.characterBId !== undefined) patch.characterBId = input.characterBId;
  if (Object.keys(patch).length === 0) return getThread(db, id);
  return db
    .update(schema.threads)
    .set(patch)
    .where(eq(schema.threads.id, id))
    .returning()
    .get();
}

export interface AddTouchInput {
  threadId: number;
  chapterId: number;
  kind: TouchKind;
  evidence?: string | null;
  // 'manual' (default), 'extraction:<chapter_id>', or 'mcp'.
  source?: string | null;
}

export function addTouch(db: Db, input: AddTouchInput): ThreadTouch {
  return db
    .insert(schema.threadTouches)
    .values({
      threadId: input.threadId,
      chapterId: input.chapterId,
      kind: input.kind,
      evidence: input.evidence ?? null,
      source: input.source ?? "manual",
    })
    .returning()
    .get();
}

// A thread's touches, ordered chronologically by the touched chapter's order (ties
// break by touch id). Each row carries the chapter's 0-based order and book id.
export function listTouches(db: Db, threadId: number): TouchWithChapter[] {
  return db
    .select({
      id: schema.threadTouches.id,
      threadId: schema.threadTouches.threadId,
      chapterId: schema.threadTouches.chapterId,
      kind: schema.threadTouches.kind,
      evidence: schema.threadTouches.evidence,
      source: schema.threadTouches.source,
      createdAt: schema.threadTouches.createdAt,
      chapterOrder: schema.chapters.orderIndex,
      chapterProjectId: schema.chapters.projectId,
    })
    .from(schema.threadTouches)
    .innerJoin(
      schema.chapters,
      eq(schema.threadTouches.chapterId, schema.chapters.id),
    )
    .where(eq(schema.threadTouches.threadId, threadId))
    .orderBy(asc(schema.chapters.orderIndex), asc(schema.threadTouches.id))
    .all();
}
