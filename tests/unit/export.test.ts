import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import { buildExport } from "@/lib/export";
import { createChapter, updateChapter, reorderChapters } from "@/lib/repo/chapters";
import { createDraftVersion } from "@/lib/repo/drafts";
import { getProject } from "@/lib/repo/projects";

function lockedChapter(db: ReturnType<typeof testDb>["db"], title: string, content: string) {
  const c = createChapter(db, { projectId: 1, title });
  createDraftVersion(db, c.id, content);
  return updateChapter(db, c.id, { status: "locked" })!;
}

describe("buildExport (SPEC section 8)", () => {
  it("concatenates locked chapters in order with headings and excludes unlocked chapters", () => {
    const { db } = testDb();
    lockedChapter(db, "Opening", "Text A.");
    createChapter(db, { projectId: 1, title: "Not locked" }); // planned, no draft
    lockedChapter(db, "Second", "Text B.");

    const project = getProject(db, 1)!;
    const result = buildExport(db, project);

    expect(result.content).toContain("## Opening");
    expect(result.content).toContain("## Second");
    expect(result.content).toContain("Text A.");
    expect(result.content).toContain("Text B.");
    expect(result.content).not.toContain("Not locked");
    expect(result.content.indexOf("Opening")).toBeLessThan(
      result.content.indexOf("Second"),
    );
  });

  it("respects a reorder and always uses the latest draft version per chapter", () => {
    const { db } = testDb();
    const a = lockedChapter(db, "A", "First text");
    const b = lockedChapter(db, "B", "Second text");

    // Reorder so B now comes first.
    reorderChapters(db, 1, [b.id, a.id]);
    // A new draft version for A supersedes the old text.
    createDraftVersion(db, a.id, "Revised A text");

    const project = getProject(db, 1)!;
    const result = buildExport(db, project);

    expect(result.content).not.toContain("First text");
    expect(result.content).toContain("Revised A text");
    expect(result.content.indexOf("Second text")).toBeLessThan(
      result.content.indexOf("Revised A text"),
    );
  });

  it("excludes chapters in review, drafting, or interrogating status", () => {
    const { db } = testDb();
    lockedChapter(db, "Locked one", "Locked text.");
    const review = createChapter(db, { projectId: 1, title: "In review" });
    createDraftVersion(db, review.id, "Review text, should not export.");
    updateChapter(db, review.id, { status: "review" });

    const project = getProject(db, 1)!;
    const result = buildExport(db, project);
    expect(result.content).toContain("Locked text.");
    expect(result.content).not.toContain("Review text");
  });

  it("produces a sensible, non-empty document for a book with no locked chapters", () => {
    const { db } = testDb();
    const project = getProject(db, 1)!;
    const result = buildExport(db, project);
    expect(result.content).toContain(project.title);
    expect(result.content.trim().length).toBeGreaterThan(0);
  });

  it("derives the filename from the book title", () => {
    const { db } = testDb();
    const project = getProject(db, 1)!; // "Book 1"
    const result = buildExport(db, project);
    expect(result.filename).toBe("book-1.md");
  });
});
