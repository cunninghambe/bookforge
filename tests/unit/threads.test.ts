import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { testDb } from "./helpers";
import { migrate, rebuildSearchIndex } from "@/lib/db/migrate";
import { searchIndex } from "@/lib/search";
import { createChapter, updateChapter } from "@/lib/repo/chapters";
import {
  createThread,
  getThread,
  updateThread,
  listThreads,
  addTouch,
  listTouches,
} from "@/lib/repo/threads";
import {
  STALE_GAP,
  computeThreadFlags,
  highestLockedOrder,
  threadsWithFlagsForBook,
} from "@/lib/threadFlags";

// Amendment A12: story threads. Migration, repo round-trips, dropped-thread
// detection (each rule its own test), and the fifth search kind.

// Helper: create N chapters in a book and lock the first `lockedCount` of them, so
// the book has a known highest-locked order.
function bookWithLockedChapters(
  db: ReturnType<typeof testDb>["db"],
  projectId: number,
  total: number,
  lockedCount: number,
) {
  const ids: number[] = [];
  for (let i = 0; i < total; i += 1) {
    const c = createChapter(db, { projectId, title: `Ch ${i + 1}` });
    ids.push(c.id);
    if (i < lockedCount) updateChapter(db, c.id, { status: "locked" });
  }
  return ids;
}

describe("threads migration", () => {
  it("creates threads and thread_touches and re-runs idempotently", () => {
    const sqlite = new Database(":memory:");
    migrate(sqlite);
    expect(() => migrate(sqlite)).not.toThrow();
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("threads");
    expect(tables).toContain("thread_touches");
  });
});

describe("threads repo round-trips", () => {
  it("creates, reads, and updates a thread", () => {
    const { db } = testDb();
    const t = createThread(db, {
      projectId: 1,
      name: "Theo and Mara",
      type: "relationship",
      note: "intended payoff in the finale",
    });
    expect(t.status).toBe("open");
    expect(t.projectId).toBe(1);

    const got = getThread(db, t.id);
    expect(got?.name).toBe("Theo and Mara");

    const updated = updateThread(db, t.id, {
      name: "Theo and Mara, unspoken",
      status: "resolved",
    });
    expect(updated?.name).toBe("Theo and Mara, unspoken");
    expect(updated?.status).toBe("resolved");
    // note is untouched by a patch that omits it.
    expect(updated?.note).toBe("intended payoff in the finale");
  });

  it("listThreads with a projectId includes that book plus series-wide, and filters status", () => {
    const { db } = testDb();
    const book1 = createThread(db, { projectId: 1, name: "Book1 arc", type: "arc" });
    const series = createThread(db, {
      projectId: null,
      name: "Series mystery",
      type: "mystery",
    });
    createThread(db, { projectId: 2, name: "Book2 arc", type: "arc" });
    updateThread(db, series.id, { status: "resolved" });

    const forBook1 = listThreads(db, { projectId: 1 });
    const ids = forBook1.map((t) => t.id).sort();
    expect(ids).toContain(book1.id);
    expect(ids).toContain(series.id);
    // Book 2's thread is not in book 1's list.
    expect(forBook1.every((t) => t.projectId !== 2)).toBe(true);

    const openOnly = listThreads(db, { projectId: 1, status: "open" });
    expect(openOnly.some((t) => t.id === series.id)).toBe(false);
    expect(openOnly.some((t) => t.id === book1.id)).toBe(true);
  });

  it("listTouches returns touches chronological by chapter order", () => {
    const { db } = testDb();
    const ids = bookWithLockedChapters(db, 1, 3, 3);
    const t = createThread(db, { projectId: 1, name: "Arc", type: "arc" });
    // Insert out of chapter order; listTouches must reorder by chapter order.
    addTouch(db, { threadId: t.id, chapterId: ids[2], kind: "mention", evidence: "third" });
    addTouch(db, { threadId: t.id, chapterId: ids[0], kind: "advance", evidence: "first" });
    addTouch(db, { threadId: t.id, chapterId: ids[1], kind: "complicate", evidence: "second" });

    const touches = listTouches(db, t.id);
    expect(touches.map((x) => x.evidence)).toEqual(["first", "second", "third"]);
    expect(touches.map((x) => x.chapterOrder)).toEqual([0, 1, 2]);
    expect(touches[0].source).toBe("manual");
  });
});

describe("computeThreadFlags rules", () => {
  it("STALE: an open thread with more than one touch and a gap over STALE_GAP is stale, not orphan", () => {
    const flags = computeThreadFlags({
      status: "open",
      touchOrders: [0, 1], // latest 1
      maxLockedOrder: 1 + STALE_GAP + 1, // gap = STALE_GAP + 1 > STALE_GAP
    });
    expect(flags.stale).toBe(true);
    expect(flags.orphan).toBe(false);
  });

  it("ORPHAN: an open thread with a single touch and a gap over STALE_GAP is stale and orphan", () => {
    const flags = computeThreadFlags({
      status: "open",
      touchOrders: [0],
      maxLockedOrder: STALE_GAP + 1,
    });
    expect(flags.stale).toBe(true);
    expect(flags.orphan).toBe(true);
  });

  it("not stale when the gap is exactly STALE_GAP (must EXCEED it)", () => {
    const flags = computeThreadFlags({
      status: "open",
      touchOrders: [0],
      maxLockedOrder: STALE_GAP, // gap = STALE_GAP, not over
    });
    expect(flags.stale).toBe(false);
    expect(flags.orphan).toBe(false);
  });

  it("no locked chapters (maxLockedOrder null) flags nothing", () => {
    const flags = computeThreadFlags({
      status: "open",
      touchOrders: [0],
      maxLockedOrder: null,
    });
    expect(flags).toEqual({ stale: false, orphan: false });
  });

  it("a thread with no touches flags nothing", () => {
    const flags = computeThreadFlags({
      status: "open",
      touchOrders: [],
      maxLockedOrder: 100,
    });
    expect(flags).toEqual({ stale: false, orphan: false });
  });

  it("resolved threads never flag", () => {
    const flags = computeThreadFlags({
      status: "resolved",
      touchOrders: [0],
      maxLockedOrder: 100,
    });
    expect(flags).toEqual({ stale: false, orphan: false });
  });

  it("retired threads never flag", () => {
    const flags = computeThreadFlags({
      status: "retired",
      touchOrders: [0],
      maxLockedOrder: 100,
    });
    expect(flags).toEqual({ stale: false, orphan: false });
  });
});

describe("threadsWithFlagsForBook", () => {
  it("matches the acceptance scenario: a developed thread is unflagged, a dropped one is orphan", () => {
    const { db } = testDb();
    // Six locked chapters (orders 0..5).
    const ids = bookWithLockedChapters(db, 1, 6, 6);
    expect(highestLockedOrder(db, 1)).toBe(5);

    const theoMara = createThread(db, {
      projectId: 1,
      name: "Theo and Mara",
      type: "relationship",
    });
    for (const order of [0, 1, 2]) {
      addTouch(db, { threadId: theoMara.id, chapterId: ids[order], kind: "advance" });
    }
    const ledger = createThread(db, {
      projectId: 1,
      name: "The stolen ledger",
      type: "mystery",
    });
    addTouch(db, { threadId: ledger.id, chapterId: ids[0], kind: "mention" });

    const rows = threadsWithFlagsForBook(db, 1);
    const theo = rows.find((r) => r.thread.id === theoMara.id)!;
    const led = rows.find((r) => r.thread.id === ledger.id)!;
    expect(theo.flags).toEqual({ stale: false, orphan: false });
    expect(led.flags).toEqual({ stale: true, orphan: true });
  });

  it("evaluates a series-wide thread against only the given book's touches", () => {
    const { db } = testDb();
    const book1 = bookWithLockedChapters(db, 1, 6, 6); // orders 0..5, all locked
    const book2 = bookWithLockedChapters(db, 2, 6, 6);

    const series = createThread(db, {
      projectId: null,
      name: "Series wide arc",
      type: "arc",
    });
    // Old touch in book 1 (order 0), recent touch in book 2 (order 5). If the
    // evaluation wrongly pooled both books, book 1's latest would look like 5 and
    // the thread would not be stale. Filtered per book, book 1's latest is 0.
    addTouch(db, { threadId: series.id, chapterId: book1[0], kind: "advance" });
    addTouch(db, { threadId: series.id, chapterId: book2[5], kind: "advance" });

    const rows1 = threadsWithFlagsForBook(db, 1);
    const s1 = rows1.find((r) => r.thread.id === series.id)!;
    expect(s1.flags.stale).toBe(true); // gap 5 - 0 = 5 > STALE_GAP within book 1
    expect(s1.touches).toHaveLength(1); // only book 1's touch is in scope

    const rows2 = threadsWithFlagsForBook(db, 2);
    const s2 = rows2.find((r) => r.thread.id === series.id)!;
    expect(s2.flags.stale).toBe(false); // book 2's latest touch is the frontier
  });

  it("returns no flags for any thread when the book has no locked chapters", () => {
    const { db } = testDb();
    const ids = bookWithLockedChapters(db, 1, 6, 0); // none locked
    const t = createThread(db, { projectId: 1, name: "Arc", type: "arc" });
    addTouch(db, { threadId: t.id, chapterId: ids[0], kind: "advance" });
    const rows = threadsWithFlagsForBook(db, 1);
    expect(rows.every((r) => !r.flags.stale && !r.flags.orphan)).toBe(true);
  });
});

describe("search kind 'thread' (A12)", () => {
  it("indexes a thread by name, note, and touch evidence, and tracks changes", () => {
    const { db } = testDb();
    const ids = bookWithLockedChapters(db, 1, 2, 2);
    const t = createThread(db, {
      projectId: 1,
      name: "The obsidian pact",
      type: "promise",
      note: "sworn beneath the aqueduct",
    });

    // Name match.
    const byName = searchIndex(db, { query: "obsidian" });
    expect(byName).toHaveLength(1);
    expect(byName[0].kind).toBe("thread");
    expect(byName[0].id).toBe(t.id);
    expect(byName[0].threadType).toBe("promise");
    expect(byName[0].status).toBe("open");
    expect(byName[0].title).toBe("The obsidian pact");

    // Note match.
    expect(searchIndex(db, { query: "aqueduct" })[0]?.id).toBe(t.id);

    // A touch's evidence joins the thread's indexed body (trigger on
    // thread_touches refreshes the parent thread row).
    addTouch(db, {
      threadId: t.id,
      chapterId: ids[0],
      kind: "advance",
      evidence: "the vermilion seal cracked",
    });
    expect(searchIndex(db, { query: "vermilion" })[0]?.id).toBe(t.id);

    // A status change is reflected.
    updateThread(db, t.id, { status: "resolved" });
    expect(searchIndex(db, { query: "obsidian" })[0]?.status).toBe("resolved");
  });

  it("removes a deleted thread from the index and rebuild restores threads", () => {
    const { db, sqlite } = testDb();
    const t = createThread(db, {
      projectId: 1,
      name: "The petrified vow",
      type: "promise",
    });
    expect(searchIndex(db, { query: "petrified" })).toHaveLength(1);

    sqlite.prepare("DELETE FROM thread_touches WHERE thread_id = ?").run(t.id);
    sqlite.prepare("DELETE FROM threads WHERE id = ?").run(t.id);
    expect(searchIndex(db, { query: "petrified" })).toHaveLength(0);

    // Re-create and wipe the index; rebuild must re-index threads.
    const t2 = createThread(db, {
      projectId: 1,
      name: "The petrified vow",
      type: "promise",
    });
    sqlite.exec("DELETE FROM search_index");
    expect(searchIndex(db, { query: "petrified" })).toHaveLength(0);
    rebuildSearchIndex(sqlite);
    expect(searchIndex(db, { query: "petrified" })[0]?.id).toBe(t2.id);
  });

  it("a projectId scope keeps series-wide threads and drops other books' threads", () => {
    const { db } = testDb();
    createThread(db, { projectId: 1, name: "Bookone cormorant", type: "arc" });
    createThread(db, { projectId: 2, name: "Booktwo cormorant", type: "arc" });
    createThread(db, { projectId: null, name: "Serieswide cormorant", type: "arc" });

    const hits = searchIndex(db, { query: "cormorant", projectId: 1, kinds: ["thread"] });
    const names = hits.map((h) => h.title).sort();
    expect(names).toContain("Bookone cormorant");
    expect(names).toContain("Serieswide cormorant");
    expect(names).not.toContain("Booktwo cormorant");
  });
});
