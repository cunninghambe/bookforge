import { describe, it, expect } from "vitest";
import {
  buildBraidLayout,
  type BraidChapterInput,
  type BraidThreadInput,
  type BraidTouchInput,
} from "@/lib/braidLayout";
import { STALE_GAP } from "@/lib/threadFlags";

// Amendment A12 (phase 2): buildBraidLayout is a pure function, so every rule in
// the SPEC's braid paragraphs gets its own direct test here, no DB and no React.

function chapters(n: number, lockedCount: number): BraidChapterInput[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    orderIndex: i,
    status: i < lockedCount ? "locked" : "planned",
    title: null,
  }));
}

function thread(
  id: number,
  overrides: Partial<BraidThreadInput> = {},
): BraidThreadInput {
  return { id, name: `Thread ${id}`, type: "arc", status: "open", ...overrides };
}

function touch(
  threadId: number,
  chapterOrder: number,
  overrides: Partial<BraidTouchInput> = {},
): BraidTouchInput {
  return { threadId, chapterOrder, kind: "advance", evidence: null, ...overrides };
}

describe("buildBraidLayout: rows", () => {
  it("orders rows by first-touch chapter order ascending", () => {
    const threads = [thread(1), thread(2), thread(3)];
    const touches = [touch(1, 4), touch(2, 0), touch(3, 2)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));
    expect(layout.rows.map((r) => r.threadId)).toEqual([2, 3, 1]);
    expect(layout.rows.map((r) => r.row)).toEqual([0, 1, 2]);
  });

  it("puts untouched threads last, ordered by creation (input order)", () => {
    const threads = [thread(1), thread(2), thread(3), thread(4)];
    // 2 and 4 are never touched; 1 and 3 are.
    const touches = [touch(3, 1), touch(1, 0)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));
    expect(layout.rows.map((r) => r.threadId)).toEqual([1, 3, 2, 4]);
  });

  it("breaks ties on equal first-touch order by creation (input) order", () => {
    const threads = [thread(1), thread(2)];
    const touches = [touch(2, 3), touch(1, 3)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));
    expect(layout.rows.map((r) => r.threadId)).toEqual([1, 2]);
  });

  it("denormalizes name, type, and status onto the row", () => {
    const threads = [thread(1, { name: "Theo and Mara", type: "relationship", status: "open" })];
    const layout = buildBraidLayout(threads, [touch(1, 0)], chapters(3, 3));
    expect(layout.rows[0]).toMatchObject({
      threadId: 1,
      name: "Theo and Mara",
      type: "relationship",
      status: "open",
    });
  });

  it("gives an untouched thread a row with no nodes and no segments", () => {
    const threads = [thread(1)];
    const layout = buildBraidLayout(threads, [], chapters(4, 4));
    expect(layout.rows).toHaveLength(1);
    expect(layout.nodes).toHaveLength(0);
    expect(layout.segments).toHaveLength(0);
  });
});

describe("buildBraidLayout: nodes", () => {
  it("positions a node at (column = chapterOrder, row) and passes kind and evidence through", () => {
    const threads = [thread(1)];
    const touches = [
      touch(1, 0, { kind: "advance", evidence: "she climbed" }),
      touch(1, 2, { kind: "complicate", evidence: "the rope frayed" }),
    ];
    const layout = buildBraidLayout(threads, touches, chapters(4, 4));
    expect(layout.nodes).toEqual([
      { threadId: 1, row: 0, chapterOrder: 0, kind: "advance", evidence: "she climbed" },
      { threadId: 1, row: 0, chapterOrder: 2, kind: "complicate", evidence: "the rope frayed" },
    ]);
  });

  it("passes every touch kind through unchanged (mention, payoff)", () => {
    const threads = [thread(1)];
    const touches = [
      touch(1, 0, { kind: "mention" }),
      touch(1, 1, { kind: "payoff", evidence: "the promise kept" }),
    ];
    const layout = buildBraidLayout(threads, touches, chapters(4, 4));
    expect(layout.nodes.map((n) => n.kind)).toEqual(["mention", "payoff"]);
    expect(layout.nodes[1].evidence).toBe("the promise kept");
  });

  it("sorts a thread's own touches by chapter order regardless of input order", () => {
    const threads = [thread(1)];
    const touches = [touch(1, 3), touch(1, 0), touch(1, 1)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));
    expect(layout.nodes.map((n) => n.chapterOrder)).toEqual([0, 1, 3]);
  });
});

describe("buildBraidLayout: stale segments", () => {
  it("does not flag a gap of exactly STALE_GAP", () => {
    const threads = [thread(1)];
    const touches = [touch(1, 0), touch(1, STALE_GAP)];
    const layout = buildBraidLayout(threads, touches, chapters(10, 10));
    const seg = layout.segments.find((s) => !s.runout);
    expect(seg).toBeDefined();
    expect(seg?.stale).toBe(false);
  });

  it("flags a gap of STALE_GAP + 1", () => {
    const threads = [thread(1)];
    const touches = [touch(1, 0), touch(1, STALE_GAP + 1)];
    const layout = buildBraidLayout(threads, touches, chapters(10, 10));
    const seg = layout.segments.find((s) => !s.runout);
    expect(seg).toBeDefined();
    expect(seg?.stale).toBe(true);
  });

  it("carries fromOrder/toOrder for a between-touch segment", () => {
    const threads = [thread(1)];
    const touches = [touch(1, 1), touch(1, 5)];
    // Frontier past the last touch would also add a run-out; keep it pinned to
    // the last touch so only the one between-touch segment exists.
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));
    const seg = layout.segments.find((s) => !s.runout);
    expect(seg).toMatchObject({ threadId: 1, row: 0, fromOrder: 1, toOrder: 5 });
  });
});

describe("buildBraidLayout: run-out", () => {
  it("adds a dashed run-out from an open thread's last touch to the frontier", () => {
    const threads = [thread(1, { status: "open" })];
    const touches = [touch(1, 0)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6)); // frontier = 5
    const runout = layout.segments.find((s) => s.runout);
    expect(runout).toMatchObject({ threadId: 1, fromOrder: 0, toOrder: 5, runout: true });
    // gap of 5 exceeds STALE_GAP (4): the run-out itself reads as stale.
    expect(runout?.stale).toBe(true);
  });

  it("computes stale on the run-out using the same threshold as any other segment", () => {
    const threads = [thread(1, { status: "open" })];
    const touches = [touch(1, 3)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6)); // frontier = 5, gap = 2
    const runout = layout.segments.find((s) => s.runout);
    expect(runout?.stale).toBe(false);
  });

  it("omits the run-out when the last touch IS at the frontier", () => {
    const threads = [thread(1, { status: "open" })];
    const touches = [touch(1, 5)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6)); // frontier = 5
    expect(layout.segments.some((s) => s.runout)).toBe(false);
  });

  it("omits the run-out when the book has no locked chapters", () => {
    const threads = [thread(1, { status: "open" })];
    const touches = [touch(1, 0)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 0));
    expect(layout.frontier).toBeNull();
    expect(layout.segments.some((s) => s.runout)).toBe(false);
  });

  it("omits the run-out for a resolved thread (terminal instead)", () => {
    const threads = [thread(1, { status: "resolved" })];
    const touches = [touch(1, 0)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));
    expect(layout.segments.some((s) => s.runout)).toBe(false);
  });

  it("omits the run-out for a retired thread", () => {
    const threads = [thread(1, { status: "retired" })];
    const touches = [touch(1, 0)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));
    expect(layout.segments.some((s) => s.runout)).toBe(false);
    expect(layout.nodes.every((n) => !n.terminal)).toBe(true);
  });

  it("adds no run-out for a thread with zero touches", () => {
    const threads = [thread(1, { status: "open" })];
    const layout = buildBraidLayout(threads, [], chapters(6, 6));
    expect(layout.segments).toHaveLength(0);
  });
});

describe("buildBraidLayout: terminal", () => {
  it("marks the last node of a resolved thread as terminal", () => {
    const threads = [thread(1, { status: "resolved" })];
    const touches = [touch(1, 0), touch(1, 2)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));
    expect(layout.nodes[0].terminal).toBeUndefined();
    expect(layout.nodes[1].terminal).toBe(true);
  });

  it("does not mark terminal on an open thread's last node", () => {
    const threads = [thread(1, { status: "open" })];
    const touches = [touch(1, 0)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));
    expect(layout.nodes[0].terminal).toBeUndefined();
  });
});

describe("buildBraidLayout: co-touch columns", () => {
  it("flags a chapter order touched by 2+ threads, with sorted row indexes", () => {
    const threads = [thread(1), thread(2), thread(3)];
    const touches = [touch(1, 0), touch(2, 0), touch(3, 1)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));
    expect(layout.coTouchColumns).toEqual([{ chapterOrder: 0, rows: [0, 1] }]);
  });

  it("does not flag a chapter order touched by only one thread", () => {
    const threads = [thread(1), thread(2)];
    const touches = [touch(1, 0), touch(2, 1)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));
    expect(layout.coTouchColumns).toHaveLength(0);
  });

  it("dedupes a single thread touching the same chapter twice", () => {
    const threads = [thread(1)];
    const touches = [
      touch(1, 0, { kind: "advance" }),
      touch(1, 0, { kind: "mention" }),
    ];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));
    expect(layout.coTouchColumns).toHaveLength(0);
  });

  it("orders columns by chapter order", () => {
    const threads = [thread(1), thread(2), thread(3), thread(4)];
    const touches = [touch(1, 3), touch(2, 3), touch(3, 0), touch(4, 0)];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));
    expect(layout.coTouchColumns.map((c) => c.chapterOrder)).toEqual([0, 3]);
  });
});

describe("buildBraidLayout: acceptance scenario (SPEC A12)", () => {
  it("matches the SPEC's six-locked-chapter walkthrough", () => {
    // Six locked chapters (orders 0..5). "Theo and Mara" touched at UI chapters
    // 1, 2, 3 (orders 0, 1, 2). "The stolen ledger" only at UI chapter 1 (order 0).
    const threads = [thread(1, { name: "Theo and Mara" }), thread(2, { name: "The stolen ledger" })];
    const touches = [
      touch(1, 0),
      touch(1, 1),
      touch(1, 2),
      touch(2, 0),
    ];
    const layout = buildBraidLayout(threads, touches, chapters(6, 6));

    // Two lines, both touched at chapter order 0: a co-touch column there.
    expect(layout.coTouchColumns).toEqual([{ chapterOrder: 0, rows: [0, 1] }]);

    // Theo and Mara's run-out (order 2 to frontier 5, gap 3) is not stale.
    const theoRunout = layout.segments.find((s) => s.threadId === 1 && s.runout);
    expect(theoRunout).toMatchObject({ fromOrder: 2, toOrder: 5, stale: false });

    // The stolen ledger's post-chapter-1 run-out (order 0 to frontier 5, gap 5)
    // IS stale: the drop is visible in the line itself.
    const ledgerRunout = layout.segments.find((s) => s.threadId === 2 && s.runout);
    expect(ledgerRunout).toMatchObject({ fromOrder: 0, toOrder: 5, stale: true });
  });
});
