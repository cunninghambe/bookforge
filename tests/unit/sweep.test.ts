import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import { runSweep, sweepableChapters } from "@/lib/sweep";
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
