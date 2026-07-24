import type Database from "better-sqlite3";

// Idempotent schema creation. Every statement uses IF NOT EXISTS so running this
// repeatedly on an existing database is a no-op. DDL mirrors SPEC.md exactly.
export function migrate(sqlite: Database.Database): void {
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");

  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS series (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      order_index INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );

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

    CREATE TABLE IF NOT EXISTS threads (
      id INTEGER PRIMARY KEY,
      project_id INTEGER REFERENCES projects(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('arc','mystery','promise','relationship')),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','retired')),
      character_a_id INTEGER REFERENCES characters(id),
      character_b_id INTEGER REFERENCES characters(id),
      note TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS thread_touches (
      id INTEGER PRIMARY KEY,
      thread_id INTEGER NOT NULL REFERENCES threads(id),
      chapter_id INTEGER NOT NULL REFERENCES chapters(id),
      kind TEXT NOT NULL CHECK (kind IN ('advance','complicate','payoff','mention')),
      evidence TEXT,
      source TEXT,
      created_at TEXT DEFAULT (datetime('now'))
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

  // Amendment A22: comments gains a nullable suggested_text column (the D175
  // discriminator). NULL is a plain comment; a non-null value is the author's
  // verbatim replacement text, applied mechanically. Guarded ALTER, same pattern.
  addColumnIfMissing(sqlite, {
    table: "comments",
    column: "suggested_text",
    definition: "TEXT",
  });

  // Amendment A16: series_id on the four tables that were implicitly series-wide.
  // Added without a REFERENCES clause so the ALTER never has to validate existing
  // rows; NOT NULL semantics are enforced in code and by the backfill below.
  for (const table of ["projects", "canon_facts", "characters", "threads"]) {
    addColumnIfMissing(sqlite, { table, column: "series_id", definition: "INTEGER" });
  }
  // Assign every pre-A16 row to a single editable "The Trilogy" series so an
  // existing chapter's assembled prompt is byte-identical after migration.
  backfillSeries(sqlite);

  // Amendment A11: the full-text search index. The virtual table and its
  // triggers are (re)created every migrate (DROP TRIGGER IF EXISTS keeps the
  // trigger bodies current across upgrades), then the whole index is rebuilt:
  // O(project size), trivially cheap for a single user, and it both indexes
  // pre-A11 databases on first run and self-heals any drift. See D103.
  // A16: the index gains an unindexed series_id column. A pre-A16 search_index
  // (created without that column) is dropped so it is recreated with the current
  // schema; the whole index is rebuilt from source below every migrate anyway, so
  // dropping loses nothing. sqlite_master's stored SQL is the reliable probe for a
  // virtual table's declared columns.
  const existing = sqlite
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='search_index'",
    )
    .get() as { sql: string } | undefined;
  if (existing && !/series_id/.test(existing.sql)) {
    sqlite.exec("DROP TABLE search_index;");
  }
  sqlite.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      kind UNINDEXED,
      ref_id UNINDEXED,
      project_id UNINDEXED,
      series_id UNINDEXED,
      meta UNINDEXED,
      title,
      body,
      tokenize = 'unicode61 remove_diacritics 2'
    );
  `);
  sqlite.exec(searchTriggerSql());
  rebuildSearchIndex(sqlite);
}

// ---- Amendment A16: series backfill -----------------------------------------

// Get-or-create the default series. Returns the id of the lowest-ordered series,
// creating "The Trilogy" (order_index 0) when the table is empty. Shared by the
// migration backfill and the fresh-database seed so both land on one series 1.
function ensureDefaultSeries(sqlite: Database.Database): number {
  const existing = sqlite
    .prepare("SELECT id FROM series ORDER BY order_index, id LIMIT 1")
    .get() as { id: number } | undefined;
  if (existing) return existing.id;
  const info = sqlite
    .prepare("INSERT INTO series (title, order_index) VALUES (?, 0)")
    .run(DEFAULT_SERIES_TITLE);
  return Number(info.lastInsertRowid);
}

// Assigns every project, canon fact, character, and thread with a NULL series_id
// to a single default series. Idempotent: after the first run there are no NULL
// rows, so re-running (and running on a fresh, empty database, where seed() makes
// the series instead) is a no-op that never creates a spurious series.
function backfillSeries(sqlite: Database.Database): void {
  const orphans = sqlite
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM projects WHERE series_id IS NULL) +
         (SELECT COUNT(*) FROM canon_facts WHERE series_id IS NULL) +
         (SELECT COUNT(*) FROM characters WHERE series_id IS NULL) +
         (SELECT COUNT(*) FROM threads WHERE series_id IS NULL) AS n`,
    )
    .get() as { n: number };
  if (orphans.n === 0) return;
  const seriesId = ensureDefaultSeries(sqlite);
  for (const table of ["projects", "canon_facts", "characters", "threads"]) {
    sqlite
      .prepare(`UPDATE ${table} SET series_id = ? WHERE series_id IS NULL`)
      .run(seriesId);
  }
}

// ---- Amendment A11: search index maintenance -------------------------------

// INSERT ... SELECT statements shared by the triggers and the full rebuild.
// meta carries RAW database values (0-based order fields); the 1-based
// conversion happens only in src/lib/search.ts via chapterNumbering (A2, D105).

// A chapter's searchable body: pov, synopsis, summary, beats (the JSON text;
// the tokenizer discards the punctuation), and the LATEST draft's prose.
function searchInsertChapters(where: string): string {
  return `
    INSERT INTO search_index (kind, ref_id, project_id, series_id, meta, title, body)
    SELECT 'chapter', c.id, c.project_id,
           (SELECT series_id FROM projects WHERE id = c.project_id),
           json_object('orderIndex', c.order_index, 'status', c.status, 'pov', c.pov),
           COALESCE(c.title, ''),
           COALESCE(c.pov, '') || ' ' || COALESCE(c.synopsis, '') || ' ' ||
           COALESCE(c.summary, '') || ' ' || COALESCE(c.beats, '') || ' ' ||
           COALESCE((SELECT d.content FROM drafts d
                     WHERE d.chapter_id = c.id
                     ORDER BY d.version DESC LIMIT 1), '')
    FROM chapters c ${where};`;
}

function searchInsertCanon(where: string): string {
  return `
    INSERT INTO search_index (kind, ref_id, project_id, series_id, meta, title, body)
    SELECT 'canon', f.id, f.project_id, f.series_id,
           json_object('type', f.type, 'status', f.status),
           '',
           f.content
    FROM canon_facts f ${where};`;
}

function searchInsertCharacters(where: string): string {
  return `
    INSERT INTO search_index (kind, ref_id, project_id, series_id, meta, title, body)
    SELECT 'character', ch.id, NULL, ch.series_id,
           json_object('role', ch.role),
           ch.name,
           COALESCE(ch.role, '') || ' ' || COALESCE(ch.voice_rules, '') || ' ' ||
           COALESCE(ch.physical, '') || ' ' || COALESCE(ch.notes, '')
    FROM characters ch ${where};`;
}

// State rows carry the owning character's name as their searchable title.
function searchInsertStates(where: string): string {
  return `
    INSERT INTO search_index (kind, ref_id, project_id, series_id, meta, title, body)
    SELECT 'state', s.id, s.project_id,
           (SELECT series_id FROM projects WHERE id = s.project_id),
           json_object('characterId', s.character_id, 'chapterOrder', s.chapter_order),
           COALESCE((SELECT name FROM characters WHERE id = s.character_id), ''),
           COALESCE(s.knows, '') || ' ' || COALESCE(s.feels, '') || ' ' ||
           COALESCE(s.hiding, '')
    FROM character_states s ${where};`;
}

// Amendment A12: a thread's searchable body is its type, status, note, and every
// touch's evidence concatenated (so a hit lands whether the term is in the note or
// in a chapter's quoted evidence). meta carries type, status, and the RAW
// project_id (NULL for series-wide); the query layer resolves the deep link.
function searchInsertThreads(where: string): string {
  return `
    INSERT INTO search_index (kind, ref_id, project_id, series_id, meta, title, body)
    SELECT 'thread', t.id, t.project_id, t.series_id,
           json_object('type', t.type, 'status', t.status, 'projectId', t.project_id),
           t.name,
           t.type || ' ' || t.status || ' ' || COALESCE(t.note, '') || ' ' ||
           COALESCE((SELECT group_concat(tt.evidence, ' ')
                     FROM thread_touches tt WHERE tt.thread_id = t.id), '')
    FROM threads t ${where};`;
}

function refreshChapter(idExpr: string): string {
  return `
    DELETE FROM search_index WHERE kind = 'chapter' AND ref_id = ${idExpr};
    ${searchInsertChapters(`WHERE c.id = ${idExpr}`)}`;
}

// A thread row (kind 'thread') refreshed by id: used by triggers on both threads
// and thread_touches (a touch change alters the parent thread's indexed body).
function refreshThread(idExpr: string): string {
  return `
    DELETE FROM search_index WHERE kind = 'thread' AND ref_id = ${idExpr};
    ${searchInsertThreads(`WHERE t.id = ${idExpr}`)}`;
}

// Triggers keep the index live at the database level, so no code path can
// write around it (D103). Recreated every migrate so definitions never go
// stale. Draft changes refresh the owning chapter's row (the body embeds the
// latest draft); a character update also refreshes that character's state
// rows, whose titles carry the name.
function searchTriggerSql(): string {
  const t = (name: string, event: string, body: string) => `
    DROP TRIGGER IF EXISTS ${name};
    CREATE TRIGGER ${name} ${event} BEGIN${body}
    END;`;

  return [
    t("search_chapters_ai", "AFTER INSERT ON chapters", refreshChapter("NEW.id")),
    t("search_chapters_au", "AFTER UPDATE ON chapters", refreshChapter("NEW.id")),
    t(
      "search_chapters_ad",
      "AFTER DELETE ON chapters",
      `
      DELETE FROM search_index WHERE kind = 'chapter' AND ref_id = OLD.id;`,
    ),
    t("search_drafts_ai", "AFTER INSERT ON drafts", refreshChapter("NEW.chapter_id")),
    t("search_drafts_au", "AFTER UPDATE ON drafts", refreshChapter("NEW.chapter_id")),
    t("search_drafts_ad", "AFTER DELETE ON drafts", refreshChapter("OLD.chapter_id")),
    t(
      "search_canon_ai",
      "AFTER INSERT ON canon_facts",
      `
      DELETE FROM search_index WHERE kind = 'canon' AND ref_id = NEW.id;
      ${searchInsertCanon("WHERE f.id = NEW.id")}`,
    ),
    t(
      "search_canon_au",
      "AFTER UPDATE ON canon_facts",
      `
      DELETE FROM search_index WHERE kind = 'canon' AND ref_id = NEW.id;
      ${searchInsertCanon("WHERE f.id = NEW.id")}`,
    ),
    t(
      "search_canon_ad",
      "AFTER DELETE ON canon_facts",
      `
      DELETE FROM search_index WHERE kind = 'canon' AND ref_id = OLD.id;`,
    ),
    t(
      "search_characters_ai",
      "AFTER INSERT ON characters",
      `
      DELETE FROM search_index WHERE kind = 'character' AND ref_id = NEW.id;
      ${searchInsertCharacters("WHERE ch.id = NEW.id")}`,
    ),
    t(
      "search_characters_au",
      "AFTER UPDATE ON characters",
      `
      DELETE FROM search_index WHERE kind = 'character' AND ref_id = NEW.id;
      ${searchInsertCharacters("WHERE ch.id = NEW.id")}
      DELETE FROM search_index WHERE kind = 'state' AND ref_id IN
        (SELECT id FROM character_states WHERE character_id = NEW.id);
      ${searchInsertStates("WHERE s.character_id = NEW.id")}`,
    ),
    t(
      "search_characters_ad",
      "AFTER DELETE ON characters",
      `
      DELETE FROM search_index WHERE kind = 'character' AND ref_id = OLD.id;
      DELETE FROM search_index WHERE kind = 'state' AND ref_id IN
        (SELECT id FROM character_states WHERE character_id = OLD.id);`,
    ),
    t(
      "search_states_ai",
      "AFTER INSERT ON character_states",
      `
      DELETE FROM search_index WHERE kind = 'state' AND ref_id = NEW.id;
      ${searchInsertStates("WHERE s.id = NEW.id")}`,
    ),
    t(
      "search_states_au",
      "AFTER UPDATE ON character_states",
      `
      DELETE FROM search_index WHERE kind = 'state' AND ref_id = NEW.id;
      ${searchInsertStates("WHERE s.id = NEW.id")}`,
    ),
    t(
      "search_states_ad",
      "AFTER DELETE ON character_states",
      `
      DELETE FROM search_index WHERE kind = 'state' AND ref_id = OLD.id;`,
    ),
    // A12: threads and their touches. A thread change refreshes its own row; a
    // touch insert/update/delete refreshes the parent thread's row (the body
    // embeds every touch's evidence).
    t("search_threads_ai", "AFTER INSERT ON threads", refreshThread("NEW.id")),
    t("search_threads_au", "AFTER UPDATE ON threads", refreshThread("NEW.id")),
    t(
      "search_threads_ad",
      "AFTER DELETE ON threads",
      `
      DELETE FROM search_index WHERE kind = 'thread' AND ref_id = OLD.id;`,
    ),
    t(
      "search_thread_touches_ai",
      "AFTER INSERT ON thread_touches",
      refreshThread("NEW.thread_id"),
    ),
    t(
      "search_thread_touches_au",
      "AFTER UPDATE ON thread_touches",
      refreshThread("NEW.thread_id"),
    ),
    t(
      "search_thread_touches_ad",
      "AFTER DELETE ON thread_touches",
      refreshThread("OLD.thread_id"),
    ),
  ].join("\n");
}

// Wipes and repopulates the whole index from the source tables. Exported for
// tests; called from migrate() on every startup (D103).
export function rebuildSearchIndex(sqlite: Database.Database): void {
  sqlite.exec(`
    DELETE FROM search_index;
    ${searchInsertChapters("")}
    ${searchInsertCanon("")}
    ${searchInsertCharacters("")}
    ${searchInsertStates("")}
    ${searchInsertThreads("")}
  `);
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

// A16: the editable title of the series the trilogy is backfilled into and the
// one a fresh database seeds.
const DEFAULT_SERIES_TITLE = "The Trilogy";

// Idempotent seed. Only inserts when the target rows are absent, so re-running is
// safe. The default series is created once; books are created once, assigned to
// it; seed style rules are created once (matched by exact content + source
// 'seed'), series-wide within that series (project_id NULL, series_id set).
export function seed(sqlite: Database.Database): void {
  const seriesId = ensureDefaultSeries(sqlite);

  const projectCount = sqlite
    .prepare("SELECT COUNT(*) AS n FROM projects")
    .get() as { n: number };

  if (projectCount.n === 0) {
    const insertProject = sqlite.prepare(
      "INSERT INTO projects (title, order_index, series_id) VALUES (?, ?, ?)",
    );
    SEED_PROJECTS.forEach((title, i) => insertProject.run(title, i, seriesId));
  }

  const findSeed = sqlite.prepare(
    "SELECT id FROM canon_facts WHERE content = ? AND source = 'seed'",
  );
  const insertFact = sqlite.prepare(
    `INSERT INTO canon_facts (project_id, series_id, type, content, status, source)
     VALUES (NULL, ?, 'style_rule', ?, 'locked', 'seed')`,
  );
  for (const content of SEED_STYLE_RULES) {
    const existing = findSeed.get(content);
    if (!existing) insertFact.run(seriesId, content);
  }
}

export function migrateAndSeed(sqlite: Database.Database): void {
  migrate(sqlite);
  seed(sqlite);
}

export { SEED_STYLE_RULES, SEED_PROJECTS, DEFAULT_SERIES_TITLE };
