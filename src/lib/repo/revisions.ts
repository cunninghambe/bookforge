import { and, desc, eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import type { FlaggedSpan } from "../revision/diff";

type Db = BetterSQLite3Database<typeof schema>;

export type RevisionRow = typeof schema.revisions.$inferSelect;

// A pending revision with its JSON columns decoded.
export interface Revision extends Omit<RevisionRow, "flaggedSpans" | "consistencyFixes"> {
  flaggedSpans: FlaggedSpan[];
  consistencyFixes: string[];
}

function decode(row: RevisionRow): Revision {
  return {
    ...row,
    flaggedSpans: parseJson<FlaggedSpan[]>(row.flaggedSpans, []),
    consistencyFixes: parseJson<string[]>(row.consistencyFixes, []),
  };
}

function parseJson<T>(s: string, fallback: T): T {
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export interface CreateRevisionInput {
  draftId: number;
  chapterId: number;
  oldText: string;
  newText: string;
  flaggedSpans: FlaggedSpan[];
  consistencyFixes: string[];
}

export function createRevision(db: Db, input: CreateRevisionInput): Revision {
  const row = db
    .insert(schema.revisions)
    .values({
      draftId: input.draftId,
      chapterId: input.chapterId,
      oldText: input.oldText,
      newText: input.newText,
      flaggedSpans: JSON.stringify(input.flaggedSpans),
      consistencyFixes: JSON.stringify(input.consistencyFixes),
      status: "pending",
    })
    .returning()
    .get();
  return decode(row);
}

// The newest PENDING revision for a draft, or undefined. A pending revision is
// durable state (the reason the revisions table stores old/new text and spans),
// so the review page can restore hunk resolution after an interrupted call, a
// tab discard, or a reload; only the newest matters because a fresh revise()
// supersedes older pending ones.
export function newestPendingRevisionForDraft(
  db: Db,
  draftId: number,
): Revision | undefined {
  const row = db
    .select()
    .from(schema.revisions)
    .where(
      and(
        eq(schema.revisions.draftId, draftId),
        eq(schema.revisions.status, "pending"),
      ),
    )
    .orderBy(desc(schema.revisions.id))
    .get();
  return row ? decode(row) : undefined;
}

export function getRevision(db: Db, id: number): Revision | undefined {
  const row = db
    .select()
    .from(schema.revisions)
    .where(eq(schema.revisions.id, id))
    .get();
  return row ? decode(row) : undefined;
}

export function markRevisionResolved(db: Db, id: number): void {
  db.update(schema.revisions)
    .set({ status: "resolved" })
    .where(eq(schema.revisions.id, id))
    .run();
}
