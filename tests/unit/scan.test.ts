import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import { runScan, scanTargets, touchedChapterIds } from "@/lib/scan";
import { accumulateScanProposals } from "@/lib/llm/extraction";
import { approveScan } from "@/lib/repo/extraction";
import { createChapter, updateChapter } from "@/lib/repo/chapters";
import { createDraftVersion } from "@/lib/repo/drafts";
import {
  addTouch,
  createThread,
  listThreads,
  listTouches,
} from "@/lib/repo/threads";
import { FixtureClient } from "@/lib/llm/client";
import type {
  LlmClient,
  CompleteOptions,
  CompleteResult,
} from "@/lib/llm/client";

// Amendment A17: the thread backfill scan. These cover the default-range rule
// (locked, touchless), within-run name linkage across sequential chapters,
// attach-to-existing preference, per-chapter error carry-through, atomic approval
// with no-trace rejection, source stamping, and per-chapter fixture routing.

function lockedChapterWithDraft(
  db: ReturnType<typeof testDb>["db"],
  title: string,
  content: string,
) {
  const c = createChapter(db, { projectId: 1, title });
  createDraftVersion(db, c.id, content);
  updateChapter(db, c.id, { status: "locked" });
  return c;
}

// A stub client whose complete() returns (or throws) a scripted value per call.
function scriptedClient(
  responses: Array<string | Error>,
): LlmClient {
  let i = 0;
  return {
    async complete(_opts: CompleteOptions): Promise<CompleteResult> {
      const r = responses[i] ?? "[]";
      i += 1;
      if (r instanceof Error) throw r;
      return { text: r, inputTokens: 10, outputTokens: 5 };
    },
    async *stream() {
      return { text: "", inputTokens: 0, outputTokens: 0 };
    },
  };
}

function threadsReply(
  threads: Array<{
    thread: string;
    isNew: boolean;
    type?: string;
    kind: string;
    evidence?: string;
  }>,
): string {
  return JSON.stringify({ threads });
}

describe("scanTargets: default range is locked, touchless chapters (A17)", () => {
  it("skips touched chapters by default and unlocked chapters always", () => {
    const { db } = testDb();
    const a = lockedChapterWithDraft(db, "A", "text a");
    const planned = createChapter(db, { projectId: 1, title: "Planned" });
    const b = lockedChapterWithDraft(db, "B", "text b");

    // Give chapter A a touch, so it is no longer touchless.
    const thread = createThread(db, { projectId: 1, name: "T", type: "arc" });
    addTouch(db, { threadId: thread.id, chapterId: a.id, kind: "advance" });

    const args = { projectId: 1, fromOrder: a.orderIndex, toOrder: b.orderIndex };
    const def = scanTargets(db, { ...args, includeTouched: false });
    // A (touched) and planned (unlocked) both excluded; only B remains.
    expect(def.map((c) => c.id)).toEqual([b.id]);

    const all = scanTargets(db, { ...args, includeTouched: true });
    // includeTouched brings A back, but the unlocked chapter stays out.
    expect(all.map((c) => c.id)).toEqual([a.id, b.id]);

    expect([...touchedChapterIds(db, 1)]).toEqual([a.id]);
  });
});

describe("accumulateScanProposals: within-run linkage and attach preference (A17)", () => {
  it("attaches a case-insensitive name to an existing thread and merges a repeated new name across chapters", () => {
    const existing = [{ id: 7, name: "Ledger mystery" }];
    const chapters = [
      {
        chapterId: 100,
        order: 1,
        proposals: [
          {
            thread: "ledger MYSTERY", // matches existing case-insensitively
            isNew: true, // the model's hint is ignored; the name match wins
            type: "arc" as const,
            kind: "advance" as const,
            evidence: "e1",
          },
          {
            thread: "Theo and Mara",
            isNew: true,
            type: "relationship" as const,
            kind: "advance" as const,
            evidence: "e2",
          },
        ],
      },
      {
        chapterId: 200,
        order: 2,
        proposals: [
          {
            thread: "  theo and mara ", // links to chapter 1's new thread
            isNew: false,
            type: "arc" as const,
            kind: "complicate" as const,
            evidence: "e3",
          },
        ],
      },
    ];
    const { attaches, news } = accumulateScanProposals(chapters, existing);

    expect(attaches).toHaveLength(1);
    expect(attaches[0].threadId).toBe(7);
    expect(attaches[0].name).toBe("Ledger mystery"); // the existing name, not the proposal casing
    expect(attaches[0].touches).toHaveLength(1);
    expect(attaches[0].touches[0].chapterId).toBe(100);

    // The two "Theo and Mara" proposals merge into ONE new group with two touches.
    expect(news).toHaveLength(1);
    expect(news[0].name).toBe("Theo and Mara");
    expect(news[0].type).toBe("relationship"); // first-seen type
    expect(news[0].touches.map((t) => t.order)).toEqual([1, 2]);
    expect(news[0].touches.map((t) => t.kind)).toEqual(["advance", "complicate"]);
  });
});

describe("runScan: sequential run, error carry-through, within-run linkage (A17)", () => {
  it("continues past a per-chapter failure and links a recurring thread across chapters", async () => {
    const { db } = testDb();
    const a = lockedChapterWithDraft(db, "A", "text a");
    const b = lockedChapterWithDraft(db, "B", "text b");
    const c = lockedChapterWithDraft(db, "C", "text c");

    const client = scriptedClient([
      threadsReply([
        { thread: "Shared", isNew: true, type: "arc", kind: "advance", evidence: "e1" },
      ]),
      new Error("boom: model unavailable"),
      threadsReply([
        { thread: "shared", isNew: false, kind: "complicate", evidence: "e3" },
      ]),
    ]);

    const report = await runScan(db, client, {
      projectId: 1,
      fromOrder: a.orderIndex,
      toOrder: c.orderIndex,
      includeTouched: false,
      model: "test-model",
    });

    // All three chapters present: the failure did not abort the run.
    expect(report.chapters).toHaveLength(3);
    expect(report.failedCount).toBe(1);
    const rb = report.chapters.find((r) => r.chapterId === b.id);
    expect(rb?.error).toBe("boom: model unavailable");
    const ra = report.chapters.find((r) => r.chapterId === a.id);
    const rc = report.chapters.find((r) => r.chapterId === c.id);
    expect(ra?.error).toBeNull();
    expect(rc?.error).toBeNull();

    // Chapter A and C both proposed "Shared"; they merge into one new group.
    expect(report.news).toHaveLength(1);
    expect(report.news[0].name).toBe("Shared");
    expect(report.news[0].touches).toHaveLength(2);
    expect(report.news[0].touches.map((t) => t.chapterId)).toEqual([a.id, c.id]);
  });

  it("surfaces a parse failure with its raw text while other chapters still propose", async () => {
    const { db } = testDb();
    const a = lockedChapterWithDraft(db, "A", "text a");
    const b = lockedChapterWithDraft(db, "B", "text b");

    const client = scriptedClient([
      "the model wrote prose, not JSON",
      threadsReply([
        { thread: "Later", isNew: true, type: "mystery", kind: "mention", evidence: "e" },
      ]),
    ]);
    const report = await runScan(db, client, {
      projectId: 1,
      fromOrder: a.orderIndex,
      toOrder: b.orderIndex,
      includeTouched: false,
      model: "test-model",
    });

    const ra = report.chapters.find((r) => r.chapterId === a.id);
    expect(ra?.parseError).not.toBeNull();
    expect(ra?.rawText).toBe("the model wrote prose, not JSON");
    expect(report.failedCount).toBe(1);
    // The second chapter's proposal still arrived.
    expect(report.news).toHaveLength(1);
    expect(report.news[0].name).toBe("Later");
  });

  it("routes per-chapter fixtures by position and prefers the existing attach target (fixture pattern)", async () => {
    const { db } = testDb();
    // Pre-create the thread the scan1.1 fixture names, so it attaches.
    const ledger = createThread(db, {
      projectId: 1,
      name: "Ledger mystery",
      type: "mystery",
    });
    const a = lockedChapterWithDraft(db, "A", "text a");
    const b = lockedChapterWithDraft(db, "B", "text b");

    const report = await runScan(db, new FixtureClient(), {
      projectId: 1,
      fromOrder: a.orderIndex,
      toOrder: b.orderIndex,
      includeTouched: false,
      fixtureKey: "scan1",
      model: "test-model",
    });

    // scan1.1 (chapter A) proposed an attach to "Ledger mystery" plus new
    // "Theo and Mara"; scan1.2 (chapter B) proposed "Theo and Mara" again.
    expect(report.attaches).toHaveLength(1);
    expect(report.attaches[0].threadId).toBe(ledger.id);
    expect(report.attaches[0].touches).toHaveLength(1);
    expect(report.news).toHaveLength(1);
    expect(report.news[0].name).toBe("Theo and Mara");
    expect(report.news[0].touches).toHaveLength(2);
  });
});

describe("approveScan: atomic persistence, source stamping, no-trace rejection (A17)", () => {
  it("creates new threads with their touches and attaches touches to existing ones, each sourced scan:<chapter_id>", () => {
    const { db } = testDb();
    const a = lockedChapterWithDraft(db, "A", "text a");
    const b = lockedChapterWithDraft(db, "B", "text b");
    const existing = createThread(db, {
      projectId: 1,
      name: "Existing",
      type: "arc",
    });
    const before = listThreads(db, { projectId: 1 }).length;

    const result = approveScan(db, {
      projectId: 1,
      attaches: [
        { threadId: existing.id, touches: [{ chapterId: a.id, kind: "advance", evidence: "e" }] },
      ],
      newThreads: [
        {
          name: "Fresh",
          type: "mystery",
          touches: [
            { chapterId: a.id, kind: "advance" },
            { chapterId: b.id, kind: "complicate" },
          ],
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const attachTouches = listTouches(db, existing.id);
    expect(attachTouches).toHaveLength(1);
    expect(attachTouches[0].source).toBe(`scan:${a.id}`);

    expect(listThreads(db, { projectId: 1 }).length).toBe(before + 1);
    const fresh = result.createdThreads[0];
    expect(fresh.name).toBe("Fresh");
    expect(fresh.status).toBe("open");
    const freshTouches = listTouches(db, fresh.id);
    expect(freshTouches).toHaveLength(2);
    expect(freshTouches.map((t) => t.source).sort()).toEqual(
      [`scan:${a.id}`, `scan:${b.id}`].sort(),
    );
  });

  it("rejects the whole call when a touch names a non-locked chapter, leaving no trace", () => {
    const { db } = testDb();
    const a = lockedChapterWithDraft(db, "A", "text a");
    const planned = createChapter(db, { projectId: 1, title: "Planned" });
    const before = listThreads(db, { projectId: 1 }).length;

    const result = approveScan(db, {
      projectId: 1,
      newThreads: [
        {
          name: "Would be created",
          type: "arc",
          touches: [
            { chapterId: a.id, kind: "advance" },
            { chapterId: planned.id, kind: "mention" },
          ],
        },
      ],
      attaches: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unmatched.some((u) => u === `chapter ${planned.id}`)).toBe(true);
    // Nothing landed: the new thread was not created.
    expect(listThreads(db, { projectId: 1 }).length).toBe(before);
  });

  it("rejects the whole call when an attach targets a missing thread, leaving no trace", () => {
    const { db } = testDb();
    const a = lockedChapterWithDraft(db, "A", "text a");
    const before = listThreads(db, { projectId: 1 });

    const result = approveScan(db, {
      projectId: 1,
      attaches: [{ threadId: 999999, touches: [{ chapterId: a.id, kind: "advance" }] }],
      newThreads: [
        { name: "Also new", type: "arc", touches: [{ chapterId: a.id, kind: "advance" }] },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unmatched.some((u) => u === "thread 999999")).toBe(true);
    // The would-be new thread "Also new" was not created either.
    const after = listThreads(db, { projectId: 1 });
    expect(after.length).toBe(before.length);
    expect(after.map((t) => t.name)).not.toContain("Also new");
  });
});
