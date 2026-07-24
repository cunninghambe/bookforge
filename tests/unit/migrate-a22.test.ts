import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrateAndSeed } from "@/lib/db/migrate";
import * as schema from "@/lib/db/schema";
import { createChapter } from "@/lib/repo/chapters";
import { createDraftVersion } from "@/lib/repo/drafts";
import { createComment, getComment } from "@/lib/repo/comments";

// A22: comments gains a nullable suggested_text column via the guarded-ALTER
// pattern (D175). Re-running migrateAndSeed must be a no-op, a pre-A22 comments
// table must upgrade, and the column must round-trip through the repo.
describe("comments suggested_text column migration", () => {
  it("adds the column once and is idempotent across repeated runs", () => {
    const sqlite = new Database(":memory:");
    migrateAndSeed(sqlite);
    expect(() => migrateAndSeed(sqlite)).not.toThrow();

    const cols = sqlite
      .prepare("SELECT name FROM pragma_table_info('comments')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain("suggested_text");
    expect(cols.filter((c) => c === "suggested_text")).toHaveLength(1);
  });

  it("upgrades a pre-A22 comments table that lacks suggested_text", () => {
    const sqlite = new Database(":memory:");
    // Simulate a pre-A22 database: comments without the suggested_text column.
    sqlite.exec(`
      CREATE TABLE comments (
        id INTEGER PRIMARY KEY,
        draft_id INTEGER NOT NULL,
        quoted_text TEXT NOT NULL,
        span_start INTEGER,
        span_end INTEGER,
        comment TEXT NOT NULL,
        resolved INTEGER DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    expect(() => migrateAndSeed(sqlite)).not.toThrow();
    const cols = sqlite
      .prepare("SELECT name FROM pragma_table_info('comments')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain("suggested_text");
  });

  it("round-trips suggested_text through the repo (null for a plain comment)", () => {
    const sqlite = new Database(":memory:");
    migrateAndSeed(sqlite);
    const db = drizzle(sqlite, { schema });
    const ch = createChapter(db, { projectId: 1, title: "C" });
    const draft = createDraftVersion(db, ch.id, "Mara crossed the bridge.");

    const plain = createComment(db, {
      draftId: draft.id,
      quotedText: "the bridge",
      comment: "which bridge?",
    });
    const suggestion = createComment(db, {
      draftId: draft.id,
      quotedText: "Mara",
      comment: "",
      suggestedText: "Kesh",
    });

    expect(getComment(db, plain.id)!.suggestedText).toBeNull();
    expect(getComment(db, suggestion.id)!.suggestedText).toBe("Kesh");
  });
});
