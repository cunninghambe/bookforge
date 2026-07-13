import { and, asc, eq, gte, isNull, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";

type Db = BetterSQLite3Database<typeof schema>;

export type ChapterRow = typeof schema.chapters.$inferSelect;
export type QuestionRow = typeof schema.questions.$inferSelect;

export const CHAPTER_STATUSES = [
  "planned",
  "interrogating",
  "drafting",
  "review",
  "locked",
] as const;
export type ChapterStatus = (typeof CHAPTER_STATUSES)[number];

// A chapter with beats/dependencies decoded from their JSON columns.
export interface Chapter extends Omit<ChapterRow, "beats" | "dependencies"> {
  beats: string[];
  dependencies: number[];
}

function decode(row: ChapterRow): Chapter {
  return {
    ...row,
    beats: parseJsonArray<string>(row.beats),
    dependencies: parseJsonArray<number>(row.dependencies),
  };
}

function parseJsonArray<T>(s: string | null): T[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

export function listChapters(db: Db, projectId: number): Chapter[] {
  return db
    .select()
    .from(schema.chapters)
    .where(eq(schema.chapters.projectId, projectId))
    .orderBy(asc(schema.chapters.orderIndex))
    .all()
    .map(decode);
}

export function getChapter(db: Db, id: number): Chapter | undefined {
  const row = db
    .select()
    .from(schema.chapters)
    .where(eq(schema.chapters.id, id))
    .get();
  return row ? decode(row) : undefined;
}

export interface CreateChapterInput {
  projectId: number;
  title?: string;
  pov?: string;
  synopsis?: string;
  beats?: string[];
}

export function createChapter(db: Db, input: CreateChapterInput): Chapter {
  const maxRow = db
    .select({ max: sql<number>`COALESCE(MAX(${schema.chapters.orderIndex}), -1)` })
    .from(schema.chapters)
    .where(eq(schema.chapters.projectId, input.projectId))
    .get();
  const nextIndex = (maxRow?.max ?? -1) + 1;
  const row = db
    .insert(schema.chapters)
    .values({
      projectId: input.projectId,
      orderIndex: nextIndex,
      title: input.title ?? null,
      pov: input.pov ?? null,
      synopsis: input.synopsis ?? null,
      beats: JSON.stringify(input.beats ?? []),
      dependencies: JSON.stringify([]),
      status: "planned",
    })
    .returning()
    .get();
  return decode(row);
}

export interface UpdateChapterInput {
  title?: string | null;
  pov?: string | null;
  synopsis?: string | null;
  beats?: string[];
  dependencies?: number[];
  summary?: string | null;
  status?: ChapterStatus;
}

export function updateChapter(
  db: Db,
  id: number,
  input: UpdateChapterInput,
): Chapter | undefined {
  const patch: Partial<typeof schema.chapters.$inferInsert> = {};
  if (input.title !== undefined) patch.title = input.title;
  if (input.pov !== undefined) patch.pov = input.pov;
  if (input.synopsis !== undefined) patch.synopsis = input.synopsis;
  if (input.beats !== undefined) patch.beats = JSON.stringify(input.beats);
  if (input.dependencies !== undefined)
    patch.dependencies = JSON.stringify(input.dependencies);
  if (input.summary !== undefined) patch.summary = input.summary;
  if (input.status !== undefined) patch.status = input.status;
  if (Object.keys(patch).length === 0) return getChapter(db, id);
  const row = db
    .update(schema.chapters)
    .set(patch)
    .where(eq(schema.chapters.id, id))
    .returning()
    .get();
  return row ? decode(row) : undefined;
}

export function deleteChapter(db: Db, id: number): void {
  db.delete(schema.chapters).where(eq(schema.chapters.id, id)).run();
}

export interface ImportChapterInput {
  projectId: number;
  title: string;
  orderIndex: number;
}

// Creates a chapter directly in 'locked' status at a confirmed order position
// (SPEC section 7, the backfill importer). The chapter is never observable in an
// unlocked state, even if a later step in the importer fails. Every existing
// chapter at or after orderIndex shifts down by one; order_index carries no
// uniqueness constraint, so the shift can be applied in any order inside one
// transaction.
export function createChapterAtOrder(db: Db, input: ImportChapterInput): Chapter {
  let created!: Chapter;
  db.transaction((tx) => {
    const toShift = tx
      .select()
      .from(schema.chapters)
      .where(
        and(
          eq(schema.chapters.projectId, input.projectId),
          gte(schema.chapters.orderIndex, input.orderIndex),
        ),
      )
      .all();
    for (const c of toShift) {
      tx.update(schema.chapters)
        .set({ orderIndex: c.orderIndex + 1 })
        .where(eq(schema.chapters.id, c.id))
        .run();
    }
    const row = tx
      .insert(schema.chapters)
      .values({
        projectId: input.projectId,
        orderIndex: input.orderIndex,
        title: input.title,
        beats: JSON.stringify([]),
        dependencies: JSON.stringify([]),
        status: "locked",
      })
      .returning()
      .get();
    created = decode(row);
  });
  return created;
}

// Persist a new order. orderedIds is the full list of this book's chapter ids in
// the desired sequence; order_index becomes the array position.
export function reorderChapters(
  db: Db,
  projectId: number,
  orderedIds: number[],
): void {
  db.transaction((tx) => {
    orderedIds.forEach((id, i) => {
      tx.update(schema.chapters)
        .set({ orderIndex: i })
        .where(
          and(
            eq(schema.chapters.id, id),
            eq(schema.chapters.projectId, projectId),
          ),
        )
        .run();
    });
  });
}

// The most recent locked chapter strictly before this chapter in the same book.
export function previousLockedChapter(
  db: Db,
  chapter: Chapter,
): Chapter | undefined {
  const rows = db
    .select()
    .from(schema.chapters)
    .where(
      and(
        eq(schema.chapters.projectId, chapter.projectId),
        eq(schema.chapters.status, "locked"),
      ),
    )
    .orderBy(asc(schema.chapters.orderIndex))
    .all()
    .map(decode)
    .filter((c) => c.orderIndex < chapter.orderIndex);
  return rows.length ? rows[rows.length - 1] : undefined;
}

// All locked chapters before this one, in order (for the STORY SO FAR block).
export function priorLockedChapters(db: Db, chapter: Chapter): Chapter[] {
  return db
    .select()
    .from(schema.chapters)
    .where(
      and(
        eq(schema.chapters.projectId, chapter.projectId),
        eq(schema.chapters.status, "locked"),
      ),
    )
    .orderBy(asc(schema.chapters.orderIndex))
    .all()
    .map(decode)
    .filter((c) => c.orderIndex < chapter.orderIndex);
}

// ---- Questions ------------------------------------------------------------

export function listQuestions(db: Db, chapterId: number): QuestionRow[] {
  return db
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.chapterId, chapterId))
    .orderBy(asc(schema.questions.id))
    .all();
}

export function getQuestion(db: Db, id: number): QuestionRow | undefined {
  return db
    .select()
    .from(schema.questions)
    .where(eq(schema.questions.id, id))
    .get();
}

export function createQuestions(
  db: Db,
  chapterId: number,
  questions: string[],
): QuestionRow[] {
  const created: QuestionRow[] = [];
  db.transaction((tx) => {
    for (const q of questions) {
      created.push(
        tx
          .insert(schema.questions)
          .values({ chapterId, question: q })
          .returning()
          .get(),
      );
    }
  });
  return created;
}

export function answerQuestion(
  db: Db,
  id: number,
  answer: string,
  resultingFactId: number | null,
): QuestionRow | undefined {
  return db
    .update(schema.questions)
    .set({ answer, resultingFactId })
    .where(eq(schema.questions.id, id))
    .returning()
    .get();
}

// Count of interrogation questions with no answer yet. Used for the soft block on
// entering drafting.
export function unansweredQuestionCount(db: Db, chapterId: number): number {
  const row = db
    .select({ n: sql<number>`COUNT(*)` })
    .from(schema.questions)
    .where(
      and(
        eq(schema.questions.chapterId, chapterId),
        isNull(schema.questions.answer),
      ),
    )
    .get();
  return row?.n ?? 0;
}
