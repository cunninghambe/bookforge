import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrateAndSeed } from "@/lib/db/migrate";
import * as schema from "@/lib/db/schema";
import { logLlmCall, recentLlmCalls } from "@/lib/repo/llm";
import { setSetting, getSetting } from "@/lib/repo/settings";

// A8 migration: the settings table and the llm_calls.model column are created
// idempotently. Re-running migrateAndSeed must be a no-op, a pre-A8 DB must upgrade,
// and logLlmCall must persist the model.

describe("A8 migration: settings table + llm_calls.model column", () => {
  it("creates the settings table and model column, idempotent across runs", () => {
    const sqlite = new Database(":memory:");
    migrateAndSeed(sqlite);
    expect(() => migrateAndSeed(sqlite)).not.toThrow();

    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("settings");

    const cols = sqlite
      .prepare("SELECT name FROM pragma_table_info('llm_calls')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain("model");
    expect(cols.filter((c) => c === "model")).toHaveLength(1);

    // The settings repo round-trips through the migrated table.
    const db = drizzle(sqlite, { schema });
    setSetting(db, "model.draft", "claude-fable-5");
    expect(getSetting(db, "model.draft")).toBe("claude-fable-5");
  });

  it("upgrades a pre-A8 database that lacks the settings table and model column", () => {
    const sqlite = new Database(":memory:");
    // Simulate a pre-A8 llm_calls table (post-A4, so it has the cache columns but
    // not model) and no settings table at all.
    sqlite.exec(`
      CREATE TABLE llm_calls (
        id INTEGER PRIMARY KEY,
        purpose TEXT NOT NULL,
        chapter_id INTEGER,
        input_tokens INTEGER,
        output_tokens INTEGER,
        cache_read_tokens INTEGER,
        cache_write_tokens INTEGER,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    expect(() => migrateAndSeed(sqlite)).not.toThrow();

    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("settings");
    const cols = sqlite
      .prepare("SELECT name FROM pragma_table_info('llm_calls')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain("model");
  });

  it("logLlmCall persists the model, and null when omitted", () => {
    const sqlite = new Database(":memory:");
    migrateAndSeed(sqlite);
    const db = drizzle(sqlite, { schema });

    logLlmCall(db, {
      purpose: "draft",
      chapterId: 3,
      inputTokens: 100,
      outputTokens: 40,
      model: "claude-test-model-a8",
    });
    logLlmCall(db, {
      purpose: "summary",
      chapterId: 3,
      inputTokens: 10,
      outputTokens: 5,
    });

    const calls = recentLlmCalls(db, { chapterId: 3 });
    expect(calls).toHaveLength(2);
    const draftCall = calls.find((c) => c.purpose === "draft");
    expect(draftCall?.model).toBe("claude-test-model-a8");
    const summaryCall = calls.find((c) => c.purpose === "summary");
    expect(summaryCall?.model).toBeNull();
  });
});
