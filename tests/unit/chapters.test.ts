import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import {
  answerQuestion,
  createChapter,
  createQuestions,
  listChapters,
  previousLockedChapter,
  priorLockedChapters,
  reorderChapters,
  unansweredQuestionCount,
  updateChapter,
} from "@/lib/repo/chapters";
import { createCanon } from "@/lib/repo/canon";

describe("chapters repo", () => {
  it("assigns sequential order_index per book", () => {
    const { db } = testDb();
    const a = createChapter(db, { projectId: 1, title: "A" });
    const b = createChapter(db, { projectId: 1, title: "B" });
    const c = createChapter(db, { projectId: 1, title: "C" });
    expect([a.orderIndex, b.orderIndex, c.orderIndex]).toEqual([0, 1, 2]);
  });

  it("stores and returns beats as an array", () => {
    const { db } = testDb();
    const ch = createChapter(db, {
      projectId: 1,
      title: "A",
      beats: ["beat one", "beat two"],
    });
    expect(ch.beats).toEqual(["beat one", "beat two"]);
    const reloaded = listChapters(db, 1)[0];
    expect(reloaded.beats).toEqual(["beat one", "beat two"]);
  });

  it("reorder persists order_index", () => {
    const { db } = testDb();
    const a = createChapter(db, { projectId: 1, title: "A" });
    const b = createChapter(db, { projectId: 1, title: "B" });
    const c = createChapter(db, { projectId: 1, title: "C" });
    reorderChapters(db, 1, [c.id, a.id, b.id]);
    const titles = listChapters(db, 1).map((x) => x.title);
    expect(titles).toEqual(["C", "A", "B"]);
  });

  it("finds previous and prior locked chapters in order", () => {
    const { db } = testDb();
    const a = createChapter(db, { projectId: 1, title: "A" });
    const b = createChapter(db, { projectId: 1, title: "B" });
    const c = createChapter(db, { projectId: 1, title: "C" });
    updateChapter(db, a.id, { status: "locked" });
    updateChapter(db, b.id, { status: "locked" });
    const cur = listChapters(db, 1).find((x) => x.id === c.id)!;
    expect(previousLockedChapter(db, cur)?.title).toBe("B");
    expect(priorLockedChapters(db, cur).map((x) => x.title)).toEqual(["A", "B"]);
  });

  it("answering a question links a plot_decision fact and clears the unanswered count", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "A" });
    const [q] = createQuestions(db, ch.id, ["Does she know?"]);
    expect(unansweredQuestionCount(db, ch.id)).toBe(1);

    const fact = createCanon(db, {
      type: "plot_decision",
      content: "Does she know? Yes, since chapter 1.",
      status: "provisional",
      projectId: 1,
      source: `interrogation:${ch.id}`,
    });
    const updated = answerQuestion(db, q.id, "Yes", fact.id);
    expect(updated?.resultingFactId).toBe(fact.id);
    expect(updated?.answer).toBe("Yes");
    expect(unansweredQuestionCount(db, ch.id)).toBe(0);
    expect(fact.type).toBe("plot_decision");
    expect(fact.status).toBe("provisional");
  });
});
