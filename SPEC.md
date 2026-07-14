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
