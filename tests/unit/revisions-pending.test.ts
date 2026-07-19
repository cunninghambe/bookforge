import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import { createChapter } from "@/lib/repo/chapters";
import { createDraftVersion } from "@/lib/repo/drafts";
import {
  createRevision,
  markRevisionResolved,
  newestPendingRevisionForDraft,
} from "@/lib/repo/revisions";

// The pending-revision restore path (field fix): a pending revision is durable
// state and must be findable per draft after the in-flight response is lost.

describe("newestPendingRevisionForDraft", () => {
  it("returns the newest pending revision and ignores resolved ones", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "Ch" });
    const draft = createDraftVersion(db, ch.id, "The old text.");

    expect(newestPendingRevisionForDraft(db, draft.id)).toBeUndefined();

    const first = createRevision(db, {
      draftId: draft.id,
      chapterId: ch.id,
      oldText: "The old text.",
      newText: "The first new text.",
      flaggedSpans: [],
      consistencyFixes: [],
    });
    const second = createRevision(db, {
      draftId: draft.id,
      chapterId: ch.id,
      oldText: "The old text.",
      newText: "The second new text.",
      flaggedSpans: [],
      consistencyFixes: ["a declared fix"],
    });

    const found = newestPendingRevisionForDraft(db, draft.id);
    expect(found?.id).toBe(second.id);
    expect(found?.consistencyFixes).toEqual(["a declared fix"]);

    markRevisionResolved(db, second.id);
    expect(newestPendingRevisionForDraft(db, draft.id)?.id).toBe(first.id);
    markRevisionResolved(db, first.id);
    expect(newestPendingRevisionForDraft(db, draft.id)).toBeUndefined();
  });

  it("scopes to the given draft", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "Ch" });
    const a = createDraftVersion(db, ch.id, "Draft A.");
    const b = createDraftVersion(db, ch.id, "Draft B.");
    createRevision(db, {
      draftId: a.id,
      chapterId: ch.id,
      oldText: "Draft A.",
      newText: "Draft A revised.",
      flaggedSpans: [],
      consistencyFixes: [],
    });
    expect(newestPendingRevisionForDraft(db, b.id)).toBeUndefined();
    expect(newestPendingRevisionForDraft(db, a.id)?.newText).toBe(
      "Draft A revised.",
    );
  });
});
