import { and, asc, eq, isNull, or, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";

type Db = BetterSQLite3Database<typeof schema>;

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
  // (project_id NULL) threads, so a book view sees the threads it must keep warm.
  // Omit to list every thread.
  projectId?: number;
  status?: ThreadStatus;
}

export function listThreads(db: Db, filter: ThreadFilter = {}): Thread[] {
  const conds: SQL[] = [];
  if (typeof filter.projectId === "number") {
    conds.push(
      or(
        isNull(schema.threads.projectId),
        eq(schema.threads.projectId, filter.projectId),
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
