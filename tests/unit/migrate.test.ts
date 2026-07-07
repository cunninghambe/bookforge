import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { migrate, migrateAndSeed, seed } from "@/lib/db/migrate";

const EM_DASH = "—";

describe("migrations", () => {
  it("creates all tables and re-runs idempotently", () => {
    const sqlite = new Database(":memory:");
    // Running migrate twice must not throw (IF NOT EXISTS).
    migrate(sqlite);
    expect(() => migrate(sqlite)).not.toThrow();

    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);

    for (const t of [
      "projects",
      "canon_facts",
      "characters",
      "character_states",
      "chapters",
      "drafts",
      "comments",
      "questions",
      "llm_calls",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("seeds three books and five style rules, and re-seeding does not duplicate", () => {
    const sqlite = new Database(":memory:");
    migrateAndSeed(sqlite);
    // Second full run must be a no-op for counts.
    seed(sqlite);
    migrateAndSeed(sqlite);

    const projects = sqlite
      .prepare("SELECT COUNT(*) AS n FROM projects")
      .get() as { n: number };
    expect(projects.n).toBe(3);

    const styleRules = sqlite
      .prepare(
        "SELECT COUNT(*) AS n FROM canon_facts WHERE type='style_rule' AND source='seed'",
      )
      .get() as { n: number };
    expect(styleRules.n).toBe(5);
  });

  it("seeds style rules as locked, series-wide, em-dash free", () => {
    const sqlite = new Database(":memory:");
    migrateAndSeed(sqlite);
    const rows = sqlite
      .prepare("SELECT * FROM canon_facts WHERE source='seed'")
      .all() as Array<{
      type: string;
      status: string;
      project_id: number | null;
      content: string;
    }>;
    expect(rows.length).toBe(5);
    for (const r of rows) {
      expect(r.type).toBe("style_rule");
      expect(r.status).toBe("locked");
      expect(r.project_id).toBeNull();
      expect(r.content.includes(EM_DASH)).toBe(false);
    }
    // The first seeded rule is the em-dash prohibition itself.
    expect(rows.some((r) => /never use em-dashes/i.test(r.content))).toBe(true);
  });
});
