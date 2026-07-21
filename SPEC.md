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

## Amendments (authorized by the author after the spec was written)

### A1 (2026-07-13): Character-state extraction at lock time

Character states must stay dense automatically as the book progresses. Extend the Phase 5 lock/extraction flow (and the Phase 6 importer, which reuses it): in addition to canon fact proposals, UTILITY_MODEL proposes character_state updates from the locked chapter's final text, as JSON: [{character, knows, feels, hiding, evidence_quote}]. Proposals are deltas only (new knowledge, shifted feelings, secrets gained or revealed), not restatements of existing state. They render in the same approval checklist as fact proposals, with the same keyboard shortcuts. Approved proposals insert character_states rows effective from the chapter after the locked one (chapter_order = locked chapter order_index + 1), editable before approval. Proposals naming a character that does not match an existing characters row cannot be approved until mapped to one (or the character is created inline). Add a nullable source column to character_states ('manual' default, 'extraction:<chapter_id>') via an idempotent migration. The approval gate is not softened: no state row is created without explicit approval.

Phase 5 acceptance check addition: locking a chapter whose text shows a character learning something new produces a character_state proposal; approving it makes the state visible in that character's timeline and effective for the next chapter's assembled prompt.

### A2 (2026-07-13): UI chapter numbering convention and sweep error surfacing

Found during a hands-on test drive. Two fixes, no new features.

A2.1 Chapter numbering: the database stays 0-based (chapters.order_index and character_states.chapter_order share that scale; a state applies to chapters with order_index >= chapter_order). The UI speaks 1-based chapter numbers EVERYWHERE, converting at the boundary. Concretely: the character add-state form accepts "effective from chapter N" where N is the 1-based number shown in the sequencer, and stores chapter_order = N - 1; state timelines display chapter_order + 1; the importer's order field accepts a 1-based position (1 = first) and stores position - 1; any other surface that shows or accepts a chapter number uses the 1-based form. No data migration for existing rows: the semantic is a display/input convention, and there is no production data yet. Regression check, mandatory: entering a state "effective from chapter 1" through the UI for a book's first chapter must make that state appear in that chapter's assembled prompt (verifiable via the dev prompt route). A unit-tested pair of conversion helpers (uiChapterToOrder / orderToUiChapter) must be the single place the conversion happens.

A2.2 Sweep errors carry reasons: a per-chapter LLM or parse failure appears in the sweep report as an entry naming the chapter and the error message (parse failures keep surfacing the raw text). A failure of the whole run shows the underlying message in the UI, never a bare "Sweep failed."

### A3 (2026-07-13): Series bible importer

Purpose: starting Book 2 requires Book 1's chapters (the existing backfill importer) plus the author's story bible: the accumulated world rules, character sheets, timeline notes, and standing decisions that never lived in any chapter. This importer turns a pasted bible into structured, approval-gated data.

Page: /import-bible, linked from the home Books page. A large paste textarea, a scope selector (series-wide, or a specific book), and the same calm approval-checklist UX as the backfill importer, with identical keyboard shortcuts (a approve, r reject, arrows to move).

Route: POST /api/bible/import. UTILITY_MODEL (new purpose "bible") reads the pasted text plus the current canon list and tracked character names (to avoid duplicate proposals) and returns JSON:
{ "facts": [{ "type": "world_rule | style_rule | timeline_event | character_fact | plot_decision", "content": "..." }], "characters": [{ "name": "...", "role": "...", "voice_rules": "...", "physical": "...", "notes": "..." }], "states": [{ "character": "...", "knows": "...", "feels": "...", "hiding": "..." }] }
Long bibles are processed in sequential chunks (split on paragraph boundaries at roughly 24,000 characters per call) with a progress indicator like the sweep's; proposals from all chunks merge into one checklist. Parse failures surface the raw text.

Approval semantics, same gate discipline as everything else (nothing lands unapproved, no approve-all default):
- Approved facts become canon_facts with the chosen scope, status locked, source 'bible'.
- Approved characters are created as characters rows. A proposed character whose name matches an existing one (case-insensitive) is shown as an update proposal against that row rather than a duplicate.
- Approved states require a book scope (disabled for series-wide) and land at chapter_order 0 with source 'bible', i.e. effective from that book's first chapter onward. A state naming a character not yet tracked can be approved together with that character's own creation proposal in the same batch; the character is created first.
- Every LLM call logs to llm_calls with purpose 'bible'.

Acceptance check: paste a bible containing at least two world rules, a style note, two characters (one with voice rules), and one character state; the proposals come back categorized; keyboard-only approval of a subset creates exactly the approved items (locked facts with source 'bible', character rows, a state at chapter_order 0 visible in the timeline); a chapter of the chosen book then shows the approved facts and state in its assembled prompt; rejected proposals leave no trace.

### A4 (2026-07-13): Token efficiency, without losing quality

Two changes. The revision INPUT always remains the full chapter: that is where quality lives and it is the cheap, cacheable side. Never trim it.

A4.1 Prompt caching. The Anthropic client wrapper gains support for a cacheable prompt prefix: an optional promptPrefix on the call options; when present, the real client sends the system text and the prefix as content blocks marked with cache_control (ephemeral), with the variable remainder as an uncached block. The block-construction logic lives in a pure, unit-tested function; the fixture client ignores caching but accepts the same options. Callers that must use it: (1) drafting, where the assembler's stable blocks (system plus CANON, CHARACTERS, STORY SO FAR, PREVIOUS CHAPTER) form the prefix and CURRENT CHAPTER plus TASK form the remainder, so Continue/Redraft bursts within a session hit the cache; (2) the sweep, restructured so the shared locked-canon block is the prefix and the per-chapter text is the remainder; (3) revision, where the system prompt and the chapter text form the prefix (the em-dash retry then hits the cache). llm_calls gains nullable cache_read_tokens and cache_write_tokens columns (idempotent guarded ALTER TABLE, same pattern as character_states.source) populated from the API usage fields, so cost drift and cache savings are visible.

A4.2 Patch-mode revision. The default revision contract changes from "return the complete revised chapter" to returning ONLY the changes, as JSON:
{ "patches": [{ "original": "verbatim text from the chapter, extended to complete sentences", "replacement": "..." }], "consistency_fixes": [{ "original": "...", "replacement": "...", "justification": "one line" }] }
The prompt instructs: patches address the flagged comments; each original must be copied verbatim from the chapter and extended to cover whole sentences including any wording needed to keep the seams smooth; consistency_fixes are the out-of-span changes the old contract declared under [CONSISTENCY FIXES], now as patches with a justification.

Mechanical application, reusing the existing enforcement path unchanged: the server anchors each original in the current text (findSpan semantics: unique or first occurrence), applies all patches to produce the revised full text, then runs the SAME analyzeRevision diff classification and the SAME per-hunk accept/reject resolve flow as Phase 4. Declared entries are the consistency_fixes justifications. A patch whose original cannot be found verbatim is surfaced in the UI as a failed patch with its text shown; the remaining patches still apply. The em-dash lint applies to replacements (reject and retry once, then warn).

Fallback to the old full-text mode: automatically when the flagged spans cover more than 40 percent of the chapter's characters, and when the patch JSON fails to parse after one patch-mode retry (the fallback call is flagged in the UI as a full revision). Patch-mode calls may be non-streaming; the UI shows an in-progress state instead of streamed prose.

Acceptance check: the Phase 4 acceptance scenario re-run in patch mode passes identically (in-span fix applied, declared consistency fix passes, an undeclared out-of-span patch lands in the unauthorized panel, per-hunk accept and reject produce exact final texts); a mid-paragraph patch reads cleanly across both seams (no doubled spaces, no dropped punctuation, asserted mechanically); the output tokens recorded in llm_calls for a small edit set are a small fraction of the chapter's size rather than proportional to it; the drafting and sweep call paths construct a cacheable prefix (unit-asserted on the block-construction function).

### A5 (2026-07-13): Character chatbots

Purpose: talk to a character in their own voice, pinned to a moment in the story, to audition dialogue ("what would you say in this situation"), test whether a beat is in-voice, and keep the author's ear tuned between drafting sessions. This is the deferred idea from DECISIONS.md, now in scope; its prerequisite (dense character states, A1) is built.

Page: /characters/[id]/chat, reachable from a "Chat" action on each character card. Calm, text-forward chat surface consistent with the rest of the app.

Pinning "when": no chat until the moment is pinned. The opening of the session is the bot asking, in effect, "when in the book am I?"; the user answers by picking a book and a 1-based chapter number (A2 convention). The pin is visible for the whole session and can be changed; changing it starts a fresh conversation (state boundaries differ, so history from another moment would leak).

Context assembly for the chat system prompt, all server-side:
- The character card: name, role, voice_rules, physical, notes.
- The character's effective state as of the pinned chapter (existing effectiveState semantics).
- Locked character_fact canon mentioning the character, series-wide plus the pinned book.
- The stored summaries of locked chapters of the pinned book up to and including the pinned chapter, in order (the knowledge horizon).
- Knowledge hygiene rules, mandatory in the prompt: the character knows ONLY what the context establishes as of the pin; they deflect in-character about what their state says they are hiding; they refuse, in-character, to speak of events after the pin; when asked something canon does not establish, they do not invent it: they answer in-character that they do not know, and append a line after the marker [MISSING FACT]: naming what was missing, which the UI surfaces as a subtle note (same convention as drafting).
- Voice discipline: stay in the character's voice per voice_rules; dialogue subtext rules from locked style_rule facts apply; never use em-dashes.

Mechanics:
- UTILITY_MODEL, streaming replies. Purpose "chat" in llm_calls (chapter_id null).
- Multi-turn is serialized into a single prompt: the character context is the cacheable prefix (A4.1 promptPrefix), the running transcript plus the new user message is the variable remainder, so every turn after the first hits the cache.
- Em-dash lint on replies: reject and regenerate once, then surface the existing unresolved warning style.
- Chat history is ephemeral: client-side only, never persisted to the database. Nothing from a chat enters canon except through the explicit gate: each bot reply carries a "propose as canon fact" action that creates a PROVISIONAL canon_fact (type selectable, default character_fact, scope defaulting to the pinned book, source 'chat:<character_id>') which must be locked through the normal canon flow. No auto-locking from chat.

Acceptance check: with a character that has voice_rules and two states (effective from chapters 1 and 4 in UI terms), pinning the chat at chapter 3 assembles a context containing the chapter-1 state and NOT the chapter-4 state, and only summaries of locked chapters up to 3; a fixture-driven reply streams into the chat; asking about a post-pin event yields an in-character refusal (fixture); a reply's "propose as canon fact" creates a provisional fact with source 'chat:<id>' visible at /canon; the database contains no chat transcript afterward.

### A6 (2026-07-13): MCP server

Purpose: expose BookForge to MCP clients (Claude Code, Claude Desktop) so an agent can manage canon, characters, chapters, drafting, and chat programmatically. Local, single-user tool: the MCP server is a local stdio process operating directly on the SQLite database through the same repo layer the routes use; it does not pass the password gate, which is a documented, deliberate decision (same trust boundary as the DB file itself).

Implementation: a script (npm run mcp) using @modelcontextprotocol/sdk (new dependency, latest version) over stdio. It reads the same env (.env.local semantics documented) for DATABASE_PATH and the model vars, honors USE_FIXTURE_LLM for tests, and reuses src/lib repo and llm modules directly. Include an example client registration snippet (.mcp.json) in DEPLOY.md.

Tools (names indicative; all read tools return compact JSON; every chapter number in tool inputs and outputs is 1-based per A2, stated in each tool description):
- canon_list (filters), canon_add (defaults provisional; status must be explicitly provisional or locked), canon_lock, canon_retire
- characters_list, character_get (card plus state timeline), character_add_state (1-based effective-from chapter)
- chapters_list, chapter_get (includes synopsis, beats, status, latest draft text), chapter_create, chapter_update (title, pov, synopsis, beats)
- interrogate_chapter (returns the stored questions), answer_question (creates the provisional plot_decision like the route)
- draft_scene (chapter plus 1-based beat numbers; returns the clean prose, missing facts, canon tensions; non-streaming)
- assembled_prompt (the dev inspection dump for a chapter)
- character_chat (single turn: character, pinned book and 1-based chapter, prior transcript, message; returns the reply and any missing-fact notes; A5 semantics)
- export_book (returns the Markdown)
- sweep_book (chapter range; returns the report; the description warns it costs tokens per chapter)

Hard boundary, from the SPEC quality bar and recorded in the tool set itself: NO MCP tool may approve extraction or bible proposals, resolve revision hunks, lock chapters, or import chapters. Those approval gates are human-only and stay in the UI. The server must not even register tools for them, so a confused agent cannot be talked into it.

Every LLM-calling tool logs to llm_calls with its normal purpose. Errors return MCP tool errors with the underlying message, never silent failures.

Acceptance check: an automated test drives the server over stdio (spawn the process with USE_FIXTURE_LLM=1 and a scratch DATABASE_PATH, speak MCP over the SDK client): lists tools and confirms the human-only actions are absent; canon_add then canon_lock round-trips and the fact appears in canon_list as locked; character_add_state with a 1-based chapter lands at the correct internal order; draft_scene returns the fixture prose with markers extracted; character_chat returns the fixture reply; export_book returns Markdown containing a locked chapter's heading; sweep_book over a range returns the fixture report; an LLM-calling tool logs to llm_calls.

### A7 (2026-07-13, revised): Claude Code auth as the default LLM transport

Purpose: this is a single-user tool running on the author's machine, where Claude Code is installed and authenticated. The app should ride that auth by default instead of requiring a separate ANTHROPIC_API_KEY. Author's directive: use the Claude Code CLI itself, not an SDK package; no new dependencies.

Transport selection in the LLM client factory (getLlmClient), in priority order: USE_FIXTURE_LLM=1 keeps the fixture client (the test loop never makes real calls, unchanged); otherwise LLM_TRANSPORT selects "claude-code" (the new default) or "api-key" (the existing @anthropic-ai/sdk client, which requires ANTHROPIC_API_KEY and keeps its explicit cache_control blocks).

The claude-code transport: a new client implementing the existing LlmClient interface by spawning the locally installed claude binary in headless print mode as a child process per call. Requirements:
- Binary discovery: "claude" on PATH, overridable via CLAUDE_CODE_BIN. A missing or unauthenticated installation surfaces a clear error naming the fix (install the CLI, log in, or provide CLAUDE_CODE_OAUTH_TOKEN), never a bare stack trace or a hung process (set a generous but finite timeout per call).
- complete(): print mode with JSON output; the user prompt is written over stdin (never as an argv argument: assembled prompts routinely exceed Windows command-line length limits), the system prompt via the CLI's system-prompt flag, the model via its model flag, tool use fully disabled and single-turn (use the CLI's flags for turn limit and tool restriction; verify the exact flag names against the installed CLI's help output before coding). Parse the JSON result for the reply text and usage.
- stream(): print mode with streaming JSON output (including partial message events), yielding text deltas as they arrive, then returning the final text and usage, matching the existing AsyncGenerator contract.
- promptPrefix callers keep working: the transport concatenates prefix plus remainder so the model sees byte-identical prompts; block-level cache_control is an api-key-transport detail. Claude Code applies its own caching; cache usage fields it reports (cache creation and cache read input tokens) flow into CompleteResult and llm_calls exactly like A4.1.
- Usage accounting: input, output, cache read, cache write tokens from the CLI's result JSON populate llm_calls unchanged.
- The em-dash lint, markers, retry-once-on-transient, and every calling surface are transport-agnostic and unchanged.
- maxTokens is honored if the CLI exposes a way to cap output; if it does not, the limitation and any env-var escape hatch are documented as a decision rather than silently ignored.

Configuration: .env.example documents LLM_TRANSPORT (default claude-code), CLAUDE_CODE_BIN (optional), marks ANTHROPIC_API_KEY as optional (api-key transport only), and notes the local Claude Code requirement. DEPLOY.md: local npm run dev (the primary mode per this SPEC) needs no key at all; server deploys (Fly/Docker) either set LLM_TRANSPORT=api-key with a key, or install the CLI in the image and supply CLAUDE_CODE_OAUTH_TOKEN minted by the CLI's setup-token flow; recommend api-key for servers.

Testing: the automated loop stays fixture-only. Unit tests cover the transport-selection matrix (fixture / claude-code default / explicit api-key) and pure functions for building the CLI argument list and parsing the CLI's JSON and stream-JSON outputs into text and usage (fed with captured sample outputs, no real calls, no spawned processes). A manual smoke script (npm run llm-smoke) makes one tiny real call through the selected transport and prints the reply and logged usage; it exists for a human (or the orchestrator) to verify auth end to end and is not part of npm test.

Acceptance check: with fixtures off on an authenticated machine, the smoke script returns real model text through the claude-code transport and a real drafting call works in the app with no ANTHROPIC_API_KEY set; the full automated suite passes unchanged on fixtures; llm_calls rows from claude-code calls carry token counts.

### A5.1 (2026-07-13): Chat fixes from the live test drive

Two small corrections found driving A5 with real model output:

A5.1a No narration, no author. The chat system prompt gains explicit rules: the character speaks ONLY in the first person; no third-person stage directions (the live drive produced lines like "She pulled the edge of her left glove straighter"); no reference to the author or to anyone outside the conversation except through the [MISSING FACT] marker line. Unit-assert the rules are present in the assembled system prompt.

A5.1b Pin validation. The pin form accepted chapter 13 in a four-chapter book. The chat page clamps the pinned chapter to [1, number of chapters in the selected book] and shows the valid range; the chat route rejects an out-of-range pin with a clear error. Pinning past the last chapter is not a use case v1 supports; the last chapter means "end of book so far".

Deferred (recorded, not built): per-conversation CLI session reuse via the claude binary's resume capability, so chat turns on the claude-code transport hit the provider cache (the drive measured cache writes every turn but zero reads across one-shot spawns). Revisit if chat becomes heavy.

### A8 (2026-07-13): Per-purpose model routing

Purpose: the SPEC's original two-knob split (DRAFT_MODEL for prose, UTILITY_MODEL for everything else) is too coarse now that chat exists and transports differ in cost profile. The author picks the model per purpose, at runtime, from a calm settings page: for example Fable for chat and drafting, Sonnet for revision, a cheaper model for extraction and sweeps.

Data: a settings table (idempotent CREATE TABLE IF NOT EXISTS; simple key/value: key TEXT PRIMARY KEY, value TEXT NOT NULL). Model overrides live under keys model.<purpose> for exactly these purposes: draft, revision, chat, interrogation, summary, extraction, sweep, bible. Additionally llm_calls gains a nullable model column (guarded ALTER, same pattern as prior columns) so every logged call records which model served it; this also completes the SPEC's original cost-drift intent.

Resolution: one resolver, modelFor(db, purpose), used by EVERY call site (routes and MCP tools; no call site keeps a private process.env read): settings override if present, else the purpose's env default (DRAFT_MODEL for draft and revision, UTILITY_MODEL for the rest), else claude-sonnet-4-6. The env vars remain the deploy-time defaults and are documented as such in .env.example.

Page /settings, linked from the top navigation: one row per purpose showing the effective model and its source (override or env default), a free-text model input with clickable suggestion chips for common choices (suggestions are conveniences, not a whitelist; ids change over time), a per-row Reset to default (deletes the override row), and a per-row Test button. Test makes one tiny real call through the ACTIVE transport with the entered model (new LlmPurpose "model_test", logged to llm_calls like everything else) and shows either the reply snippet with token counts or the underlying error verbatim (an unentitled or misspelled model id must fail at settings time, not mid-draft). Note in the UI copy that alias names like sonnet or opus work on the claude-code transport but the api-key transport needs full model ids.

API: GET and PUT /api/settings/models (the full purpose map), POST /api/settings/models/test (body: model, returns ok with usage or the error message).

Testing: automated loop stays fixture-only (a model_test fixture backs the Test button in e2e). Unit: resolver precedence (override beats env beats fallback; unknown purpose rejected), settings repo round-trip, migration idempotence for the settings table and the llm_calls model column. E2E: set an override for draft on /settings, run a fixture draft, assert the llm_calls row records the overridden model (dev readback route); reset restores the env default (asserted the same way); the Test button returns ok under fixtures. The real invalid-model error path is unit-tested at the error-mapping level and verified manually via the real transport, not in the automated loop.

Acceptance check: with an override set for chat, a chat call logs that model in llm_calls while draft calls still log the draft default; clearing the override reverts the next call; the Test button run manually on this machine against the claude-code transport accepts a valid id and shows a clear verbatim error for a nonsense id.

### A9 (2026-07-14): Design pass with dark mode

Purpose: the UI is functional but visually plain and light-only. This amendment makes it a genuinely good writing-tool interface with a light/dark toggle. The original aesthetic contract still governs: calm, text-forward, fast, no dashboard aesthetics. Good here means quiet confidence and typographic care, not decoration.

Theme mechanics:
- Two themes only, light and dark, chosen by an explicit toggle in the top navigation. No system-preference mode.
- The choice persists in a long-lived plain cookie readable by the server. The root layout reads it and stamps the dark class on the html element at server render, so there is never a flash of the wrong theme. The login page (pre-auth) is themed the same way.
- Tailwind class strategy (darkMode "class").

Design system, one place to change things:
- Semantic color tokens as CSS variables defined per theme in globals.css and mapped into the Tailwind theme (for example paper, ink, muted, chrome surface, chrome border, accent, and the alert families amber/sky/red/green). Components use the semantic tokens; raw palette classes like bg-white or border-neutral-200 disappear from components entirely.
- Light: keep the warm paper feel (do not go clinical white). Dark: warm dark gray paper (never pure black), off-white ink, FULL contrast preserved on reading surfaces (draft editor, review prose, chat, summaries), slightly reduced contrast on chrome. Alert colors legible in both themes.
- Typography: a deliberate scale (page title, section, body, caption), system serif for all prose reading surfaces with comfortable line-height and a bounded measure (roughly 70ch) so long chapters read well; system sans for chrome.
- Interaction polish: a clear button hierarchy (primary, secondary, quiet, destructive), consistent input and select styling, visible keyboard focus rings (focus-visible) everywhere including the keyboard-driven approval checklists, hover states, and consistent spacing rhythm across pages.
- Considered empty states (no chapters yet, no facts match, no states yet) instead of bare gray one-liners.
- A simple favicon (a minimal book glyph, inline SVG or .ico) so the tab is identifiable.
- No animations beyond subtle transitions on hover/focus and theme change; no shadows-heavy cards; no dashboard styling. Desktop only, as ever.

Scope: every page and component (login, home, canon, characters, character chat, sequencer, draft, prompt inspector, review, sweep, import, import-bible, settings, TopNav, all alert/panel components). All existing data-testid attributes and aria labels stay exactly as they are so the e2e suite is undisturbed.

Testing and acceptance:
- All existing tests pass unchanged (222 unit, 34 e2e, cold-capable).
- New e2e: the toggle switches the html class and persists across reload and across pages; a server-rendered request with the cookie set arrives with the dark class already present (no-flash assertion at the HTML level).
- A repo-level check (unit test or lint script run in npm test) asserting components contain no raw bg-white / bg-neutral- / border-neutral- / text-neutral- classes, so the token system cannot silently erode.
- Screenshot evidence for review: a script or test that captures both themes across the main pages (login, canon, characters, chat, draft, review, settings) into a local folder for the orchestrator's visual review. Screenshots are review artifacts, not committed assertions.
- The em-dash rule applies to all new UI copy.

### A10 (2026-07-14): Chat session reuse on the claude-code transport

Purpose: builds the deferred A5.1 item. On the claude-code transport every chat turn spawns a fresh one-shot `claude` process, so the provider cache from the prior turn is never read (measured: cache writes every turn, cache_read_tokens 0 on all logged chat calls) and every turn re-sends the entire growing transcript. Long conversations get slower and costlier per turn, and before the output cap was added they died on the per-call timeout. This amendment makes the transport resume one CLI session per conversation so turn N+1 sends only the new message and reads the rest from the provider cache.

Empirical CLI behavior this design relies on, verified against the installed CLI (2.1.209) before coding, per the A7 rule: a `--print` call WITHOUT `--no-session-persistence` returns a `session_id` in its result JSON; a later `--print --resume <session_id>` call continues that conversation (a remembered codeword is recalled), reports the same session_id, and reports nonzero cache_read_input_tokens; the original `--system-prompt` is retained across resume without re-passing it; resuming a nonexistent session id fails fast with the text "No conversation found with session ID".

Interface contract:
- CompleteOptions gains optional `sessionKey?: string`, an opaque conversation identifier. The fixture and api-key clients accept and ignore it. Only the claude-code transport acts on it.
- LlmClient gains optional `hasSession?(key: string): boolean`. The claude-code transport reports whether it holds a live CLI session id for the key; clients that do not implement it are treated as always false.
- CompleteResult gains optional `sessionId?: string`, populated by the CLI result parser (both json and stream-json paths). Not logged to llm_calls.
- buildCliArgs gains `persistSession?: boolean` (omit `--no-session-persistence`) and `resumeSessionId?: string` (omit `--no-session-persistence`, add `--resume <id>`, and do NOT re-pass `--system-prompt`: the session retains it). With neither option the argv is byte-identical to today, so every non-chat call path is unchanged.

Claude-code transport mechanics:
- An in-process SessionStore (exported, unit-tested) maps sessionKey to CLI session id, capped at 64 entries with oldest-first eviction. It is per-process memory: a server restart empties it, which is safe because the chat client always sends the full transcript, so the next turn re-seeds a fresh session losslessly.
- complete()/stream() with a sessionKey: on a store hit, spawn with `--resume <id>` and write ONLY `opts.prompt` to stdin (the prefix already lives in the session). On a miss, spawn with persistSession and write prefix plus prompt as today, then store the returned session id.
- Resume failure recovery ("No conversation found" or the session file is gone): drop the store entry; complete() retries once as a fresh sessionful call with the payload it has; stream() restarts the child the same way provided no delta has been yielded yet (nothing was streamed, so the restart is invisible). The recovered turn loses prior-transcript context in the worst case; the following turn re-seeds fully from the client transcript.
- Every other purpose (draft, revision, extraction, sweep, summary, interrogation, bible, model_test) passes no sessionKey and keeps the exact one-shot behavior it has today.

Chat route and UI:
- The chat client generates a conversationId (crypto.randomUUID()) whenever the pin is set or changed, and sends it with every turn. Changing the pin already starts a fresh conversation; it now also rotates the conversationId.
- The route validates conversationId (^[A-Za-z0-9-]{8,64}$, else ignored), builds sessionKey `chat:<characterId>:<conversationId>`, and asks `client.hasSession` before assembling the prompt: on true it sends a minimal resume remainder (the new author message only, via a new unit-tested buildChatResumeRemainder); on false it sends the full transcript remainder exactly as today. The em-dash retry call re-checks hasSession after the first attempt, so on a session transport the correction instruction is sent alone into the same session rather than re-sending the transcript.
- The MCP character_chat tool is unchanged: it is a stateless single-turn contract whose callers pass the transcript each call, and that stays true (recorded as a decision).

Testing: the automated loop stays fixture-only and every existing test must pass unchanged (the fixture client has no hasSession, so route behavior under fixtures is byte-identical). New units: buildCliArgs three-way variants (default unchanged, persistSession, resume without system), parseCliResult and the stream result path capturing session_id, SessionStore store/hit/eviction, buildChatResumeRemainder format. Real-transport verification is manual, per A7: a multi-turn chat driven with one conversationId must show cache_read_tokens > 0 on turns after the first in llm_calls, per-turn input cost that does not grow with transcript length, and no regression in the 12-turn no-death check.

### A11 (2026-07-17): Universal search and command palette

Purpose: instant recall across the whole project. The recurring question while writing Book 2 against Book 1's canon is "where did I establish this": a fact, a phrase in a locked chapter, what a character knew by chapter 4. Today that means paging through lists. This amendment adds local full-text search over everything the tool stores, surfaced three ways: a keyboard command palette in the web UI, a GET /api/search route, and a `search` MCP tool. No LLM calls anywhere in this feature; it is SQLite FTS5, instant and free.

Indexed corpus, one row per source row:
- Chapters: title plus a body of pov, synopsis, summary, beats, and the LATEST version of the chapter's draft prose (older versions are not searchable; superseded text must not produce hits).
- Canon facts: content, with type and status carried as metadata. Retired facts stay indexed but are excluded from results by default (an includeRetired option includes them).
- Characters: name plus role, voice_rules, physical, notes.
- Character states: the owning character's name as title plus knows, feels, hiding. A hit carries the owning character id and the 1-based chapter the state is effective from.

Index mechanics: an FTS5 virtual table (search_index) with unindexed kind / ref_id / project_id / meta columns and indexed title / body columns, tokenizer unicode61 with diacritics removal. It is kept live by database triggers on chapters, drafts, canon_facts, characters, and character_states (insert, update, delete; a character rename refreshes that character's state rows too), so no code path can write around the index. migrate() additionally rebuilds the whole index idempotently, so existing databases are indexed on first run after upgrade and any drift self-heals at startup. The meta column stores raw database values (0-based order fields); conversion to 1-based chapter numbers happens only at the query layer through the A2 chapterNumbering helpers.

Query semantics, shared by all three surfaces (src/lib/search.ts):
- Any input string is safe. The sanitizer tokenizes on whitespace, strips quotes and FTS operators, quotes every token as a phrase, and marks the final token as a prefix when it has at least two characters, so typing feels like typeahead. FTS syntax (AND, OR, NEAR, parentheses, asterisks) is never interpreted; a query that sanitizes to nothing returns no results. A malformed query must be impossible by construction, never a thrown FTS error.
- Ranking is bm25 with title weighted above body. Each hit carries a snippet with the matched ranges marked (control characters U+0001 and U+0002 at the layer boundary; the palette renders them as highlighted segments, the MCP tool replaces them with **).
- Filters: kinds (any subset of chapter, canon, character, state), projectId scope (keeps series-wide rows, which have no project, visible alongside the book's rows), includeRetired, and a clamped limit (default 20, max 50).

Command palette (web): Ctrl+K or Cmd+K anywhere in the authed UI opens a centered overlay palette; a quiet Search affordance in TopNav (showing the shortcut) opens the same palette. It is not available on /login. Typing searches with a short debounce and a stale-response guard (the CanonManager sequence-guard pattern); results are grouped Chapters / Canon / Characters / Character states, plus a "Go to" group of static navigation commands (Canon, Characters, Books, Settings, Import bible) filtered by the query and shown alone when the query is empty. Arrow keys move the selection across groups, Enter opens the selected result, Esc (or backdrop click, or navigating) closes. Opening a result:
- A chapter hit opens that chapter's draft page.
- A canon hit opens /canon?highlight=<id>; the canon list scrolls to the row and highlights it briefly.
- A character or state hit opens /characters?highlight=<characterId> with the same scroll-and-highlight treatment.
Match highlighting is built from the marker segments as React elements (never raw HTML injection). A9 discipline applies: semantic tokens only, calm styling, visible focus, no new hues.

MCP: a `search` tool over the same query layer (query, kinds, projectId, includeRetired, limit), returning compact JSON hits with 1-based chapter numbers per A2 and ** around matched ranges. It is read-only and does not touch the A6 human-only gate boundary. The A6 tool-surface tests extend to include it.

Non-goals, recorded: no semantic or embedding search (FTS is the right tool for verbatim recall, and this feature must stay instant and free); no persisted search history; projects (the three book titles) are not indexed, the Books page lists them already.

Acceptance check: with a chapter whose latest draft contains a distinctive word, Ctrl+K then typing that word surfaces the chapter and Enter lands on its draft page; overwriting the working draft to drop the word removes the hit (latest-version-only asserted); a retired canon fact is absent from default results and present with includeRetired; a canon hit deep-links to /canon with the target row highlighted; the MCP search tool returns the chapter hit with its 1-based number and ** markers; a query made of FTS operators and stray quotes returns cleanly (results or nothing, never an error); the palette is fully keyboard drivable (open, type, arrows, Enter) under the e2e suite.

### A12 (2026-07-18): Story threads, dropped-thread detection, and the braid view

Purpose: long-form fiction drops threads. A relationship beat (Theo's feelings for Mara) gets set up in chapter 3, complicated in chapter 5, then silently vanishes for nine chapters, and the repair is expensive because it touches locked material. This amendment makes threads first-class, approval-gated data; makes "dropped" a deterministic query instead of a vibe; renders the book as a braid of thread lines where a dropped thread is literally visible; and feeds open threads back into drafting so the model keeps them warm. The LLM appears in exactly one place (lock-time proposals through the existing extraction call); everything else is mechanical, instant, and free.

Data model (idempotent migration, existing patterns):

```sql
CREATE TABLE threads (
  id INTEGER PRIMARY KEY,
  project_id INTEGER REFERENCES projects(id),   -- NULL = series-wide
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('arc','mystery','promise','relationship')),
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','retired')),
  character_a_id INTEGER REFERENCES characters(id),  -- optional, relationship threads
  character_b_id INTEGER REFERENCES characters(id),
  note TEXT,                                    -- author note, e.g. intended payoff
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE thread_touches (
  id INTEGER PRIMARY KEY,
  thread_id INTEGER NOT NULL REFERENCES threads(id),
  chapter_id INTEGER NOT NULL REFERENCES chapters(id),
  kind TEXT NOT NULL CHECK (kind IN ('advance','complicate','payoff','mention')),
  evidence TEXT,                                -- verbatim quote from the chapter
  source TEXT,                                  -- 'manual' | 'extraction:<chapter_id>' | 'mcp'
  created_at TEXT DEFAULT (datetime('now'))
);
```

A payoff touch does NOT auto-resolve its thread: resolving is a human action (the gate discipline). The UI may nudge ("payoff recorded; resolve?") but never decides. Retired threads are kept and excluded from assembly and flags, like retired canon.

Lock-time proposals, through the existing gate: the A1 lock/extraction call (and the Phase 6 importer, which reuses it) gains a threads section in its JSON contract: { ..., "threads": [{ "thread": "name", "isNew": true|false, "type": "arc|mystery|promise|relationship", "kind": "advance|complicate|payoff|mention", "evidence": "verbatim quote" }] }. The prompt lists the book's existing open threads (plus series-wide) by name so the model attaches rather than duplicates; a proposal whose name matches an existing thread case-insensitively is an attach proposal, anything else renders as a new-thread proposal. Proposals appear in the SAME approval checklist as fact and state proposals with the same keyboard shortcuts; approving an attach inserts a thread_touch with source 'extraction:<chapter_id>'; approving a new-thread proposal creates the thread and its first touch atomically. A missing "threads" key in the model reply parses as empty (the fixture and old replies stay valid). Nothing lands unapproved; there is no approve-all.

Dropped-thread detection, purely mechanical (src/lib/threadFlags.ts, unit-tested, no LLM): with STALE_GAP = 4, measured against the book's highest LOCKED chapter order: a thread is STALE when it is open and (max locked order) minus (order of its latest-touched chapter) exceeds STALE_GAP; it is an ORPHAN when it is open with at most one touch ever and the same gap condition holds (orphans display with distinct wording: "introduced and never developed"). A book with no locked chapters flags nothing. Series-wide threads evaluate per book over that book's touches. Resolved and retired threads never flag.

The braid view, /book/[projectId]/threads, linked from the book page: this is the visualization and it must feel like the rest of the tool: calm, typographic, semantic tokens only, both themes, no chart libraries, no new dependencies. An SVG built from a PURE, unit-tested layout function (buildBraidLayout(threads, touches, chapters) returning typed geometry: rows, nodes, segments, co-touch columns) so the component is a dumb renderer and the geometry has tests.

- Chapter columns left to right (1-based labels, clickable to the chapter's draft page), faint vertical rules; unlocked chapters render fainter. Thread rows top to bottom, ordered by first touch; each thread is a continuous line.
- Nodes where a thread touches a chapter, shaped by kind: filled circle advance, ring mention, diamond complicate, larger accent-ringed circle payoff. Node tooltips carry the kind and evidence quote; nodes are keyboard-focusable with the global focus ring and Enter opens the chapter.
- Segments between consecutive touches curve gently (bezier, not straight rules) so the braid reads as woven, not tabular. A segment whose chapter gap exceeds STALE_GAP renders dashed in the warn family: the drop is visible in the line itself. An open thread continues past its last touch to the frontier (latest locked column) as a faint dashed run-out; a resolved thread ends with a terminal tick at its last touch; retired threads render at reduced opacity.
- Where two or more threads touch the SAME chapter, that column gets a soft highlight band and a thin vertical connector joining the co-touched nodes: intersecting and adjoining lines make convergence chapters obvious at a glance.
- Beside the braid: the thread list with type and status, flag chips (stale / orphan, warn family) computed by threadFlags, and per-thread actions: add a manual touch (chapter, kind, evidence), edit name/note, Resolve, Retire. A new-thread form (name, type, optional character pair for relationship). Hovering or focusing a list row highlights its line in accent; the braid and list are two views of one selection.

Prompt assembly: the assembler's stable prefix gains an OPEN THREADS block (with CANON etc., so it caches like the rest): each open thread of the book plus series-wide, as name (type), last touch "ch N, kind: evidence snippet" or "not yet touched", capped at the 12 most recently touched with a "+N more" line when over. Instruction text in the block: keep these threads alive where the chapter's beats allow; do not force every thread into every chapter; never resolve a thread the beats do not resolve. The dev prompt inspector and the MCP assembled_prompt tool show the block for free.

Search (A11 extension): threads join the index as a fifth kind ('thread': name as title; type, status, note, and touch evidence as body; triggers on threads and thread_touches plus the rebuild). Thread hits deep-link to /book/<projectId>/threads?highlight=<id> with the list-row scroll-and-flash treatment; series-wide thread hits link to the first book's view. The palette gains a Threads group; the MCP search tool accepts the new kind.

MCP tools, gate discipline unchanged (no tool approves extraction proposals; those remain absent by construction): threads_list (filters: projectId, status; includes computed flags), thread_get (thread plus touch timeline, 1-based chapter numbers per A2), thread_create, thread_touch_add (1-based chapter in, source 'mcp'), thread_resolve, thread_retire (allowed for the same reason canon_lock is: status changes on standing data are author-equivalent actions, not extraction-approval or chapter-lock gates). All read tools return compact JSON.

Non-goals, recorded: no auto-resolution of threads (human only); no LLM "find all threads" analysis pass over existing chapters (the ledger accumulates going forward; backfill is manual touch entry or re-lock); no per-thread color coding (monochrome lines with accent/warn semantics only, per A9); no tension scoring or graphs beyond the braid; the bible importer does not propose threads in this amendment (bibles have no chapters to touch).

Testing: unit tests for the migration (idempotence), repo round-trips, threadFlags rules (stale, orphan, no-locked-chapters, resolved/retired exemptions, series-wide per-book evaluation), extraction parsing (threads key present, absent, malformed; attach vs new matching case-insensitively), approval endpoints (attach inserts touch, new creates thread plus touch atomically, rejection leaves no trace), assembler block content and cap, buildBraidLayout geometry (rows, node kinds, dashed stale segments, run-out, co-touch columns), search kind, and the MCP tools including the tool-surface list. E2E: create a thread and manual touches through the UI and see its line and nodes; lock a chapter whose fixture extraction proposes one attach and one new thread, approve both via keyboard only, and see the braid update; a stale thread shows its flag chip and dashed segment; Resolve ends the line with a terminal tick; a palette search for the thread name lands on the threads page with the row flashed. Every existing test passes unchanged; fixture extraction replies gain a threads section without disturbing any A1 assertion.

Acceptance check: with a book of six locked chapters where thread "Theo and Mara" is touched in chapters 1, 2, and 3 and thread "The stolen ledger" only in chapter 1: the braid shows two lines with the second's post-chapter-1 segment dashed and flagged (orphan wording), the co-touch column at chapter 1 banded and connected; locking a seventh chapter whose text advances Theo and Mara produces an attach proposal whose approval adds the node and un-flags nothing incorrectly; the OPEN THREADS block of the next chapter's assembled prompt names both threads with their last touches; resolving Theo and Mara removes it from the block and ends its line; the MCP threads_list reports the ledger with 1-based chapters and the orphan flag; all numbers the author sees anywhere are 1-based (A2).

### A13 (2026-07-18): Claude-inspired design language

Purpose: the A9 system is calm but visually reserved; the author wants the UI engaging. This amendment restyles the app in a Claude-inspired design language: warm cream paper, a terracotta accent, serif-forward hierarchy, softened corner radii, and a warm dark mode. The entire A9 token ARCHITECTURE is untouched: same CSS variable names, same Tailwind class vocabulary, same components, same data-testids, same tests. Only token values, the shared radius scale, the favicon, and a small TopNav wordmark change.

- Light palette: warm cream paper, warm near-white surfaces (still not clinical white), bone inset panels, warm near-black ink, and a terracotta accent deep enough that the accent-ink label passes at button sizes. Alert families re-tuned warm but semantically unchanged.
- Dark palette: warm dark gray paper (never pure black), cream ink at full contrast on reading surfaces, reduced-contrast chrome per A9, the same terracotta family adjusted for dark (dark label on coral, lighter hover).
- The A9 decision that the accent is a monochrome inversion (D91) is superseded: terracotta is THE accent, applied exactly where accent tokens already apply (primary buttons, selection and hover highlights, the braid's payoff rings, palette match marks). No other new hues.
- Radius: the shared Tailwind radius scale softens (default 8px, lg 12px) so cards, inputs, overlays, and the braid chrome feel current with zero component markup changes.
- TopNav gains a small wordmark (accent book glyph plus serif "bookforge") linking home; the favicon recolors to match. No layout restructuring, no testid changes.
- ui-shots seeds a couple of threads with touches and captures the threads page, so design review covers the A12 surfaces in both themes.
- Contrast floors: body text and chrome stay comfortably readable in both themes; the focus ring stays blue in both themes so keyboard focus is never confusable with the terracotta selection accent.

Acceptance check: npm run ui-shots captures both themes across login, home, canon, characters, chat, sequencer, draft, review, settings, and threads; primary buttons render terracotta with legible labels in both themes; the braid's payoff nodes and hover selection read in accent; no component file changes beyond TopNav and the layout favicon; the full unit and e2e suites pass unchanged, including the a9-tokens repo check.

### A14 (2026-07-18): Listen and voice notes

Purpose: hands-free review. The author wants the book read aloud while doing other tasks, and wants to speak notes back, without meaningful marginal cost. Both halves already run on the deployment host as local services for another project: a Piper neural TTS HTTP server (POST /speak with a JSON text field returning a WAV; GET /health) and a whisper.cpp server (POST /inference, multipart audio file in, JSON text out). Verified working end to end before this spec was written: Piper synthesized a test sentence and Whisper transcribed it back. This amendment bridges the app to those services. Everything stays on-box (loopback), so the marginal cost is zero.

Configuration: two env vars, TTS_SERVICE_URL and STT_SERVICE_URL (documented in .env.example; on the deployed box they point at the loopback Piper and Whisper ports). When either is unset, its features render nothing and every new route 404s: local dev without the services sees no change at all. The automated test loop NEVER calls the real services: a fixture mode serves a tiny prerecorded WAV for TTS and a canned transcript for STT.

Listen (TTS):
- Unit of synthesis is the paragraph of a chapter's LATEST draft, split by the same paragraph boundaries the reader sees. Audio is cached content-addressed: key = sha256 of the paragraph text (plus voice id), stored under data/audio. Revising a chapter re-synthesizes only changed paragraphs; re-listening is free. A simple size-capped prune (oldest first, default cap 2 GB) keeps the cache bounded.
- When ffmpeg is present on the host, WAV output is transcoded to a compressed format (opus or mp3) before caching, since raw WAV over mobile data is heavy; without ffmpeg, WAV is served as is. Detection happens at startup, logged once, never an error.
- Routes: GET /api/chapters/[id]/audio-manifest (paragraph count, per-paragraph cache state, format) and GET /api/chapters/[id]/audio/[paragraphIndex] (synthesizes on miss, then serves from cache). Both sit behind the session gate like everything else.
- Player: a quiet Listen control on the draft and review surfaces plus a dedicated /listen/[chapterId] page designed phone-first (A15). Sequential paragraph playback with position display ("paragraph 12 of 48"), previous and next paragraph, play and pause, and speed (client-side playbackRate: free). The player prefetches the next paragraph while the current one plays so on-miss synthesis latency hides. Position persists per chapter in localStorage so leaving and returning resumes.

Voice notes (STT):
- A hold-to-record button on the listen page and the review surface (MediaRecorder in the browser, opus or webm). Releasing posts the audio with the chapter id and the paragraph index that was playing (or selected) to POST /api/voice-notes; the server forwards the audio to the STT service and receives the transcript.
- The transcript becomes an INLINE COMMENT on the latest draft through the existing comments machinery: quoted_text anchors to the opening sentence of the target paragraph (the existing quoted-text-is-truth semantics; offsets best effort as ever). The transcript is shown immediately with an inline edit affordance and an undo, because transcription is imperfect; saving is one tap. Nothing about comments' role in revision changes: a voice note IS a comment, and the revision flow consumes it exactly like a typed one.
- No LLM call anywhere in this amendment; STT and TTS are the local services.

Testing: unit tests for the paragraph splitter (stable boundaries, edge cases), cache keying and prune, the manifest shape, transcript-to-comment anchoring, and the fixture services; e2e drives the listen player against fixture audio (play, skip, position persistence) and creates a voice note end to end with the fixture transcript, asserting the resulting comment appears anchored in review. With the env vars unset, e2e asserts the surfaces are absent. All existing tests pass unchanged.

Acceptance check: on the deployed box, a locked chapter plays through paragraph by paragraph with skip and speed working and survives a page reload at position; revising one paragraph re-synthesizes only that paragraph (cache hit behavior unit-asserted, observed manually on the box); holding record, speaking a note, and releasing lands a correctly anchored comment visible on the review page within seconds; a fresh clone with neither env var set shows no trace of any of this.

### A15 (2026-07-18): Mobile-friendly layout

Purpose: the v1 non-goal "no mobile-optimized layout" is superseded by author directive: listening and voice notes (A14) happen away from the desk, and the deployed app is already reachable over HTTPS from a phone. This amendment makes the whole app usable on a phone, not just the listen page, while changing nothing about the desktop experience or the A9/A13 design system.

Scope and rules:
- Responsive, not redesigned: the same pages, components, tokens, and testids, with layout that adapts below a single breakpoint (640px, Tailwind sm). No separate mobile routes (except /listen/[chapterId], which is phone-first per A14), no user-agent sniffing, no new hues, no component library.
- TopNav collapses: below the breakpoint the wordmark, Search, and theme toggle stay; the section links fold into a single disclosure menu with 44px touch targets. The command palette becomes a full-screen sheet below the breakpoint (same component, same testids, same behavior).
- Reading and writing surfaces: prose, editors, and forms go full-width with comfortable padding; the draft textarea and review prose keep a readable measure; buttons and rows hit 44px touch targets; the keyboard-driven approval checklists remain keyboard-first on desktop and gain plain tap targets for approve and reject on mobile (same handlers, no gate change).
- The braid: already inside an overflow-x-auto container; on mobile it stays horizontally swipeable with the thread list stacking above it. No pinch-zoom requirements.
- Viewport metadata is set explicitly in the root layout.
- Hard rule unchanged: every A9/A13 token discipline applies; no raw palette classes; never an em-dash.

Testing: a Playwright mobile project (iPhone-class viewport, 390x844) runs a core-flow subset: login, home, canon list and add, open a chapter, palette open then search then navigate, threads page renders with a swipeable braid, listen page controls. Key pages assert no horizontal body scroll (scrollWidth within viewport width; the braid scrolls inside its own container). The full desktop suite runs unchanged and must stay green.

Acceptance check: on a real phone against the deployed app: log in, find a chapter via the palette, read it, play it, speak a note, and see the comment in review, all without pinch-zooming or horizontal body scrolling; on desktop, screenshots before and after this amendment are visually identical except where a window is actually narrow.

### A16 (2026-07-18): Multiple series, and creating books

Purpose: the data model assumed exactly one series. The author wants to start books that do NOT share the trilogy's world: today series-wide canon (project_id NULL) injects into every book's prompts, the character roster is global, and there is no way to create a book at all (the three were seeded). This amendment introduces series as a first-class entity, scopes everything that was implicitly series-wide, and adds calm creation flows for both series and books. The approval gates, drafting, revision, sweep, threads, listen, and search behaviors do not change; they gain a boundary.

Data model (idempotent migration, existing patterns):
- New table `series`: id, title TEXT NOT NULL, order_index INTEGER NOT NULL, created_at.
- `projects` gains `series_id` (guarded ALTER, NOT NULL semantics enforced in code); `canon_facts`, `characters`, and `threads` gain `series_id` the same way. `project_id NULL` on canon and threads now means "series-wide WITHIN that fact's series", never global.
- Migration backfill: create one series titled "The Trilogy" (title editable) and assign every existing project, canon fact, character, and thread to it. After migration, an existing chapter's assembled prompt must be byte-identical to before the migration (this is the load-bearing acceptance check: the trilogy must not notice A16 happened).
- Seed style rules: on CREATING a new series, the five seed style rules are COPIED into it as locked series-wide style_rule facts (source 'seed'), so every series starts with the author's standing style contract but can retire or edit its copy independently. The em-dash rule is repo law regardless.

Scoping sweep (mechanical, complete):
- Assembler, interrogation, sweep, chat context, bible importer, and extraction open-thread listing: every query that read "project X plus series-wide (project_id NULL)" now reads "project X plus series-wide within X's series". Characters available to a book (appearing-character matching, chat, state timelines, extraction character mapping) are the book's series' characters only.
- Search: search_index rows gain a series id (unindexed column, populated by the triggers and rebuild). Default palette search stays global across all series (finding things is the point); the existing projectId scope narrows as today; the API and MCP search gain an optional seriesId filter.
- Threads: the braid and threads APIs already take a projectId; series-wide threads belong to the book's series. The A12 rule that a series-wide thread hit deep-links to "the first book" becomes "the first book of ITS series".
- Character pages: /characters lists by series with a series switcher (calm select, defaulting to the first series); character creation requires a series.

Creation and renaming UI:
- The home Books page groups books under series headings. Each series heading carries a quiet rename affordance; under each series a "New book" form (title only) appends a book to that series; at the bottom a "New series" form (title only) creates the series, copies the seed style rules, and creates its first book with a default title (editable), so the author lands ready to write.
- Book titles become renameable from the home page (quiet affordance, same pattern).
- Routes: POST /api/series, PATCH /api/series/[id] (title), POST /api/projects (title, seriesId), PATCH /api/projects/[id] (title). Simple validation in the canon route style.

MCP (gate discipline unchanged): series_list, series_create, book_create (title plus seriesId), book_rename. canon_add and thread_create gain optional seriesId: required when projectId is omitted (a series-wide item must name its series), inferred from the project otherwise; omitting both is an error naming the fix. characters tools gain the series scope where they list or create. All tool-surface tests extend.

Non-goals, recorded: no deleting or archiving of books or series (rename only; removal stays a manual database operation); no cross-series character sharing or moving (create the character in the other series); no per-series theming or settings; the settings page and model routing stay global.

Testing: unit tests for the migration backfill (existing rows all land in series 1; running twice is a no-op), the byte-identical-prompt acceptance (assemble a chapter's prompt before and after migrate on a seeded fixture DB), every scoping seam (assembler, chat context, sweep, bible, extraction open-threads, characters listing, search triggers and filter, thread deep-link), creation routes, and the MCP tools including the seriesId rules. E2E: create a new series and a book in it through the UI; add a canon fact and a character to the new series; assert the new book's assembled prompt (dev inspector) contains none of the trilogy's series-wide canon or characters and DOES contain its own; assert the trilogy's own prompt is unchanged; palette finds content from both series; rename a series and a book and see both stick. The full existing suite passes unchanged.

Acceptance check: on a database carrying the trilogy, migration files everything under one editable series and an existing chapter's assembled prompt is byte-identical; creating "New Series" plus its first book yields a book whose prompt contains the copied style rules, no trilogy world canon, and no trilogy characters; a character created in the new series never appears in trilogy surfaces; series-wide facts and threads stay inside their series everywhere (assembler, chat, sweep, braid, search scope filter); the author can do all of this from the home page without touching the database.

### A17 (2026-07-19): Thread backfill scan

Purpose: A12 auto-proposes threads only at lock time, so chapters locked before A12 (the entire trilogy) have an empty ledger that only manual entry fills. Author directive: threads should auto-populate from book contents. This amendment supersedes the A12 non-goal against an analysis pass over existing chapters, with the same discipline as everything else: the scan PROPOSES, the author approves, nothing lands otherwise.

The scan, on the threads page:
- A "Scan for threads" flow: pick a 1-based chapter range (default: every LOCKED chapter of the book that has no thread touches yet; unlocked chapters are never scanned, locked text is the settled record). The UI warns about cost the way the sweep does (one model call per chapter) and shows the same per-chapter progress; a per-chapter LLM or parse failure appears in the result naming the chapter and reason (A2.2 discipline) while the rest of the run continues.
- One call per chapter, sequential, purpose 'extraction' under the existing A8 model routing (no new purpose). The prompt carries the chapter's locked text and summary, the book's existing open threads (attach targets), and the names already proposed EARLIER IN THIS RUN, so chapter 7's "Theo and Mara" lands on the same proposed thread as chapter 2's rather than duplicating. The reply contract is exactly the A12 threads section ({ "threads": [{ "thread", "isNew", "type", "kind", "evidence" }] }); parsing and normalization REUSE the A12 code (normalizeThreadProposals), extended only for the within-run name linkage.
- Results merge into ONE approval checklist (the bible importer's chunks-merge pattern), grouped by thread: a proposed NEW thread shows its name, type, and every touch the run found for it (chapter, kind, evidence quote); an ATTACH group shows the existing thread's name and its proposed touches. The same keyboard shortcuts as every other checklist, plus the A15 tap targets. Individual touches are check-off-able within a group.
- Approval persists atomically per the A12 rules: approved new threads are created with their approved touches; approved attaches insert touches; source is 'scan:<chapter_id>' per touch so provenance is distinguishable from lock-time 'extraction:<chapter_id>'. Rejection leaves no trace. Nothing auto-resolves; flags recompute on the next load and the braid simply fills in.
- The threads page's empty state becomes the invitation: when a book has locked chapters and zero threads, it says so and offers the scan.

Boundaries: web UI only (no MCP scan tool: proposals are ephemeral until approved and MCP must not approve; recorded as a non-goal); locked chapters only; a chapter may be rescanned by explicit range selection (the default range skips chapters that already have touches, nothing forbids revisiting); series scoping per A16 throughout.

Testing: unit tests for the default-range rule (locked, touchless), within-run name linkage across sequential chapters (case-insensitive), attach-to-existing preference over new, per-chapter error carry-through with the run continuing, atomic approval and no-trace rejection, and source stamping; fixture-driven scan route tests (the lock-time extraction fixture pattern, per-chapter fixtureKey). E2E: a book with two locked chapters (fixture replies proposing one shared thread across both chapters plus one attach to a pre-created thread), run the scan from the threads page, approve via keyboard, see the braid populate with the shared thread's two touches and the attach; a planted per-chapter failure surfaces its reason while the other chapter's proposals still arrive. The full existing suite passes unchanged.

Acceptance check: on a book whose chapters were all locked before A12, the threads page offers the scan; running it over all chapters and approving a subset yields a braid whose lines and touches match the approved subset exactly, with source 'scan:<chapter_id>' on every touch; running the default scan again proposes nothing for chapters that now have touches; a rejected run leaves the database untouched; the trilogy's canon, characters, and chapters are unmodified by any scan.

### A18 (2026-07-19): Sweep restructured to one model call per request

Purpose: the consistency sweep still runs every chapter's model call inside a single HTTP request, the exact shape whose production failure D158 documents for the thread scan (chapter-sized prompts run minutes per call on the claude-code transport; the request outlives the serving chain and dies as a 502 partway through, discarding completed work). The sweep gets the same restructuring the scan received, with the same guarantee: no HTTP request spans more than one model call.

Shape, mirroring the scan fix exactly:
- The existing sweep endpoint becomes the PLAN call (no LLM): it validates the 1-based range and returns the ordered locked-chapter targets.
- A new per-chapter endpoint runs ONE chapter's sweep call and returns that chapter's report entry. Whatever shared context the sweep prompt carries (the locked-canon prefix per A4.1) is rebuilt per request; the prompt bytes must be identical to the current implementation's so provider-side prompt caching keeps working across the run and every existing prompt-construction test holds.
- SweepRunner drives the loop client-side: real progress naming the chapter under sweep, per-chapter failures carried as report entries with their reasons (A2.2) while the loop continues, and the aggregated report assembled as chapters complete. The finished report is identical in shape and content to the current one: same testids, same per-chapter entries, same contradiction rendering, so the existing sweep e2e (the phase5 planted-contradiction scenario and the A2.2 error surfacing) passes against the new flow, adjusted only where a spec asserted transport mechanics rather than outcomes.
- Per-position fixture routing is preserved (base key plus 1-based position in the swept set), so the existing sweep fixtures drive the new flow unchanged.
- The MCP sweep_book tool is untouched: it calls runSweep in-process over stdio with no HTTP hop, so the failure mode does not exist there. runSweep itself remains the shared, unit-tested engine; the per-chapter endpoint calls its extracted single-chapter step exactly as runScan delegates to scanChapter.

Testing: the sweep unit suite keeps passing against the shared engine; new unit coverage for the extracted single-chapter step and the plan endpoint; the full e2e suite green under the established protocol. Acceptance: on the deployed trilogy, a full-book sweep completes chapter by chapter with live progress and no 502, a planted mid-run failure loses only its own chapter, and the aggregated report matches what the single-request design would have produced for the same inputs.

### A19 (2026-07-20): Better voices, same contracts

Purpose: the listen voice (Piper en_US-amy-medium) is audibly synthetic against the current free state of the art, and the voice-note transcriber runs whisper base.en, one of the smallest models in its family (the source of "Sol" and "falls her arms" in the author's first real note). Both halves upgrade to the best free CPU-viable models available, WITHOUT changing bookforge's service contracts: the app already speaks POST /speak (JSON text in, WAV out) and POST /inference (multipart audio in, JSON text out) behind two env vars, so the upgrade is new services on the deployment host plus an env flip, gated by a measured benchmark.

TTS: Kokoro-82M (Apache 2.0) via kokoro-onnx, served by a small adapter checked into this repo (scripts/kokoro-speak-server.py): GET /health and POST /speak with the exact Piper server contract, voice selectable by env (default af_heart), port 3110, supervised like the app (pm2). The AUDIO_VOICE_ID env changes alongside the flip (the content-addressed audio cache keys on voice id, so old Piper audio simply ages out of the cap and every chapter re-synthesizes in the new voice on next listen).

Benchmark gate, before any flip: synthesize three representative Chapter One paragraphs (a long narration, a mid-length one, a short dialogue line) on the host and compute the realtime factor (synthesis seconds divided by audio seconds). Median at or below 1.0: flip. Between 1.0 and 1.5: do not flip; report to the author with the numbers (the warm-ahead pipeline tolerates it, but that is the author's tradeoff to take). Above 1.5: do not flip, report. The report also includes a listening sample path so the author can hear the voice either way.

STT: a second whisper.cpp server instance (the same binary already on the host) with ggml-large-v3-turbo quantized (q5 class), port 3111, pm2-supervised, leaving the existing autogeny base.en instance untouched. No gate needed beyond a functional round-trip: turbo's accuracy dominates base.en categorically and a voice note is seconds of audio, so latency stays interactive on the host's four cores.

Bookforge changes are deliberately tiny: the adapter script, DEPLOY.md documenting the two services and the rollback (flip the two env vars back and restart; nothing else changes), and .env.example noting AUDIO_VOICE_ID's role in cache keying. No app code, no schema, no test contract changes; the existing fixture-driven suites are untouched by construction.

Acceptance check: on the deployment host, the benchmark report exists with the three realtime factors and the decision applied; with the flip in place, the listen page plays Chapter One in the Kokoro voice end to end with the warm-ahead pipeline keeping pace (no visible synthesizing stall on a normal listen after the first paragraphs); a voice note spoken against a paragraph round-trips through the turbo instance into a correctly anchored comment with visibly better transcription than base.en on the same audio (compare both instances on one recording, in the report); reverting the env vars restores the Piper/base.en behavior with no other action; the autogeny services are byte-identically configured before and after.

### A20 (2026-07-21): Bible import, one model call per request

Purpose: the series-bible importer runs every chunk's model call inside a single HTTP request (runBibleImport loops chunkBible over one POST /api/bible/import), the same shape whose production failure D158 (scan) and A18 (sweep) document. It surfaced for real: importing a 130,000 character bible died with a 500, and even a single 24,000 character chunk took 418 seconds on the claude-code transport (the bible model call generates 12,000 to 15,000 output tokens, and that transport does not enforce maxTokens, so one chunk alone runs about seven minutes). A whole bible is six such calls in one request; it cannot survive. This amendment applies the A17/A18 restructuring to the bible importer, so no HTTP request spans more than one model call, and sizes chunks so each request completes comfortably.

Diagnosis first (the implementer reproduces before restructuring): confirm the exact failure of a single ~24k chunk request against the running app (Next route timeout, response handling, or the transport), and record it. The restructuring must make each per-chunk request reliably succeed; if a single ~24k chunk request is itself too long or too large, the default chunk size drops (chunkBible / DEFAULT_BIBLE_CHUNK_CHARS) until one chunk request is comfortably fast, and the new size is justified from the measured single-chunk time. Smaller input chunks also yield smaller per-chunk output, shortening each call.

Shape, mirroring the scan and sweep fixes exactly:
- POST /api/bible/import becomes the PLAN call (no model call): it validates the text and scope, splits with chunkBible, and returns the chunk count and the chunk texts (or ids the per-chunk call can re-derive deterministically). It must stay backward compatible enough that the fixture-driven a3 e2e still drives an import, or that e2e is updated to the new flow asserting the same OUTCOMES.
- A new per-chunk endpoint runs ONE chunk (one model call, purpose bible, logged) and returns that chunk's proposals and any parse failure. The shared dedup context (current locked canon plus roster, series-scoped per A16) is rebuilt per request.
- BibleImportPanel drives the loop client-side: one request per chunk, live progress naming the chunk, per-chunk parse failures carried into the existing raw-text surface (A2.2) while the loop continues, proposals merged into the one approval checklist exactly as today. The keyboard-and-tap approval and the gated POST /api/bible/approve are unchanged: nothing lands unapproved.
- runBibleImport keeps working as the shared engine (extract the single-chunk step, as runScan delegates to scanChapter and runSweep to sweepChapter), so its unit tests and the fixture path stay valid.
- Per-position fixture routing is preserved so the existing bible fixtures drive the new flow.

Testing: unit coverage for the extracted single-chunk step and the plan endpoint; the a3 e2e stays green (adjusted only where it asserted the single-request transport rather than the import outcome); the full suite green under the load-flake protocol. Acceptance: on the deployed app, a large real bible imports chunk by chunk with live progress and no 500, a planted per-chunk parse failure surfaces its raw text while the other chunks still propose, the merged checklist and gated approval are unchanged, and the MCP surface is untouched (there is no bible MCP tool).

### A21 (2026-07-21): Interpret markdown emphasis (render it, do not speak it)

Purpose: the imported manuscript uses markdown emphasis (single-asterisk italics like `*in*`, double-asterisk bold like `**word**`; chapter one alone has 12 italic spans). Bookforge treats prose as plain text, so the review surface shows the literal asterisks and the TTS voices them ("star in star"). Emphasis must be interpreted: rendered as italic/bold on the reading surface, and stripped from the audio, without disturbing the comment-anchoring or revision machinery.

Design principle, non-negotiable: emphasis is a DISPLAY concern only. The stored draft content stays raw markdown (the source of truth, what the draft editor edits and what export emits). Every offset the app computes, comment quotedText and spans, revision findSpan span location, voice-note paragraph anchoring, stays on the RAW content exactly as today. Only two things change: how the review surface RENDERS the raw content, and what text the TTS bridge is HANDED.

The emphasis parser (src/lib/markdown or similar, pure and unit-tested):
- `parseEmphasis(text)` returns an ordered list of segments, each `{ text, kind: "plain" | "italic" | "bold", rawStart }`, where `text` is the segment's VISIBLE text (markers removed) and `rawStart` is the offset in the RAW input of that visible text's first character (past any leading marker). Concatenating the segments' visible text yields `stripEmphasis(text)`; the segments tile the input in order. Bold is `**...**`, italic is `*...*` (also accept `_..._` for italic and `__...__` for bold). A marker with no matching close, an asterisk with a space after the open or before the close, or a lone asterisk, is LITERAL text (standard markdown restraint), never a broken segment; apostrophes and hyphens are untouched. Nesting is not required (bold-inside-italic may render as the outer only); the parser must never throw and must never drop or reorder characters of the visible text.
- `stripEmphasis(text)` returns the visible text (markers removed), derived from the same segmentation so it can never disagree with the renderer.

Review rendering (ReviewEditor `review-prose`):
- Render the raw content as the parsed segments: plain segments as text, italic as `<em>`, bold as `<strong>`, inside the existing `whitespace-pre-wrap` serif container. No `dangerouslySetInnerHTML`. Every segment is wrapped in a `<span data-raw-start={rawStart}>` carrying its raw offset.
- Selection to raw offset: the existing selectionchange handler must map a DOM selection back to RAW content offsets through the segment spans. For an endpoint, find the enclosing `[data-raw-start]` span and add the offset within its text node to `data-raw-start`; within a segment the visible text is contiguous in the raw content, so this is exact. `quotedText = content.slice(lo, hi)` stays byte-identical to today's behavior (a selection inside an emphasized word yields the plain word; a selection spanning a marker yields the raw substring including the marker). Comment save, revision, and highlight are therefore unchanged.
- The pending-selection preview and any existing-comment highlight render through the same parser so the asterisks never appear as literal text on the review surface.

TTS (audio path):
- The per-paragraph audio route and the manifest keep splitting the RAW content (paragraph indices and voice-note anchoring are unchanged), but the text handed to the synthesizer and used for the cache key is `stripEmphasis(paragraph)`. Changing the keyed text re-keys the content-addressed cache, so paragraphs re-synthesize once without their markers and old marker-bearing audio ages out. Apply the strip in exactly one place so the cache key and the synthesized text can never diverge.

Out of scope, stated: the draft editor stays a raw-markdown textarea (authors edit the source); export stays raw markdown (it is a markdown file); character chat and other surfaces are unchanged. No new dependencies (no markdown library); the parser is a small hand-rolled function for emphasis only.

Testing: unit tests for parseEmphasis (italic, bold, both underscore forms, multiple spans in a paragraph, unmatched and literal asterisks left as text, apostrophes and hyphens untouched, segment offsets tile the raw input) and stripEmphasis (agrees with the segmentation). E2e: a chapter whose draft contains `*italic*` and `**bold**` renders `<em>`/`<strong>` on the review surface with NO literal asterisk in the review-prose text; selecting an emphasized word and adding a comment anchors it correctly (quotedText matches and the comment appears); a revision over a flagged span in a draft that also contains emphasis elsewhere still applies (the raw-offset invariant); the audio manifest and a served paragraph for emphasized text contain no asterisks (assert on stripEmphasis of the paragraph). The existing phase4/phase5 revision and comment e2e stay green unchanged.

Acceptance check: on the deployed app, chapter one's `"You're *in* it,"` reads on the review surface as "You're " then an italic "in" then " it," with no visible asterisks; pressing Listen voices "You're in it" with no spoken markers; selecting and commenting on a word still works; a revision still applies; the draft editor and the Markdown export still show the raw asterisks.

