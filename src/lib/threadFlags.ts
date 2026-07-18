import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema";
import { listChapters } from "./repo/chapters";
import {
  listThreads,
  listTouches,
  type Thread,
  type ThreadFilter,
  type TouchWithChapter,
} from "./repo/threads";

type Db = BetterSQLite3Database<typeof schema>;

// Amendment A12: dropped-thread detection, purely mechanical (no LLM). A thread is
// STALE when it has drifted too far from the writing frontier; an ORPHAN is the
// sharper case of a thread introduced and never developed. Everything is measured
// against the book's highest LOCKED chapter order, so unlocked drafts never flag.

// The gap (in chapter orders) past which an open thread is considered dropped.
export const STALE_GAP = 4;

export interface ThreadFlags {
  stale: boolean;
  // Orphan implies stale: an orphan is a stale thread with at most one touch. The
  // UI shows the sharper "introduced and never developed" wording for orphans.
  orphan: boolean;
}

const NO_FLAGS: ThreadFlags = { stale: false, orphan: false };

// The book's highest LOCKED chapter order, or null when the book has no locked
// chapters (in which case nothing flags: there is no frontier to measure against).
export function highestLockedOrder(db: Db, projectId: number): number | null {
  const orders = listChapters(db, projectId)
    .filter((c) => c.status === "locked")
    .map((c) => c.orderIndex);
  return orders.length ? Math.max(...orders) : null;
}

// Pure flag rule. touchOrders are the 0-based chapter orders of THIS thread's
// touches that fall inside the book being evaluated (for a series-wide thread the
// caller filters to the book's touches first). maxLockedOrder is that book's
// frontier. Resolved and retired threads never flag; a book with no locked
// chapters (maxLockedOrder null) flags nothing.
export function computeThreadFlags(args: {
  status: string;
  touchOrders: number[];
  maxLockedOrder: number | null;
}): ThreadFlags {
  if (args.maxLockedOrder === null) return NO_FLAGS;
  if (args.status !== "open") return NO_FLAGS;
  if (args.touchOrders.length === 0) return NO_FLAGS;
  const latest = Math.max(...args.touchOrders);
  const gapHolds = args.maxLockedOrder - latest > STALE_GAP;
  if (!gapHolds) return NO_FLAGS;
  return { stale: true, orphan: args.touchOrders.length <= 1 };
}

// A thread with its flags computed for a specific book. touches are this thread's
// touches within that book, chronological by chapter order.
export interface ThreadWithFlags {
  thread: Thread;
  touches: TouchWithChapter[];
  flags: ThreadFlags;
}

// Every thread in scope for a book (the book's own plus series-wide), each with its
// flags computed against that book. Series-wide threads are evaluated over only the
// touches that land in this book. Used by the API list route, the braid, and the
// MCP threads_list tool.
export function threadsWithFlagsForBook(
  db: Db,
  projectId: number,
  filter: Omit<ThreadFilter, "projectId"> = {},
): ThreadWithFlags[] {
  const maxLockedOrder = highestLockedOrder(db, projectId);
  const threads = listThreads(db, { projectId, status: filter.status });
  return threads.map((thread) => {
    const touches = listTouches(db, thread.id).filter(
      (t) => t.chapterProjectId === projectId,
    );
    const flags = computeThreadFlags({
      status: thread.status,
      touchOrders: touches.map((t) => t.chapterOrder),
      maxLockedOrder,
    });
    return { thread, touches, flags };
  });
}

// Flags for a single thread evaluated against a given book. Convenience for the
// detail route and MCP thread_get.
export function flagsForThread(
  db: Db,
  thread: Thread,
  projectId: number,
): ThreadFlags {
  const touches = listTouches(db, thread.id).filter(
    (t) => t.chapterProjectId === projectId,
  );
  return computeThreadFlags({
    status: thread.status,
    touchOrders: touches.map((t) => t.chapterOrder),
    maxLockedOrder: highestLockedOrder(db, projectId),
  });
}
