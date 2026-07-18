import { sql, type SQL } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "./db/schema";
import { orderToUiChapter } from "./chapterNumbering";

type Db = BetterSQLite3Database<typeof schema>;

// Amendment A11: the one query layer over the FTS5 search_index. All three
// surfaces (the command palette, /api/search, and the MCP search tool) go
// through searchIndex(), so they share sanitization, ranking, filtering, and
// the A2 1-based chapter conversion.

export const SEARCH_KINDS = [
  "chapter",
  "canon",
  "character",
  "state",
  "thread",
] as const;
export type SearchKind = (typeof SEARCH_KINDS)[number];

// Snippet marker characters at the layer boundary (D106). Control characters
// cannot appear in real content, so they cannot collide. The palette turns
// them into <mark> segments; the MCP tool replaces them with **.
export const SNIPPET_START = "\u0001";
export const SNIPPET_END = "\u0002";

export interface SearchHit {
  kind: SearchKind;
  id: number;
  projectId: number | null;
  // Display title. Chapters with no title fall back to "Chapter N"; canon hits
  // have an empty title (the content IS the snippet); state hits carry the
  // owning character's name.
  title: string;
  // Matched-range snippet using SNIPPET_START / SNIPPET_END markers.
  snippet: string;
  // 1-based chapter number (chapter hits: the chapter itself; state hits: the
  // chapter the state is effective from). Converted via chapterNumbering (A2).
  chapter?: number;
  // chapter hits: chapter status. canon hits: fact status. thread hits: thread
  // status (open | resolved | retired).
  status?: string;
  canonType?: string;
  pov?: string | null;
  role?: string | null;
  // state hits: the owning character.
  characterId?: number;
  // thread hits (A12): the thread type (arc | mystery | promise | relationship).
  threadType?: string;
}

export interface SearchOptions {
  query: string;
  kinds?: SearchKind[];
  projectId?: number;
  includeRetired?: boolean;
  limit?: number;
}

// Sanitizes free text into an FTS5 MATCH expression that is safe by
// construction (D104): tokens are whitespace-split, stripped of double quotes,
// control characters, and the operator characters * ^ ( ), then quoted as
// phrases, so user input can never be interpreted as FTS syntax. Hyphens,
// apostrophes, and colons are kept: inside a quoted phrase they are plain
// token separators, exactly as they are in indexed content, so "well-worn"
// and "don't" match. The final token becomes a prefix query when it has at
// least two characters, so the palette feels like typeahead. Returns null
// when nothing searchable remains.
export function toFtsQuery(raw: string): string | null {
  const tokens = raw
    .split(/\s+/)
    .map((t) => t.replace(/["*^()\u0000-\u001f]/g, ""))
    .filter((t) => /[\p{L}\p{N}]/u.test(t))
    .slice(0, 8);
  if (tokens.length === 0) return null;
  const phrases = tokens.map((t) => `"${t}"`);
  const last = tokens[tokens.length - 1];
  if (last.length >= 2) phrases[phrases.length - 1] = `"${last}"*`;
  return phrases.join(" ");
}

interface RawRow {
  kind: string;
  refId: number | string;
  projectId: number | string | null;
  meta: string | null;
  title: string | null;
  snip: string | null;
}

// Ranked full-text search. Retired canon facts are excluded unless asked for;
// a projectId scope keeps series-wide rows (NULL project: series canon and all
// characters) visible alongside the book's own rows.
export function searchIndex(db: Db, opts: SearchOptions): SearchHit[] {
  const match = toFtsQuery(opts.query);
  if (!match) return [];

  const limit = Math.max(1, Math.min(50, Math.floor(opts.limit ?? 20)));
  const kinds =
    opts.kinds && opts.kinds.length > 0
      ? SEARCH_KINDS.filter((k) => opts.kinds!.includes(k))
      : [...SEARCH_KINDS];
  if (kinds.length === 0) return [];

  const conds: SQL[] = [
    sql`search_index MATCH ${match}`,
    sql`kind IN (${sql.join(
      kinds.map((k) => sql`${k}`),
      sql`, `,
    )})`,
  ];
  if (typeof opts.projectId === "number") {
    conds.push(sql`(project_id IS NULL OR project_id = ${opts.projectId})`);
  }
  if (!opts.includeRetired) {
    conds.push(
      sql`NOT (kind = 'canon' AND json_extract(meta, '$.status') = 'retired')`,
    );
  }

  // bm25 weights follow the column order (kind, ref_id, project_id, meta,
  // title, body): title outranks body. snippet column -1 auto-selects the
  // matched column; the markers are injected via char() so no string literal
  // is involved (D106).
  const rows = db.all<RawRow>(sql`
    SELECT kind,
           ref_id AS refId,
           project_id AS projectId,
           meta,
           title,
           snippet(search_index, -1, char(1), char(2), '...', 12) AS snip
    FROM search_index
    WHERE ${sql.join(conds, sql` AND `)}
    ORDER BY bm25(search_index, 0, 0, 0, 0, 4.0, 1.0)
    LIMIT ${limit}
  `);
  return rows.map(shapeHit);
}

function shapeHit(r: RawRow): SearchHit {
  let meta: Record<string, unknown> = {};
  try {
    meta = r.meta ? (JSON.parse(r.meta) as Record<string, unknown>) : {};
  } catch {
    // A malformed meta row degrades to a hit without metadata, never a throw.
  }
  const base: SearchHit = {
    kind: (SEARCH_KINDS as readonly string[]).includes(r.kind)
      ? (r.kind as SearchKind)
      : "canon",
    id: Number(r.refId),
    projectId: r.projectId === null ? null : Number(r.projectId),
    title: r.title ?? "",
    snippet: r.snip ?? "",
  };
  switch (base.kind) {
    case "chapter": {
      const chapter = orderToUiChapter(Number(meta.orderIndex ?? 0));
      return {
        ...base,
        chapter,
        status: typeof meta.status === "string" ? meta.status : undefined,
        pov: typeof meta.pov === "string" ? meta.pov : null,
        title: base.title || `Chapter ${chapter}`,
      };
    }
    case "canon":
      return {
        ...base,
        canonType: typeof meta.type === "string" ? meta.type : undefined,
        status: typeof meta.status === "string" ? meta.status : undefined,
      };
    case "character":
      return { ...base, role: typeof meta.role === "string" ? meta.role : null };
    case "state":
      return {
        ...base,
        characterId: Number(meta.characterId ?? 0),
        chapter: orderToUiChapter(Number(meta.chapterOrder ?? 0)),
      };
    case "thread":
      return {
        ...base,
        threadType: typeof meta.type === "string" ? meta.type : undefined,
        status: typeof meta.status === "string" ? meta.status : undefined,
      };
  }
}
