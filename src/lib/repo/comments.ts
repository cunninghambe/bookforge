import { and, asc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { findSpan } from "../revision/spans";

type Db = BetterSQLite3Database<typeof schema>;

export type CommentRow = typeof schema.comments.$inferSelect;

// A comment with its offsets recomputed by string search against the draft content.
// quoted_text is the source of truth; span_start / span_end are best-effort caches
// used only for rendering, so they are refreshed on load.
export interface Comment extends CommentRow {
  resolvedSpanStart: number | null;
  resolvedSpanEnd: number | null;
}

export interface CreateCommentInput {
  draftId: number;
  quotedText: string;
  comment: string;
  spanStart?: number | null;
  spanEnd?: number | null;
}

export function createComment(db: Db, input: CreateCommentInput): CommentRow {
  return db
    .insert(schema.comments)
    .values({
      draftId: input.draftId,
      quotedText: input.quotedText,
      comment: input.comment,
      spanStart: input.spanStart ?? null,
      spanEnd: input.spanEnd ?? null,
      resolved: 0,
    })
    .returning()
    .get();
}

export function getComment(db: Db, id: number): CommentRow | undefined {
  return db
    .select()
    .from(schema.comments)
    .where(eq(schema.comments.id, id))
    .get();
}

// Lists a draft's comments with offsets recomputed against the given draft content.
export function listComments(
  db: Db,
  draftId: number,
  draftContent: string,
): Comment[] {
  const rows = db
    .select()
    .from(schema.comments)
    .where(eq(schema.comments.draftId, draftId))
    .orderBy(asc(schema.comments.id))
    .all();
  return rows.map((r) => withRecomputedSpan(r, draftContent));
}

export function listUnresolvedComments(db: Db, draftId: number): CommentRow[] {
  return db
    .select()
    .from(schema.comments)
    .where(
      and(
        eq(schema.comments.draftId, draftId),
        eq(schema.comments.resolved, 0),
      ),
    )
    .orderBy(asc(schema.comments.id))
    .all();
}

export interface UpdateCommentInput {
  comment?: string;
  resolved?: boolean;
}

export function updateComment(
  db: Db,
  id: number,
  input: UpdateCommentInput,
): CommentRow | undefined {
  const patch: Partial<typeof schema.comments.$inferInsert> = {};
  if (input.comment !== undefined) patch.comment = input.comment;
  if (input.resolved !== undefined) patch.resolved = input.resolved ? 1 : 0;
  if (Object.keys(patch).length === 0) return getComment(db, id);
  return db
    .update(schema.comments)
    .set(patch)
    .where(eq(schema.comments.id, id))
    .returning()
    .get();
}

// Recomputes a comment's offsets by string search, trusting the cached offset only
// when the text still matches there verbatim.
export function withRecomputedSpan(
  row: CommentRow,
  draftContent: string,
): Comment {
  const found = findSpan(draftContent, row.quotedText, row.spanStart);
  return {
    ...row,
    resolvedSpanStart: found ? found.start : null,
    resolvedSpanEnd: found ? found.end : null,
  };
}
