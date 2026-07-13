import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import { createChapter } from "@/lib/repo/chapters";
import { createDraftVersion } from "@/lib/repo/drafts";
import {
  createComment,
  listComments,
  updateComment,
  withRecomputedSpan,
} from "@/lib/repo/comments";
import { findSpan } from "@/lib/revision/spans";

const CONTENT = "Mara crossed the bridge. Kesh waited. Mara did not look back.";

describe("comment offset recomputation", () => {
  it("recomputes offsets by string search against the draft content", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "C" });
    const draft = createDraftVersion(db, ch.id, CONTENT);
    createComment(db, {
      draftId: draft.id,
      quotedText: "the bridge",
      comment: "which bridge?",
    });
    const [c] = listComments(db, draft.id, CONTENT);
    const idx = CONTENT.indexOf("the bridge");
    expect(c.resolvedSpanStart).toBe(idx);
    expect(c.resolvedSpanEnd).toBe(idx + "the bridge".length);
  });

  it("returns null offsets when the quoted text is no longer present", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "C" });
    const draft = createDraftVersion(db, ch.id, CONTENT);
    const row = createComment(db, {
      draftId: draft.id,
      quotedText: "a phrase that was revised away",
      comment: "gone",
    });
    const c = withRecomputedSpan(row, CONTENT);
    expect(c.resolvedSpanStart).toBeNull();
    expect(c.resolvedSpanEnd).toBeNull();
  });

  it("uses the cached offset hint to disambiguate a repeated phrase", () => {
    // "Mara" appears twice; the hint points at the second occurrence.
    const second = CONTENT.indexOf("Mara", CONTENT.indexOf("Mara") + 1);
    const found = findSpan(CONTENT, "Mara", second);
    expect(found).toEqual({ start: second, end: second + 4 });
    // Without a valid hint, the first occurrence wins.
    const first = findSpan(CONTENT, "Mara");
    expect(first).toEqual({ start: 0, end: 4 });
    // A stale hint (text does not match there) falls back to first occurrence.
    const stale = findSpan(CONTENT, "Mara", 3);
    expect(stale).toEqual({ start: 0, end: 4 });
  });

  it("marks a comment resolved", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "C" });
    const draft = createDraftVersion(db, ch.id, CONTENT);
    const row = createComment(db, {
      draftId: draft.id,
      quotedText: "Kesh",
      comment: "rename",
    });
    const updated = updateComment(db, row.id, { resolved: true });
    expect(updated?.resolved).toBe(1);
  });
});
