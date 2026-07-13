import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import { createChapterAtOrder, getChapter, listChapters } from "@/lib/repo/chapters";
import { createDraftVersion } from "@/lib/repo/drafts";
import { listDrafts } from "@/lib/repo/drafts";

describe("createChapterAtOrder (SPEC section 7, backfill importer)", () => {
  it("creates a chapter locked at the confirmed order with a single draft version", () => {
    const { db } = testDb();
    const chapter = createChapterAtOrder(db, {
      projectId: 1,
      title: "Imported one",
      orderIndex: 0,
    });
    expect(chapter.status).toBe("locked");
    expect(chapter.orderIndex).toBe(0);
    expect(chapter.title).toBe("Imported one");

    const draft = createDraftVersion(db, chapter.id, "The chapter text.");
    expect(draft.version).toBe(1);
    expect(listDrafts(db, chapter.id)).toHaveLength(1);
  });

  it("importing between existing chapters respects the confirmed order and shifts the rest", () => {
    const { db } = testDb();
    const a = createChapterAtOrder(db, { projectId: 1, title: "A", orderIndex: 0 });
    const b = createChapterAtOrder(db, { projectId: 1, title: "B", orderIndex: 1 });

    // Insert a new chapter between A and B.
    const mid = createChapterAtOrder(db, { projectId: 1, title: "Mid", orderIndex: 1 });
    expect(mid.orderIndex).toBe(1);

    const aAfter = getChapter(db, a.id);
    const bAfter = getChapter(db, b.id);
    expect(aAfter?.orderIndex).toBe(0);
    expect(bAfter?.orderIndex).toBe(2);

    const ordered = listChapters(db, 1).map((c) => c.title);
    expect(ordered).toEqual(["A", "Mid", "B"]);
  });

  it("appending at the current end does not disturb existing chapters", () => {
    const { db } = testDb();
    const a = createChapterAtOrder(db, { projectId: 1, title: "A", orderIndex: 0 });
    const b = createChapterAtOrder(db, { projectId: 1, title: "B", orderIndex: 1 });
    const c = createChapterAtOrder(db, { projectId: 1, title: "C", orderIndex: 2 });

    expect(getChapter(db, a.id)?.orderIndex).toBe(0);
    expect(getChapter(db, b.id)?.orderIndex).toBe(1);
    expect(c.orderIndex).toBe(2);
    expect(listChapters(db, 1).map((x) => x.title)).toEqual(["A", "B", "C"]);
  });

  it("only shifts chapters within the same book", () => {
    const { db } = testDb();
    const otherBook = createChapterAtOrder(db, {
      projectId: 2,
      title: "Other book chapter",
      orderIndex: 0,
    });
    createChapterAtOrder(db, { projectId: 1, title: "This book chapter", orderIndex: 0 });

    expect(getChapter(db, otherBook.id)?.orderIndex).toBe(0);
  });
});
