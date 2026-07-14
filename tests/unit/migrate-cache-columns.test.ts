import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrateAndSeed } from "@/lib/db/migrate";
import * as schema from "@/lib/db/schema";
import { logLlmCall, recentLlmCalls } from "@/lib/repo/llm";

// A4.1: llm_calls gains nullable cache_read_tokens and cache_write_tokens via the
// guarded-ALTER pattern. Re-running migrateAndSeed must be a no-op, a pre-A4 DB
// must upgrade, and the columns round-trip through the repo.
describe("llm_calls cache-token columns migration", () => {
  it("adds both columns and is idempotent across repeated runs", () => {
    const sqlite = new Database(":memory:");
    migrateAndSeed(sqlite);
    expect(() => migrateAndSeed(sqlite)).not.toThrow();

    const cols = sqlite
      .prepare("SELECT name FROM pragma_table_info('llm_calls')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain("cache_read_tokens");
    expect(cols).toContain("cache_write_tokens");
    expect(cols.filter((c) => c === "cache_read_tokens")).toHaveLength(1);
    expect(cols.filter((c) => c === "cache_write_tokens")).toHaveLength(1);
  });

  it("upgrades a pre-A4 llm_calls table that lacks the cache columns", () => {
    const sqlite = new Database(":memory:");
    // Simulate a Phase 1-A3 database: llm_calls without the cache columns.
    sqlite.exec(`
      CREATE TABLE llm_calls (
        id INTEGER PRIMARY KEY,
        purpose TEXT NOT NULL,
        chapter_id INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    expect(() => migrateAndSeed(sqlite)).not.toThrow();
    const cols = sqlite
      .prepare("SELECT name FROM pragma_table_info('llm_calls')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain("cache_read_tokens");
    expect(cols).toContain("cache_write_tokens");
  });

  it("logs and reads back cache token counts", () => {
    const sqlite = new Database(":memory:");
    migrateAndSeed(sqlite);
    const db = drizzle(sqlite, { schema });
    logLlmCall(db, {
      purpose: "draft",
      chapterId: 7,
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 40,
      cacheWriteTokens: 60,
    });
    // A call with no cache usage stores nulls, not zeros.
    logLlmCall(db, {
      purpose: "sweep",
      chapterId: 7,
      inputTokens: 10,
      outputTokens: 20,
    });

    const calls = recentLlmCalls(db, { chapterId: 7 });
    expect(calls).toHaveLength(2);
    const draftCall = calls.find((c) => c.purpose === "draft");
    expect(draftCall?.cacheReadTokens).toBe(40);
    expect(draftCall?.cacheWriteTokens).toBe(60);
    const sweepCall = calls.find((c) => c.purpose === "sweep");
    expect(sweepCall?.cacheReadTokens).toBeNull();
    expect(sweepCall?.cacheWriteTokens).toBeNull();
  });
});
