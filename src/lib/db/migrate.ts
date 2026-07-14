import type Database from "better-sqlite3";

// Idempotent schema creation. Every statement uses IF NOT EXISTS so running this
// repeatedly on an existing database is a no-op. DDL mirrors SPEC.md exactly.
export function migrate(sqlite: Database.Database): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS canon_facts (
      id INTEGER PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id),
      type TEXT NOT NULL CHECK (type IN (
        'world_rule','style_rule','timeline_event','character_fact','plot_decision'
      )),
      content TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'provisional' CHECK (status IN ('locked','provisional','retired')),
      source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS characters (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT,
      voice_rules TEXT,
      physical TEXT,
      notes TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS character_states (
      id INTEGER PRIMARY KEY,
      character_id INTEGER NOT NULL REFERENCES characters(id),
      project_id INTEGER NOT NULL REFERENCES projects(id),
      chapter_order INTEGER NOT NULL,
      knows TEXT,
      feels TEXT,
      hiding TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id INTEGER PRIMARY KEY,
      project_id INTEGER NOT NULL REFERENCES projects(id),
      order_index INTEGER NOT NULL,
      title TEXT,
      pov TEXT,
      synopsis TEXT,
      beats TEXT,
      dependencies TEXT,
      summary TEXT,
      status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN
        ('planned','interrogating','drafting','review','locked')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS drafts (
      id INTEGER PRIMARY KEY,
      chapter_id INTEGER NOT NULL REFERENCES chapters(id),
      version INTEGER NOT NULL,
      content TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS comments (
      id INTEGER PRIMARY KEY,
      draft_id INTEGER NOT NULL REFERENCES drafts(id),
      quoted_text TEXT NOT NULL,
      span_start INTEGER,
      span_end INTEGER,
      comment TEXT NOT NULL,
      resolved INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY,
      chapter_id INTEGER NOT NULL REFERENCES chapters(id),
      question TEXT NOT NULL,
      answer TEXT,
      resulting_fact_id INTEGER REFERENCES canon_facts(id),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY,
      draft_id INTEGER NOT NULL REFERENCES drafts(id),
      chapter_id INTEGER NOT NULL REFERENCES chapters(id),
      old_text TEXT NOT NULL,
      new_text TEXT NOT NULL,
      flagged_spans TEXT NOT NULL,
      consistency_fixes TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','resolved')),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS llm_calls (
      id INTEGER PRIMARY KEY,
      purpose TEXT NOT NULL,
      chapter_id INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  addColumnIfMissing(sqlite, {
    table: "character_states",
    column: "source",
    // Nullable with a 'manual' default: UI-created states are manual; approved
    // lock-time proposals carry 'extraction:<chapter_id>' (Amendment A1).
    definition: "TEXT DEFAULT 'manual'",
  });

  // Amendment A4.1: prompt-cache usage columns on llm_calls. Nullable; populated
  // only when the provider reports cache read/write token counts.
  addColumnIfMissing(sqlite, {
    table: "llm_calls",
    column: "cache_read_tokens",
    definition: "INTEGER",
  });
  addColumnIfMissing(sqlite, {
    table: "llm_calls",
    column: "cache_write_tokens",
    definition: "INTEGER",
  });

  // Amendment A8: llm_calls records which model served each call, so per-purpose
  // routing is visible in the cost log. Nullable; the same guarded-ALTER pattern.
  addColumnIfMissing(sqlite, {
    table: "llm_calls",
    column: "model",
    definition: "TEXT",
  });
}

// Idempotent ALTER TABLE ADD COLUMN. SQLite has no ADD COLUMN IF NOT EXISTS, so
// we check pragma_table_info first. Re-running is a no-op.
function addColumnIfMissing(
  sqlite: Database.Database,
  args: { table: string; column: string; definition: string },
): void {
  const cols = sqlite
    .prepare(`SELECT name FROM pragma_table_info(?)`)
    .all(args.table) as Array<{ name: string }>;
  if (cols.some((c) => c.name === args.column)) return;
  sqlite.exec(
    `ALTER TABLE ${args.table} ADD COLUMN ${args.column} ${args.definition}`,
  );
}

// The five seed style rules from SPEC.md. Never use em-dashes in any of them.
const SEED_STYLE_RULES: string[] = [
  "Never use em-dashes anywhere in prose, dialogue, or interiority. Use commas, colons, full stops, or restructure the sentence.",
  "Register target: literary fantasy. Deep character interiority in the mode of N.K. Jemisin, with dry, understated humor in the mode of Joe Abercrombie. No purple prose, no epic-fantasy formality.",
  "Britishisms are restricted to one designated character only (configure per character via voice_rules). No other character uses them.",
  "Dialogue carries subtext. Characters routinely do not say the thing directly. Avoid on-the-nose emotional declarations.",
  "Scene endings land on an image or an action, not a summary of feelings.",
];

const SEED_PROJECTS: string[] = ["Book 1", "Book 2", "Book 3"];

// Idempotent seed. Only inserts when the target rows are absent, so re-running is
// safe. Books are created once; seed style rules are created once (matched by
// exact content + source 'seed').
export function seed(sqlite: Database.Database): void {
  const projectCount = sqlite
    .prepare("SELECT COUNT(*) AS n FROM projects")
    .get() as { n: number };

  if (projectCount.n === 0) {
    const insertProject = sqlite.prepare(
      "INSERT INTO projects (title, order_index) VALUES (?, ?)",
    );
    SEED_PROJECTS.forEach((title, i) => insertProject.run(title, i));
  }

  const findSeed = sqlite.prepare(
    "SELECT id FROM canon_facts WHERE content = ? AND source = 'seed'",
  );
  const insertFact = sqlite.prepare(
    `INSERT INTO canon_facts (project_id, type, content, status, source)
     VALUES (NULL, 'style_rule', ?, 'locked', 'seed')`,
  );
  for (const content of SEED_STYLE_RULES) {
    const existing = findSeed.get(content);
    if (!existing) insertFact.run(content);
  }
}

export function migrateAndSeed(sqlite: Database.Database): void {
  migrate(sqlite);
  seed(sqlite);
}

export { SEED_STYLE_RULES, SEED_PROJECTS };
