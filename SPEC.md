# bookforge: AI-drafted, human-steered novel writing tool

## Instructions for Claude Code

Read this entire spec before writing any code. Build it in the phases listed at the bottom, in order, one phase per session unless told otherwise. Do not add features that are not in this spec. Do not skip the acceptance checks at the end of each phase. When a design decision is ambiguous, choose the simplest option that satisfies the workflow described here and note the choice in a DECISIONS.md file at the repo root.

Hard rule that applies to every file, every prompt template, and every piece of generated prose in this project: never use em-dashes. Not in code comments, not in UI copy, not in LLM outputs. This is enforced in prompt templates below and should also be enforced with a post-generation lint (see Drafting pipeline).

## What this is

A single-user, self-hosted web app for writing a fantasy trilogy where the AI drafts prose and the human steers. It productizes a working method already proven on Book 1: hard canon rules, decision interrogation before drafting, chapter-by-chapter review with inline span comments, revisions that touch only flagged spans, and adversarial consistency sweeps.

The design thesis: the canon store is the product. Every LLM call is assembled from it, and every locked chapter feeds approved facts back into it. Prose generation without this loop produces drift and slop by chapter 15.

The user is technical (reads code, uses the terminal) but this is a writing tool, so the UI should be calm, text-forward, and fast. No dashboard aesthetics.

## Non-goals for v1

- No image generation
- No multi-user support, no accounts beyond a single shared password
- No story arc visualizations or tension graphs
- No export formats beyond concatenated Markdown
- No mobile-optimized layout (desktop browser only)
- No real-time collaboration, comments threads, or version branching beyond linear draft versions

If any of these seem tempting mid-build, do not build them. Note them in DECISIONS.md as deferred.

## Tech stack (locked decisions)

- Next.js 15, App Router, TypeScript, server actions where natural, route handlers for streaming
- Tailwind CSS for styling
- SQLite via better-sqlite3, Drizzle ORM, single DB file at ./data/bookforge.db
- @anthropic-ai/sdk for all LLM calls, server-side only
- Streaming responses for drafting (SSE via route handler or the SDK's stream helper)
- Auth: single password in APP_PASSWORD env var, checked by middleware, signed httpOnly session cookie
- Runs locally with npm run dev as the primary mode. Deployment is a later concern (Fly.io with a volume is the intended target; do not build deploy config until Phase 7)

Environment variables (.env.local, with a committed .env.example):

```
ANTHROPIC_API_KEY=
APP_PASSWORD=
DRAFT_MODEL=claude-sonnet-4-6
UTILITY_MODEL=claude-sonnet-4-6
SESSION_SECRET=
```

DRAFT_MODEL is used for prose generation and revision. UTILITY_MODEL is used for interrogation, summaries, canon extraction, and sweeps. Keep them separately configurable so the user can put a stronger model on prose without paying for it everywhere. Verify current model strings against https://docs.claude.com before hardcoding defaults.

## Data model

Series and books: one series, multiple books. Canon can be series-wide (project_id null) or book-specific.

```sql
CREATE TABLE projects (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  order_index INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE canon_facts (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),   -- NULL = series-wide
  type TEXT NOT NULL CHECK (type IN (
    'world_rule',        -- magic systems, physics of the world
    'style_rule',        -- register, forbidden constructions, dialect rules
    'timeline_event',    -- things that happened, in order
    'character_fact',    -- durable facts about a character
    'plot_decision'      -- authorial decisions locked before or during drafting
  )),
  content TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'provisional' CHECK (status IN ('locked','provisional','retired')),
  source TEXT,           -- 'seed', 'interrogation:<chapter_id>', 'extraction:<chapter_id>', 'manual'
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE characters (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,             -- one line: 'fire elemental, POV', 'antagonist', etc.
  voice_rules TEXT,      -- dialect constraints, verbal tics, what they would never say
  physical TEXT,
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Character knowledge/emotional state evolves. State as of chapter N is the
-- most recent row with chapter_order <= N for that character.
CREATE TABLE character_states (
  id INTEGER PRIMARY KEY,
  character_id INTEGER NOT NULL REFERENCES characters(id),
  project_id INTEGER NOT NULL REFERENCES projects(id),
  chapter_order INTEGER NOT NULL,  -- effective from this chapter onward
  knows TEXT,            -- what they know that they did not before
  feels TEXT,            -- emotional state / stance toward other characters
  hiding TEXT,           -- secrets they are keeping and from whom
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE chapters (
  id INTEGER PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  order_index INTEGER NOT NULL,
  title TEXT,
  pov TEXT,              -- character name or 'omniscient'
  synopsis TEXT,         -- 2-5 sentences, what this chapter accomplishes
  beats TEXT,            -- JSON array of beat strings, in order
  dependencies TEXT,     -- JSON array of canon_fact ids this chapter relies on
  summary TEXT,          -- generated at lock time, editable, used by the assembler
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN
    ('planned','interrogating','drafting','review','locked')),
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE drafts (
  id INTEGER PRIMARY KEY,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id),
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE comments (
  id INTEGER PRIMARY KEY,
  draft_id INTEGER NOT NULL REFERENCES drafts(id),
  quoted_text TEXT NOT NULL,   -- exact span text, used as the anchor
  span_start INTEGER,          -- char offsets, best-effort, recomputed on load
  span_end INTEGER,
  comment TEXT NOT NULL,
  resolved INTEGER DEFAULT 0,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE questions (
  id INTEGER PRIMARY KEY,
  chapter_id INTEGER NOT NULL REFERENCES chapters(id),
  question TEXT NOT NULL,
  answer TEXT,
  resulting_fact_id INTEGER REFERENCES canon_facts(id),
  created_at TEXT DEFAULT (datetime('now'))
);
```

Span anchoring: quoted_text is the source of truth for a comment's location. Offsets are cached for rendering but recomputed by string search on load, because draft text is immutable per version (a revision creates a new draft version and unresolved comments do not carry forward automatically).

## Seed data

Run on first migration. One series, three projects (Book 1, Book 2, Book 3, titles editable). Seed these series-wide canon_facts as type style_rule, status locked, source 'seed':

1. Never use em-dashes anywhere in prose, dialogue, or interiority. Use commas, colons, full stops, or restructure the sentence.
2. Register target: literary fantasy. Deep character interiority in the mode of N.K. Jemisin, with dry, understated humor in the mode of Joe Abercrombie. No purple prose, no epic-fantasy formality.
3. Britishisms are restricted to one designated character only (configure per character via voice_rules). No other character uses them.
4. Dialogue carries subtext. Characters routinely do not say the thing directly. Avoid on-the-nose emotional declarations.
5. Scene endings land on an image or an action, not a summary of feelings.

The user will edit and extend these. They are seeds, not gospel.

## Workflows

### 1. Canon manager

Page: /canon. Filterable list (by type, status, book scope) with inline add, edit, lock/unlock, retire. Locked facts render with a lock icon and require an explicit unlock action before editing. Retired facts are kept but excluded from all prompt assembly. Bulk paste: a textarea where the user pastes multiple facts, one per line, with a type selector; creates them as provisional.

This page must be fast and keyboard-friendly. It will hold hundreds of rows by Book 2.

### 2. Characters

Page: /characters. Card list with a + button. Card fields: name, role, voice_rules, physical, notes. Each card expands to show its state timeline (character_states rows ordered by book and chapter_order) with an add-state form. State rows are short and factual, for example: knows: "Julian's real name", feels: "distrusts Julian, protective of Mara", hiding: "the intensity secret, from everyone".

### 3. Sequencer and interrogation

Page: /book/[projectId]. Ordered chapter list, drag to reorder (persist order_index), + to add. Each chapter row shows title, POV, status pill, and expands to edit synopsis and beats (beats as a reorderable list of short strings).

Interrogation: a button on each planned chapter. Calls UTILITY_MODEL with the interrogation prompt (below). Renders the returned questions as a form. Each answered question is saved and converted into a provisional plot_decision canon fact (linked via resulting_fact_id). The user reviews and locks facts before drafting. A chapter cannot enter drafting status while it has unanswered interrogation questions (soft block with an override button, not a hard block).

### 4. Drafting (the core, spend the most effort here)

Page: /book/[projectId]/chapter/[chapterId]/draft.

Drafting is scene-by-scene, not whole-chapter one-shot. Each generation call covers 1-2 beats and targets 800-1500 words. The user clicks Continue to draft the next beat group, or Redraft to regenerate the current one. Output streams into the editor.

The context assembler builds every drafting prompt from these blocks, in this order:

1. System prompt (template below): role, register, hard style rules pulled live from locked style_rule facts
2. CANON block: all locked world_rule, timeline_event, and plot_decision facts in scope (series-wide plus this book), grouped by type. Character_fact entries only for characters appearing in this chapter
3. CHARACTERS block: for each character in this chapter, the card fields plus their effective state as of this chapter (latest state row with chapter_order <= this chapter's order_index)
4. STORY SO FAR block: the stored summary of every prior locked chapter in this book, in order, plus a one-line summary per prior book if any
5. PREVIOUS CHAPTER block: full text of the immediately previous locked chapter (latest draft version)
6. CURRENT CHAPTER block: synopsis, full beat list with the target beats marked, POV, plus the full text drafted so far in this chapter
7. TASK block: draft the marked beats, target length, end condition (stop at the end of the last marked beat, do not run ahead)

Token budget guidance (approximate, enforce with a character-count heuristic, not a tokenizer):

- Canon: cap at ~4,000 tokens; if over, include locked facts only and log a warning
- Story so far: ~150 words per chapter summary
- Previous chapter: cap at ~8,000 tokens; if over, truncate from the front and keep the final portion
- Current chapter drafted-so-far: cap at ~6,000 tokens; if over, replace the oldest scenes with their beat labels and keep the last 1,000 words verbatim

Post-generation lint, run on every draft and revision output before saving:

- Reject and auto-retry once if the output contains an em-dash character (U+2014) or a double hyphen used as one
- Warn (do not reject) if any configured Britishism appears outside the designated character's dialogue (simple heuristic: the term appears in a paragraph that does not contain that character's dialogue attribution; imperfect is fine, this is a tripwire not a court)

DRAFT_SYSTEM_PROMPT template (assembler fills the bracketed parts):

```
You are drafting prose for a literary fantasy novel. You write scenes, not summaries. You never break character or address the author except when a required fact is missing (see below).

Register and style rules, all mandatory:
[locked style_rule facts, one per line]

Rules of engagement:
- Draft ONLY the beats marked in the TASK block. Stop when the last marked beat completes. Do not draft ahead.
- Everything in the CANON block is immutable fact. If a beat appears to contradict canon, write the scene in the way that honors canon and append a single line at the very end after the marker [CANON TENSION]: describing the conflict in one sentence.
- If drafting requires a fact that is not in canon (a name, a distance, whether a character knows something), do not invent it. Append a line at the end after the marker [MISSING FACT]: stating what you needed. Write the scene around the gap if possible.
- POV discipline: stay inside [POV character]'s perception. No head-hopping.
- Match the voice of the PREVIOUS CHAPTER text. Continuity of voice outranks novelty.
```

The UI surfaces any [CANON TENSION] and [MISSING FACT] lines as alerts above the editor; missing facts get a one-click "answer and add to canon" flow that creates a locked fact and offers a redraft.

### 5. Review and revision

Page: /book/[projectId]/chapter/[chapterId]/review.

The draft renders as read-only prose. The user selects any span of text and attaches a comment (stored with quoted_text anchor). Comments list in a side panel. When done, the user clicks "Revise flagged spans".

REVISION_PROMPT contract (this is the feature that protects quality, implement it exactly):

```
You are revising a chapter draft. The author has flagged specific spans with comments. Your contract:
- Change ONLY the flagged spans, plus the minimum surrounding text needed for grammatical continuity.
- If a flagged change forces a consistency fix elsewhere in the chapter (a name, a repeated detail), you may make that fix, and you must list every such out-of-span change at the end after the marker [CONSISTENCY FIXES]: with a one-line justification each.
- Do not restyle, tighten, or improve unflagged text. Resist the urge.
- All style rules from the system prompt still apply.
Return the complete revised chapter text.
```

Diff enforcement, mechanical, after every revision: compute a diff between the previous version and the returned text (a line-based diff with word-level refinement is sufficient; use the diff npm package). Every changed hunk must either overlap a flagged span (with a 200-character tolerance window on each side) or correspond to a declared [CONSISTENCY FIXES] entry. Any changed hunk that does neither is rendered in a warning panel as "unauthorized change" with side-by-side old/new and per-hunk accept/reject buttons. Rejecting a hunk restores the original text for that hunk. Only after the user resolves all warnings does the revision save as a new draft version. This mechanizes the discipline that previously depended on the author catching drift by eye.

### 6. Lock, extract, sweep

Locking a chapter (button on the review page, enabled when all comments are resolved):

1. Generate and store the chapter summary (UTILITY_MODEL, ~150 words, factual, present tense, includes any canon-relevant developments)
2. Run canon extraction: UTILITY_MODEL reads the final text plus the current canon list and returns proposed new facts as JSON: [{type, content, evidence_quote}]. Instruct it to propose only durable facts (things future chapters must not contradict), not scene details. Render proposals as a checklist; approved ones become locked canon_facts with source 'extraction:<chapter_id>'; rejected ones are discarded. Canon grows only through this approval gate.
3. Chapter status becomes locked. Editing a locked chapter requires unlocking, which flags its summary and extracted facts as stale for regeneration.

Consistency sweep (button at book level, run on demand): for each locked chapter in order, send the chapter text plus the full locked canon to UTILITY_MODEL with instructions to report contradictions only, as JSON: [{chapter, quote, conflicting_fact_id or description, severity}]. Aggregate into a report page at /book/[projectId]/sweep. One chapter per call, sequential, with a progress indicator. This will be slow and cost real tokens; show an estimate (chapter count) before running and let the user select a chapter range.

### 7. Backfill importer (required for the tool to be worth anything on Book 2)

Page: /book/[projectId]/import. Paste one chapter's text, confirm title and order, save as a locked chapter with a single draft version, then run the same summary + canon extraction flow as locking. This is how Book 1 gets loaded so its canon and summaries power Book 2 drafting. Design extraction prompts so that running this 23 times in a row is tolerable: batch the approval UI, support keyboard shortcuts (a to approve, r to reject, arrows to move).

### 8. Export

Button at book level: concatenate locked chapters (latest versions) in order into a single Markdown file with chapter headings, download. Nothing fancier.

## API surface (route handlers)

- POST /api/auth/login, POST /api/auth/logout
- CRUD: /api/canon, /api/characters, /api/characters/[id]/states, /api/chapters, /api/chapters/reorder
- POST /api/chapters/[id]/interrogate
- POST /api/questions/[id]/answer (saves answer, creates provisional fact)
- POST /api/chapters/[id]/draft (body: beat indices; streams)
- POST /api/drafts/[id]/comments, PATCH /api/comments/[id]
- POST /api/drafts/[id]/revise (streams, then returns diff analysis)
- POST /api/revisions/[id]/resolve (accept/reject hunks, saves new version)
- POST /api/chapters/[id]/lock
- POST /api/chapters/[id]/extract-canon, POST /api/extractions/approve
- POST /api/projects/[id]/sweep (body: chapter range)
- POST /api/projects/[id]/import
- GET /api/projects/[id]/export

## LLM integration notes

- All calls server-side via @anthropic-ai/sdk, key from env, never exposed to the client
- Drafting and revision use streaming; utility calls (interrogation, summary, extraction, sweep) are non-streaming with JSON outputs where specified
- For JSON outputs, instruct the model to return only JSON, then parse defensively (strip code fences, try/catch, surface parse failures in the UI rather than silently dropping)
- Set max_tokens generously for prose (4096+ per scene call) and log input/output token counts per call to a simple llm_calls table (id, purpose, chapter_id, input_tokens, output_tokens, created_at) so the user can see cost drift
- Retry once on transient API errors, then surface the error

## Build phases and acceptance checks

Phase 1: Scaffold, auth, DB, canon manager, characters.
Check: fresh clone + .env + npm run dev gives a login gate, seeded style rules visible at /canon, can add/lock/retire facts, can create characters with state timelines. Migrations run idempotently.

Phase 2: Sequencer and interrogation.
Check: create chapters with synopsis and beats, reorder persists, interrogation returns questions, answering one produces a provisional canon fact linked to the question, locking that fact works from the same screen.

Phase 3: Context assembler and drafting.
Check: with seeded canon, two characters, one locked prior chapter (inserted manually via import or SQL), drafting a beat streams prose to the editor; the assembled prompt is loggable in dev mode for inspection; em-dash lint triggers a retry when forced; [MISSING FACT] lines surface as alerts.

Phase 4: Review and revision with diff enforcement.
Check: select text, attach comments, run revision, deliberately induce an out-of-span change (comment asking to rename something mentioned twice) and confirm the unauthorized-change panel catches unrelated edits while [CONSISTENCY FIXES] entries pass; accept/reject per hunk produces the correct final text as a new version.

Phase 5: Lock, extraction, sweep.
Check: locking generates a summary and extraction proposals; approvals become locked facts; sweep over two chapters with a planted contradiction (edit canon to conflict with a chapter) reports it.

Phase 6: Backfill importer and export.
Check: import three chapters back-to-back with keyboard-driven approvals in under ten minutes of user time; export produces a single Markdown file in reading order.

Phase 7: Hardening and deploy prep.
Check: DB file path configurable, Dockerfile + Fly.io config with a mounted volume, APP_PASSWORD required in production mode, basic backup script (copy the SQLite file with a timestamp).

## Quality bar

This tool exists to make Books 2 and 3 as good as Book 1 with less manual overhead, not to make them faster and worse. Where a tradeoff appears between generation convenience and review rigor, choose rigor. The diff enforcement in Phase 4 and the approval gate in Phase 5 are the two features that must never be softened to "make the flow smoother".
