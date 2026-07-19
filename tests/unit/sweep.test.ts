import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import {
  runSweep,
  sweepableChapters,
  sweepChapter,
  sweepCanonPrefix,
} from "@/lib/sweep";
import { sweepPrefix } from "@/lib/llm/prompts";
import { assemblableCanon } from "@/lib/repo/canon";
import { createChapter, updateChapter } from "@/lib/repo/chapters";
import { createDraftVersion } from "@/lib/repo/drafts";
import type {
  LlmClient,
  CompleteOptions,
  CompleteResult,
} from "@/lib/llm/client";

// A stub client whose complete() returns a scripted response per call, so the
// aggregation can be tested without the network. stream() is never used here.
function scriptedClient(responses: string[]): LlmClient {
  let i = 0;
  return {
    async complete(_opts: CompleteOptions): Promise<CompleteResult> {
      const text = responses[i] ?? "[]";
      i += 1;
      return { text, inputTokens: 10, outputTokens: 5 };
    },
    async *stream() {
      return { text: "", inputTokens: 0, outputTokens: 0 };
    },
  };
}

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

describe("runSweep aggregation", () => {
  it("aggregates contradictions across a range and surfaces a parse failure", async () => {
    const { db } = testDb();
    const a = lockedChapterWithDraft(db, "A", "Two moons rose over the ridge.");
    const b = lockedChapterWithDraft(db, "B", "The town slept quietly.");
    const c = lockedChapterWithDraft(db, "C", "Nothing of note occurred.");

    const client = scriptedClient([
      JSON.stringify([
        {
          chapter: 1,
          quote: "Two moons rose",
          conflicting_fact: "There is one moon.",
          severity: "high",
        },
      ]),
      "[]",
      "the model wrote prose instead of JSON",
    ]);

    const report = await runSweep(db, client, {
      projectId: 1,
      fromOrder: a.orderIndex,
      toOrder: c.orderIndex,
      model: "test-model",
    });

    expect(report.chapters).toHaveLength(3);
    expect(report.totalContradictions).toBe(1);

    const ra = report.chapters.find((r) => r.chapterId === a.id);
    expect(ra?.contradictions).toHaveLength(1);
    expect(ra?.contradictions[0].severity).toBe("high");

    const rb = report.chapters.find((r) => r.chapterId === b.id);
    expect(rb?.contradictions).toHaveLength(0);
    expect(rb?.parseError).toBeNull();

    const rc = report.chapters.find((r) => r.chapterId === c.id);
    expect(rc?.parseError).not.toBeNull();
    expect(rc?.rawText).toBe("the model wrote prose instead of JSON");
  });

  it("a chapter whose LLM call throws yields an error entry and does not abort the remaining chapters (A2.2)", async () => {
    const { db } = testDb();
    const a = lockedChapterWithDraft(db, "A", "text a");
    const b = lockedChapterWithDraft(db, "B", "text b");
    const c = lockedChapterWithDraft(db, "C", "text c");

    // Throws on the second call (chapter B), succeeds on the others.
    let i = 0;
    const client: LlmClient = {
      async complete(): Promise<CompleteResult> {
        i += 1;
        if (i === 2) throw new Error("boom: model unavailable");
        return { text: "[]", inputTokens: 1, outputTokens: 1 };
      },
      async *stream() {
        return { text: "", inputTokens: 0, outputTokens: 0 };
      },
    };

    const report = await runSweep(db, client, {
      projectId: 1,
      fromOrder: a.orderIndex,
      toOrder: c.orderIndex,
      model: "test-model",
    });

    // All three chapters are present: the failure did not abort the run.
    expect(report.chapters).toHaveLength(3);
    expect(report.totalContradictions).toBe(0);

    const rb = report.chapters.find((r) => r.chapterId === b.id);
    expect(rb?.error).toBe("boom: model unavailable");
    expect(rb?.contradictions).toHaveLength(0);
    expect(rb?.rawText).toBeNull();
    expect(rb?.parseError).toBeNull();

    // Chapter C, after the failed chapter, was still processed.
    const rc = report.chapters.find((r) => r.chapterId === c.id);
    expect(rc?.error).toBeNull();
    expect(rc?.parseError).toBeNull();

    // A successful chapter carries no error.
    const ra = report.chapters.find((r) => r.chapterId === a.id);
    expect(ra?.error).toBeNull();
  });

  it("only sweeps locked chapters within the order range", () => {
    const { db } = testDb();
    const a = lockedChapterWithDraft(db, "A", "text");
    const planned = createChapter(db, { projectId: 1, title: "Planned" });
    const b = lockedChapterWithDraft(db, "B", "text");

    const swept = sweepableChapters(db, {
      projectId: 1,
      fromOrder: a.orderIndex,
      toOrder: b.orderIndex,
    });
    const ids = swept.map((c) => c.id);
    expect(ids).toContain(a.id);
    expect(ids).toContain(b.id);
    // The planned (unlocked) chapter in the range is excluded.
    expect(ids).not.toContain(planned.id);
  });
});

// A18: the extracted single-chapter step the per-chapter endpoint calls (exactly as
// the scan/chapter route calls scanChapter). runSweep delegates to it, so the
// aggregation tests above already exercise it; these pin the per-request contract.
describe("sweepChapter: the extracted single-chapter step (A18)", () => {
  it("returns one chapter's parsed contradictions", async () => {
    const { db } = testDb();
    const a = lockedChapterWithDraft(db, "A", "Two moons rose over the ridge.");
    const client = scriptedClient([
      JSON.stringify([
        {
          chapter: 1,
          quote: "Two moons rose",
          conflicting_fact: "There is one moon.",
          severity: "high",
        },
      ]),
    ]);

    const report = await sweepChapter(db, client, {
      chapterId: a.id,
      projectId: 1,
      prefix: sweepCanonPrefix(db, 1),
      model: "test-model",
    });

    expect(report.chapterId).toBe(a.id);
    expect(report.order).toBe(1);
    expect(report.error).toBeNull();
    expect(report.parseError).toBeNull();
    expect(report.contradictions).toHaveLength(1);
    expect(report.contradictions[0].severity).toBe("high");
  });

  it("surfaces a parse failure as raw text without throwing", async () => {
    const { db } = testDb();
    const a = lockedChapterWithDraft(db, "A", "text a");
    const client = scriptedClient(["the model wrote prose instead of JSON"]);

    const report = await sweepChapter(db, client, {
      chapterId: a.id,
      projectId: 1,
      prefix: sweepCanonPrefix(db, 1),
      model: "test-model",
    });

    expect(report.parseError).not.toBeNull();
    expect(report.rawText).toBe("the model wrote prose instead of JSON");
    expect(report.contradictions).toHaveLength(0);
    expect(report.error).toBeNull();
  });

  it("turns a thrown LLM call into an error entry, never a throw (A2.2)", async () => {
    const { db } = testDb();
    const a = lockedChapterWithDraft(db, "A", "text a");
    const client: LlmClient = {
      async complete(): Promise<CompleteResult> {
        throw new Error("boom: model unavailable");
      },
      async *stream() {
        return { text: "", inputTokens: 0, outputTokens: 0 };
      },
    };

    const report = await sweepChapter(db, client, {
      chapterId: a.id,
      projectId: 1,
      prefix: sweepCanonPrefix(db, 1),
      model: "test-model",
    });

    expect(report.error).toBe("boom: model unavailable");
    expect(report.contradictions).toHaveLength(0);
    expect(report.rawText).toBeNull();
    expect(report.parseError).toBeNull();
  });

  it("throws (a request-level error) for a chapter that is not a locked chapter of the book", async () => {
    const { db } = testDb();
    const planned = createChapter(db, { projectId: 1, title: "Planned" });
    const client = scriptedClient(["[]"]);

    await expect(
      sweepChapter(db, client, {
        chapterId: planned.id,
        projectId: 1,
        prefix: sweepCanonPrefix(db, 1),
        model: "test-model",
      }),
    ).rejects.toThrow(/not a locked chapter/);
  });
});

// A18: the plan endpoint returns exactly sweepableChapters (covered above), and the
// A4.1 shared prefix it and runSweep both send must be byte-identical, so the
// provider cache hits across a client-driven run. This pins the prefix builder to
// sweepPrefix over the book's assemblable canon.
describe("sweepCanonPrefix: the A4.1 shared prefix, rebuilt per request (A18)", () => {
  it("is byte-identical to sweepPrefix over the book's assemblable canon", () => {
    const { db } = testDb();
    lockedChapterWithDraft(db, "A", "text a");
    const expected = sweepPrefix(
      assemblableCanon(db, { projectId: 1 }).map((f) => f.content),
    );
    expect(sweepCanonPrefix(db, 1)).toBe(expected);
    expect(sweepCanonPrefix(db, 1)).toContain("LOCKED CANON");
  });
});
