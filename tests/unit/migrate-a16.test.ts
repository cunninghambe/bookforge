import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate, migrateAndSeed } from "@/lib/db/migrate";
import * as schema from "@/lib/db/schema";
import { testDb } from "./helpers";
import { assemblePrompt } from "@/lib/assembler";
import { createCanon } from "@/lib/repo/canon";
import { createCharacter } from "@/lib/repo/characters";
import { createChapter, updateChapter } from "@/lib/repo/chapters";
import { createDraftVersion } from "@/lib/repo/drafts";
import { createThread } from "@/lib/repo/threads";

// Amendment A16: the series table, the series_id backfill, and the load-bearing
// acceptance check that a trilogy's assembled prompt is byte-identical after the
// migration.

// Nulls every series_id and removes the series table's rows, reproducing a
// genuine pre-A16 database (the columns exist but are unpopulated, and no series
// row exists yet). Re-running migrate() must then file everything under one series.
function stripSeries(sqlite: Database.Database): void {
  sqlite.exec(`
    DELETE FROM series;
    UPDATE projects SET series_id = NULL;
    UPDATE canon_facts SET series_id = NULL;
    UPDATE characters SET series_id = NULL;
    UPDATE threads SET series_id = NULL;
  `);
}

describe("A16 migration and backfill", () => {
  it("creates the series table", () => {
    const sqlite = new Database(":memory:");
    migrate(sqlite);
    const tables = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toContain("series");
  });

  it("seeds the trilogy under one series and gives every seed row a series_id", () => {
    const sqlite = new Database(":memory:");
    migrateAndSeed(sqlite);

    const series = sqlite.prepare("SELECT * FROM series").all() as Array<{
      id: number;
      title: string;
    }>;
    expect(series).toHaveLength(1);
    expect(series[0].title).toBe("The Trilogy");

    const projects = sqlite
      .prepare("SELECT series_id FROM projects")
      .all() as Array<{ series_id: number | null }>;
    expect(projects).toHaveLength(3);
    expect(projects.every((p) => p.series_id === series[0].id)).toBe(true);

    const seedRules = sqlite
      .prepare("SELECT project_id, series_id FROM canon_facts WHERE source='seed'")
      .all() as Array<{ project_id: number | null; series_id: number | null }>;
    expect(seedRules).toHaveLength(5);
    // Series-wide (project_id NULL) but with the series named.
    expect(seedRules.every((r) => r.project_id === null)).toBe(true);
    expect(seedRules.every((r) => r.series_id === series[0].id)).toBe(true);
  });

  it("backfills every pre-A16 row into one series and is idempotent", () => {
    const { sqlite, db } = testDb();
    // Populate content across the four series-bearing tables.
    createCharacter(db, { name: "Mara" });
    createCanon(db, {
      type: "world_rule",
      content: "Iron burns elementals.",
      status: "locked",
      projectId: null,
    });
    const ch = createChapter(db, { projectId: 1, title: "Ch" });
    createThread(db, { projectId: 1, name: "Arc", type: "arc" });
    void ch;

    stripSeries(sqlite);
    migrate(sqlite);

    const series = sqlite.prepare("SELECT id FROM series").all() as Array<{
      id: number;
    }>;
    expect(series).toHaveLength(1);
    const sid = series[0].id;

    for (const table of ["projects", "canon_facts", "characters", "threads"]) {
      const orphans = sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE series_id IS NULL`)
        .get() as { n: number };
      expect(orphans.n, `${table} has an unassigned series_id`).toBe(0);
      const wrong = sqlite
        .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE series_id <> ?`)
        .get(sid) as { n: number };
      expect(wrong.n, `${table} row landed in another series`).toBe(0);
    }

    // Re-running twice more must not create a second series.
    migrate(sqlite);
    migrate(sqlite);
    const after = sqlite.prepare("SELECT COUNT(*) AS n FROM series").get() as {
      n: number;
    };
    expect(after.n).toBe(1);
  });
});

// The acceptance keystone: a chapter's assembled prompt is byte-identical across
// the A16 migration. Build a trilogy fixture, assemble, reproduce the pre-A16
// state, migrate again (which backfills), and assemble again.
describe("A16 byte-identical prompt acceptance", () => {
  function trilogyFixture() {
    const { sqlite, db } = testDb();
    // A POV character (series 1 by default).
    createCharacter(db, {
      name: "Mara",
      role: "fire elemental, POV",
      voiceRules: "no britishisms",
    });
    // Series-wide and book canon, all locked so they enter assembly.
    createCanon(db, {
      type: "world_rule",
      content: "Iron burns elementals on contact.",
      status: "locked",
      projectId: null,
    });
    createCanon(db, {
      type: "plot_decision",
      content: "Mara hides that she is an elemental until Book 1 chapter 10.",
      status: "locked",
      projectId: 1,
    });
    // A prior locked chapter with a draft (drives STORY SO FAR / PREVIOUS CHAPTER).
    const prior = createChapter(db, {
      projectId: 1,
      title: "The Fire",
      pov: "Mara",
      synopsis: "The fire starts.",
      beats: ["fire"],
    });
    updateChapter(db, prior.id, {
      status: "locked",
      summary: "Mara survives a fire.",
    });
    createDraftVersion(db, prior.id, "The first chapter prose about the fire.");
    // Current chapter, mentions Mara so she appears.
    const current = createChapter(db, {
      projectId: 1,
      title: "The Hall",
      pov: "Mara",
      synopsis: "Mara enters the hall.",
      beats: ["Mara hides her flame"],
    });
    return { sqlite, db, current };
  }

  it("is byte-identical before and after re-migration (idempotence)", () => {
    const { sqlite, db, current } = trilogyFixture();
    const before = assemblePrompt(db, {
      chapterId: current.id,
      targetBeatIndices: [0],
    });
    // Sanity: the fixture content is actually in the prompt (not a vacuous match).
    expect(before.prompt).toContain("Iron burns elementals on contact.");
    expect(before.system).toContain("Never use em-dashes");

    migrate(sqlite); // idempotent re-run
    const afterIdempotent = assemblePrompt(db, {
      chapterId: current.id,
      targetBeatIndices: [0],
    });
    expect(afterIdempotent.prompt).toBe(before.prompt);
    expect(afterIdempotent.system).toBe(before.system);
  });

  it("is byte-identical after a genuine pre-A16 upgrade (backfill)", () => {
    const { sqlite, db, current } = trilogyFixture();
    const before = assemblePrompt(db, {
      chapterId: current.id,
      targetBeatIndices: [0],
    });

    // Reproduce a pre-A16 database, then upgrade it by running migrate again.
    stripSeries(sqlite);
    migrate(sqlite);

    const after = assemblePrompt(db, {
      chapterId: current.id,
      targetBeatIndices: [0],
    });
    // The trilogy must not notice A16 happened.
    expect(after.prompt).toBe(before.prompt);
    expect(after.system).toBe(before.system);
  });
});

// Keeps the drizzle schema in sync with the raw DDL: a smoke check that the new
// tables/columns are queryable through the typed client.
describe("A16 schema is queryable", () => {
  it("selects series and project.series_id through drizzle", () => {
    const sqlite = new Database(":memory:");
    migrateAndSeed(sqlite);
    const db = drizzle(sqlite, { schema });
    const rows = db.select().from(schema.series).all();
    expect(rows[0].title).toBe("The Trilogy");
    const projects = db.select().from(schema.projects).all();
    expect(projects.every((p) => typeof p.seriesId === "number")).toBe(true);
  });
});
