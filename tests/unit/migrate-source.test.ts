import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrateAndSeed } from "@/lib/db/migrate";
import * as schema from "@/lib/db/schema";
import { createCharacter, addState } from "@/lib/repo/characters";

// Phase 5: character_states gains a nullable `source` column via a guarded ALTER
// TABLE. Re-running migrateAndSeed on the same DB must be a no-op.
describe("character_states source column migration", () => {
  it("adds the source column and is idempotent across repeated runs", () => {
    const sqlite = new Database(":memory:");
    migrateAndSeed(sqlite);
    // Second run must not throw (column already present).
    expect(() => migrateAndSeed(sqlite)).not.toThrow();

    const cols = sqlite
      .prepare("SELECT name FROM pragma_table_info('character_states')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain("source");

    // Only one source column exists after two runs.
    const sourceCols = cols.filter((c) => c === "source");
    expect(sourceCols.length).toBe(1);
  });

  it("defaults source to 'manual' for UI-created states", () => {
    const sqlite = new Database(":memory:");
    migrateAndSeed(sqlite);
    const db = drizzle(sqlite, { schema });
    const c = createCharacter(db, { name: "Mara" });
    const state = addState(db, {
      characterId: c.id,
      projectId: 1,
      chapterOrder: 0,
      knows: "her own name",
    });
    expect(state.source).toBe("manual");
  });

  it("upgrades a pre-existing DB that lacks the source column", () => {
    // Simulate a Phase 1-4 database: create character_states WITHOUT source.
    const sqlite = new Database(":memory:");
    sqlite.exec(`
      CREATE TABLE character_states (
        id INTEGER PRIMARY KEY,
        character_id INTEGER NOT NULL,
        project_id INTEGER NOT NULL,
        chapter_order INTEGER NOT NULL,
        knows TEXT,
        feels TEXT,
        hiding TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );
    `);
    // Migrating must add the missing column without dropping the table.
    expect(() => migrateAndSeed(sqlite)).not.toThrow();
    const cols = sqlite
      .prepare("SELECT name FROM pragma_table_info('character_states')")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(cols).toContain("source");
  });
});
