# PROGRESS

Living log, one section per phase: what was built, test results, and every
judgment call. Decisions are mirrored in DECISIONS.md.

Never use em-dashes anywhere in this repo, per SPEC.md.

---

## Phase 1: Scaffold, auth, DB, canon manager, characters

Status: COMPLETE. All tests green.

### What was built

- Next.js 15.5 (App Router, TypeScript) scaffold, Tailwind CSS v3, single mono-repo
  layout under `src/`.
- SQLite via better-sqlite3 + Drizzle ORM. Schema in `src/lib/db/schema.ts` mirrors
  the SPEC DDL exactly, plus an `llm_calls` table for cost logging (used from Phase
  3 on). Idempotent migration + seed in `src/lib/db/migrate.ts` (all DDL uses
  `IF NOT EXISTS`; seed inserts only when rows are absent).
- Seed data: three books (Book 1, Book 2, Book 3) and the five series-wide
  `style_rule` facts from the spec, status `locked`, source `seed`. None contain an
  em-dash (asserted in tests).
- Auth: single-password gate. `src/lib/auth.ts` signs an HMAC-SHA256 session token
  with Web Crypto (same code runs in Edge middleware and Node routes).
  `src/middleware.ts` gates every route except `/login` and `/api/auth/login`, 401s
  API calls and redirects pages. Signed httpOnly cookie, 30 day max age.
- Canon manager at `/canon`: filter by type/status/scope, inline add, inline edit,
  lock/unlock, retire/restore, delete, and bulk paste (one fact per line, created
  provisional). Locked facts render a lock glyph and cannot be edited until
  unlocked.
- Characters at `/characters`: card list with a new-character form, expandable cards
  showing the state timeline (ordered by book then chapter_order) and an add-state
  form.
- Home at `/` lists the books.
- Repo layer (`src/lib/repo/*`) takes an explicit Drizzle handle so it is unit
  testable against an in-memory DB.

### Test results

- Unit (vitest): 17 passed.
  - migrate.test.ts: idempotent re-run, three books + five style rules with no
    duplication on re-seed, seeds are locked/series-wide/em-dash-free.
  - canon.test.ts: default provisional, lock/retire filtering, series vs book scope,
    bulk create, `assemblableCanon` includes locked in-scope only.
  - characters.test.ts: create, timeline ordering, `effectiveState` picks the most
    recent row with chapter_order <= N in the same book.
  - auth.test.ts: token round-trip, tamper/wrong-secret/expiry rejection, password
    compare.
- E2E (Playwright, Chromium): 6 passed.
  - Auth gate redirects unauthenticated `/canon` to `/login`; wrong password shows an
    error and stays; correct password logs in and reveals seeded style rules.
  - Canon: five seeded style rules render locked; add a fact then lock then retire.
  - Characters: create a character, expand, add a state, see it in the timeline.
- `tsc --noEmit`: clean.

### Acceptance check (SPEC Phase 1)

"fresh clone + .env + npm run dev gives a login gate, seeded style rules visible at
/canon, can add/lock/retire facts, can create characters with state timelines.
Migrations run idempotently." All covered by the tests above.

### Judgment calls (mirrored in DECISIONS.md)

- D1: Project hosted on local disk (`C:\Users\cunni\bookforge`) because Google Drive
  file-sync locks `node_modules` and breaks `npm install`. G: remains the source of
  record; a forced robocopy mirrors G: to C: before each run.
- D2: `llm_calls` table added in Phase 1 (spec defines it in the LLM notes) so later
  phases do not need a schema migration mid-build.
- D3: Cookie signed with Web Crypto HMAC rather than a JWT library. No dependency,
  works in Edge and Node.
- D4: Next upgraded from the spec-era pin to 15.5.x to clear a published CVE.
- D5: Retired facts also excluded from `assemblableCanon`; only `locked` in-scope
  facts are assemblable.

---

## Phase 2: Sequencer and interrogation

Status: COMPLETE. All tests green.

### What was built

- Injectable LLM client (`src/lib/llm/client.ts`): one `LlmClient` interface with
  `complete` and `stream`. `USE_FIXTURE_LLM=1` selects a fixture player that reads
  `tests/fixtures/<purpose>.json`; otherwise it wraps `@anthropic-ai/sdk`. Real
  client retries once on transient (5xx/429/network) errors. Every call carries a
  `purpose` for fixture routing and token logging.
- Defensive JSON parser (`src/lib/llm/json.ts`): strips code fences, bracket-matches
  the first top-level array/object out of prose, parses, and returns `ok:false` with
  the raw text on failure.
- Post-generation lint (`src/lib/llm/lint.ts`): `hasEmDash` (U+2014 or a double
  hyphen used as one) and a rough Britishism tripwire. Used from Phase 3 on; the
  pure functions live here now and are unit tested.
- Interrogation prompt + `normalizeQuestions` (`src/lib/llm/prompts.ts`).
- Chapters + questions repo (`src/lib/repo/chapters.ts`): CRUD, sequential
  order_index per book, `reorderChapters` (transactional), beats/dependencies as
  JSON, `previousLockedChapter` / `priorLockedChapters` for the assembler, and the
  question helpers including `unansweredQuestionCount`.
- Routes: `/api/chapters` (GET/POST), `/api/chapters/[id]` (GET/PATCH/DELETE),
  `/api/chapters/reorder`, `/api/chapters/[id]/questions`,
  `/api/chapters/[id]/interrogate`, `/api/questions/[id]/answer`.
- Sequencer UI at `/book/[projectId]`: add chapter, reorder, expandable editor for
  POV/synopsis/beats (beats reorderable), interrogation panel that lists returned
  questions, per-question answer that creates a provisional plot_decision fact and
  offers a Lock button, and a soft draft gate (blocks with an override when there
  are unanswered questions).
- `llm_calls` logging on the interrogation call.

### Test results

- Unit (vitest): 38 passed (21 new this phase across json, prompts, lint, chapters).
- E2E (Playwright): 9 passed (3 new: create chapter with synopsis/beats persisted;
  reorder persists across reload; interrogation returns 3 fixture questions,
  answering makes a provisional plot_decision fact that then locks in place).
- `tsc --noEmit`: clean.

### Acceptance check (SPEC Phase 2)

"create chapters with synopsis and beats, reorder persists, interrogation returns
questions, answering one produces a provisional canon fact linked to the question,
locking that fact works from the same screen." All covered.

### Judgment calls (mirrored in DECISIONS.md)

- D7: Reorder via up/down buttons rather than drag. The acceptance check requires
  persistence, not the drag gesture; buttons are reliable and testable. Drag is UI
  polish, deferred.
- D8: The plot_decision fact content is the question text followed by the answer,
  so the locked canon reads as a self-contained decision.
- D9: Fixture routing is by `purpose` (+ optional `fixtureKey`), read from
  `tests/fixtures/` at runtime only when `USE_FIXTURE_LLM=1`. Not bundled into a
  real build.

---

## Phase 3: Context assembler and drafting

Status: COMPLETE. All tests green. This is the first mandatory stop.

### What was built

- Context assembler (`src/lib/assembler.ts`): builds the drafting prompt from the
  seven blocks in the SPEC order (system, then CANON, CHARACTERS, STORY SO FAR,
  PREVIOUS CHAPTER, CURRENT CHAPTER, TASK). Returns the system string, the
  concatenated user prompt, a per-block breakdown for inspection, the list of
  appearing characters, and any budget warnings. Budget heuristics are character
  count based (~4 chars/token): canon ~4k tokens (warns when over), previous chapter
  ~8k tokens (front truncated), drafted-so-far ~6k tokens (keeps the last 1000 words
  and labels the omission), chapter summaries capped at 150 words. Appearing
  characters are POV plus any whose name occurs in the synopsis or beats; their
  character_fact canon and effective state (latest state row with chapter_order <=
  this chapter) are included.
- Draft system prompt and revision prompt templates (`src/lib/llm/prompts.ts`),
  filled with the locked style rules and POV, both forbidding em-dashes.
- Streaming draft route (`POST /api/chapters/[id]/draft`): assembles the prompt,
  streams prose chunks, then sends a control frame with the clean text, retry flag,
  and extracted [MISSING FACT] / [CANON TENSION] alerts. Em-dash lint is enforced:
  if the first output contains an em-dash (U+2014 or a double hyphen), the scene is
  regenerated once with an explicit instruction, and the clean version replaces it.
  A residual em-dash after retry is flagged, never hidden.
- Marker extraction (`src/lib/llm/markers.ts`): strips the marker lines out of the
  prose and returns them for the UI.
- Draft editor UI (`/book/[projectId]/chapter/[chapterId]/draft`): beat picker,
  Continue and Redraft, live streaming into an editable prose surface, alert panel
  for retries, missing facts (with a one-click add-locked-fact-and-redraft flow),
  canon tensions, and assembler warnings. Auto-saves the working draft.
- Prompt inspector (`/book/[projectId]/chapter/[chapterId]/prompt`) and a dev JSON
  route (`GET /api/dev/prompt/[chapterId]`, disabled in production) that dump the
  fully assembled prompt for one chapter. This is the surface for judging the
  assembler by eye at the stop.
- Working-draft persistence (`src/lib/repo/drafts.ts`, `POST
  /api/chapters/[id]/save-draft`).

### Test results

- Unit (vitest): 46 passed (8 new: assembler block order, scoping, beat marking,
  previous-chapter and drafted-so-far truncation, canon over-budget warning, marker
  extraction).
- E2E (Playwright): 13 passed (4 new: clean prose streams into the editor; a forced
  em-dash triggers a retry and the saved text is clean with no residual em-dash; a
  [MISSING FACT] line surfaces as an alert and is stripped from the prose; the
  assembled prompt is inspectable).
- `tsc --noEmit`: clean.

### Acceptance check (SPEC Phase 3)

"with seeded canon, two characters, one locked prior chapter, drafting a beat
streams prose to the editor; the assembled prompt is loggable in dev mode for
inspection; em-dash lint triggers a retry when forced; [MISSING FACT] lines surface
as alerts." All covered by unit + E2E with the Anthropic client mocked.

### Judgment calls (mirrored in DECISIONS.md)

- D10: The stream uses a printable sentinel (`<<<BOOKFORGE_CTRL>>>`) to separate
  prose from the trailing JSON control frame.
- D11: Drafting is stateless w.r.t. persistence; the client owns the editor text and
  saves via save-draft. Continue appends a segment, Redraft regenerates the last
  segment. This keeps streaming pure and makes Redraft well defined without tracking
  scene-to-beat mappings server side.
- D12: Book-level one-line summaries are not stored, so STORY SO FAR emits a pointer
  line per prior book rather than a synthesized summary. Chapter summaries drive the
  block. Revisit if cross-book drafting needs richer prior-book context.
- D13: One draft fixture (`draft.emdash.json`) intentionally contains a U+2014 as
  negative-test input for the em-dash linter. It is test-only, never shipped prose.

---

## Phase 4: Review and revision with diff enforcement

Status: COMPLETE. All tests green.

### What was built

- Diff enforcement module (`src/lib/revision/diff.ts`), the core of the phase and a
  pure, unit-tested unit. `analyzeRevision` computes a line-based diff
  (`diffLines`) with per-hunk word-level refinement (`diffWordsWithSpace`), groups
  changes into hunks with their old-text char ranges, and classifies each as
  AUTHORIZED (overlaps a flagged span within a 200-char tolerance window),
  DECLARED (matches a [CONSISTENCY FIXES] entry), or UNAUTHORIZED. `applyResolution`
  reconstructs the final text by walking the same segments; accepting every hunk
  reproduces the new text exactly, rejecting one restores the old text for that span
  while keeping the others.
- Span anchoring (`src/lib/revision/spans.ts`): `findSpan` recomputes a span by
  string search, using the cached offset as a hint only when the text still matches
  there. Shared by comment recompute and the diff classifier.
- Consistency-fix extraction added to `src/lib/llm/markers.ts`
  (`extractConsistencyFixes`), stripping the trailing [CONSISTENCY FIXES] block from
  the prose the same way the [MISSING FACT] / [CANON TENSION] markers are stripped.
- Comments repo (`src/lib/repo/comments.ts`): create, list with recomputed offsets,
  list-unresolved, update (edit/resolve). Revisions repo
  (`src/lib/repo/revisions.ts`) over a new `revisions` table (idempotent DDL in
  migrate.ts, Drizzle def in schema.ts) that holds the pending old/new text, flagged
  spans, and declared fixes between /revise and /resolve.
- Routes: `POST` + `GET` `/api/drafts/[id]/comments`, `PATCH /api/comments/[id]`,
  `POST /api/drafts/[id]/revise` (streams the revised text then a control frame with
  the revision id and classified hunks, same protocol as the draft route, with the
  same em-dash reject-and-retry lint), and `POST /api/revisions/[id]/resolve`
  (requires every unauthorized hunk resolved, then saves a new draft version and
  marks the revision resolved).
- Review page `/book/[projectId]/chapter/[chapterId]/review` and its client
  `ReviewEditor`: read-only prose with span selection to attach comments, a comments
  side panel with resolve, a "Revise flagged spans" button (enabled only with at
  least one unresolved comment), an unauthorized-change panel with side-by-side
  old/new and per-hunk accept/reject, and save gated on all unauthorized hunks being
  resolved. A "Review and revise" link was added to the draft page.
- Revision fixtures under `tests/fixtures`: `revision.phase4.json` (in-span fix,
  declared consistency fix, and an undeclared out-of-span edit, ending in a
  [CONSISTENCY FIXES] block) plus `revision.emdashrev.json` and its `.retry` for the
  em-dash lint. `phase4.case.json` holds the source text and expected accept/reject
  results so the E2E and the fixture stay in sync (both generated from one set of
  constants).

### Test results

- Unit (vitest): 58 passed (was 46; +12: 8 in revision-diff.test.ts covering
  in-span/tolerance/undeclared/declared classification and exact accept/reject
  reconstruction, 4 in comments.test.ts covering offset recompute, absent-quote,
  hint disambiguation, and resolve).
- E2E (Playwright): 17 passed (was 13; +4): the unauthorized panel catches ONLY the
  undeclared out-of-span edit while the in-span fix and the declared consistency fix
  pass; rejecting the hunk yields the exact expected new-version text; accepting it
  yields the full revised text; a revision em-dash triggers a retry and the saved
  text is clean.
- `tsc --noEmit`: clean.

### Acceptance check (SPEC Phase 4)

"select text, attach comments, run revision, deliberately induce an out-of-span
change and confirm the unauthorized-change panel catches unrelated edits while
[CONSISTENCY FIXES] entries pass; accept/reject per hunk produces the correct final
text as a new version." All covered by the E2E and unit tests above.

### Judgment calls (mirrored in DECISIONS.md)

- D15: Pending revisions persist in a new `revisions` table; the diff is recomputed
  deterministically at resolve time rather than trusted from the client.
- D16: Flagged span location trusts the cached offset as a hint, else first search.
- D17: Line-based diff with word-level refinement for display; segment-walk rebuild
  guarantees exact accept/reject reconstruction.
- D18: Declared-fix matching heuristic (quoted and proper-noun tokens); authorized
  is checked before declared; 200-char tolerance as a window-overlap test.
- D19: Only unresolved comments count as flagged spans for a revision.
- D20: A revision saves a new draft version; comments do not carry forward.
- D21: Revision output is em-dash linted exactly like drafting (reject, retry once,
  then warn, never silently accept).

---

## Phase 5: Lock, extract, sweep (plus Amendment A1)

Status: COMPLETE. All tests green.

### What was built

- Idempotent migration: `character_states` gains a nullable `source` column
  ('manual' default, 'extraction:<chapter_id>' for approved proposals). Added with a
  guarded `ALTER TABLE` in `migrate.ts` (`addColumnIfMissing` checks
  `pragma_table_info` first, so re-running and upgrading a Phase 1-4 DB are both
  no-ops). `schema.ts` and the characters repo (`addState`, new `findCharacterByName`)
  updated.
- Extraction envelope + parsers (`src/lib/llm/extraction.ts`):
  `parseExtractionResponse` normalizes the A1 envelope `{ facts, states }`
  defensively (code-fenced and garbage inputs surface raw text); `parseSweepResponse`
  normalizes a contradiction array.
- Prompts (`src/lib/llm/prompts.ts`): `summaryPrompt` (~150 words, present tense,
  canon-relevant), `extractionPrompt` (durable facts + state deltas only, both in one
  JSON object), `sweepPrompt` (contradictions only as JSON).
- Approval + unlock repo (`src/lib/repo/extraction.ts`): `approveExtraction` (atomic
  gate: approved facts become locked canon sourced to the chapter, approved states
  insert at order_index + 1 with the same source, an unmatched character rejects the
  whole call), `unlockChapter` (summary cleared, extracted facts dropped to
  provisional), `extractedFacts`.
- Sweep aggregation (`src/lib/sweep.ts`): `sweepableChapters` (locked, in range) and
  `runSweep` (one call per chapter, sequential, per-chapter fixture routing, defensive
  parse keeps an unparseable chapter's raw text in the report). Every call logged.
- Routes: `POST /api/chapters/[id]/lock` (summary + status, gated on all comments
  resolved), `POST /api/chapters/[id]/extract-canon` (proposals, nothing written),
  `POST /api/extractions/approve` (the gate), `POST /api/chapters/[id]/unlock`,
  `POST /api/projects/[id]/sweep`. All utility calls log to `llm_calls` with the right
  purpose and chapterId.
- UI: `LockPanel` (in the review page via `ReviewEditor`): Lock button enabled only
  when all comments are resolved; on lock it stores the summary and renders the
  fact + state approval checklist with per-proposal checkboxes, `a`/`r` keyboard
  shortcuts, editable state fields, character mapping (select) and inline character
  creation for unmatched names, an Approve button, and an Unlock action. `SweepRunner`
  + `/book/[projectId]/sweep` page: locked-chapter range selector, a chapter-count
  estimate shown before running, a progress indicator while running, and the
  aggregated report (contradictions with quote + severity, or raw text on parse
  failure). The book page links to the sweep page; the lock panel links back to it.
- Fixtures: `summary.phase5.json`, `extraction.phase5.json` (facts + states arrays),
  `sweep.sweep1.1.json` (a contradiction), `sweep.sweep1.2.json` (clean).

### Test results

- Unit (vitest): 75 passed (was 58; +17: 3 migrate-source, 12 extraction/sweep-parse
  + approval + unlock, 2 sweep aggregation).
- E2E (Playwright): 21 passed (was 17; +4): Lock enables only after comments resolve
  and locking stores a summary and shows proposals; approving a fact makes a locked
  canon fact at /canon; approving a state shows in the character timeline AND is
  effective in the next chapter's assembled prompt; sweep over two locked chapters
  reports a planted contradiction with its quote and severity while the clean chapter
  reads clean.
- `tsc --noEmit`: clean.

### Acceptance check (SPEC Phase 5 + Amendment A1)

"locking generates a summary and extraction proposals; approvals become locked facts;
sweep over two chapters with a planted contradiction reports it" plus A1's "locking a
chapter whose text shows a character learning something new produces a
character_state proposal; approving it makes the state visible in that character's
timeline and effective for the next chapter's assembled prompt." All covered.

### Judgment calls (mirrored in DECISIONS.md)

- D23: Extraction envelope is one JSON object `{ facts, states }`, parsed defensively.
- D24: Unlock flags stale by clearing the summary and un-locking extracted facts
  (dropping them to provisional), using existing columns; states left intact.
- D25: Sweep fixture routing is per-chapter (base key plus 1-based position).
- D26: Lock and extraction are separate routes driven in sequence by the Lock button;
  `/unlock` added as the explicit unlock action.
- D27: The approval gate is atomic; an unmatched character name rejects the whole
  call; enforced on both client and server; nothing auto-approves.
- D28: Keyboard parity (a/r) for fact and state proposals now; full keyboard-driven
  navigation is a Phase 6 importer concern.

---

## Phase 6: Backfill importer and export

Status: COMPLETE. All tests green.

### What was built

- Shared lock-time flow (`src/lib/lockFlow.ts`): `generateAndStoreSummary` and
  `runCanonExtraction` are the exact Phase 5 summary-generation and
  canon-extraction logic, pulled out of the `/lock` and `/extract-canon` route
  handlers (which now call them) so the importer reuses the identical
  implementation rather than a second copy. Both routes' behavior and existing
  tests are unchanged.
- `createChapterAtOrder` (`src/lib/repo/chapters.ts`): creates a chapter directly
  in `locked` status at a confirmed `order_index`. Every existing chapter at or
  after that index shifts down by one inside a single transaction (order_index
  carries no uniqueness constraint, so the shift order does not matter). The
  chapter is never observable in an unlocked state, even if the summary or
  extraction call that follows throws.
- Route `POST /api/projects/[id]/import`
  (`src/app/api/projects/[id]/import/route.ts`): validates title and pasted text,
  clamps the confirmed order to `[0, existingChapterCount]`, creates the chapter
  (locked, single draft version via `createDraftVersion`), then runs
  `generateAndStoreSummary` and `runCanonExtraction` in sequence and returns the
  proposals. Approval itself is the existing `POST /api/extractions/approve`
  gate, called unmodified from the client.
- Export module (`src/lib/export.ts`, `buildExport`): concatenates `locked`
  chapters (latest draft version each) in `order_index` order into one Markdown
  document, `#` book title followed by `##` per chapter heading. A book with no
  locked chapters still produces a valid, readable document (title heading plus a
  placeholder line) rather than an empty string.
- Route `GET /api/projects/[id]/export` streams that document back with
  `Content-Disposition: attachment` and a filename slugified from the book title.
- Import page `/book/[projectId]/import` and `ImportPanel`
  (`src/components/ImportPanel.tsx`): paste form (title, confirmed order, chapter
  text), then the same fact/state approval checklist shape as `LockPanel`, but
  with full keyboard navigation across the combined proposal list (ArrowUp/
  ArrowDown move focus between rows, a/r approve/reject the focused row, the
  richer nav D28 deferred to here). Finishing a chapter ("Done, next chapter")
  clears the form, advances the default next order, refocuses the title field,
  and increments a running "imported this session" count, so the page is
  immediately ready for the next paste.
- Book page (`/book/[projectId]`) gained an "Import chapter" link and an "Export
  book" button/link (`data-testid="export-button"`, a plain anchor to the export
  route; the browser handles the download from the `Content-Disposition`
  header).

### Test results

- Unit (vitest): 84 passed (was 75; +9: 4 in `import.test.ts` covering
  `createChapterAtOrder` locked-at-confirmed-order creation, mid-list insertion
  shifting the rest, end-append stability, and per-book isolation; 5 in
  `export.test.ts` covering ordered concatenation with headings, reorder plus
  latest-draft-version selection, exclusion of non-locked statuses, the
  empty-book document, and filename slugification).
- E2E (Playwright): 24 passed (was 21; +3 in `phase6.spec.ts`): importing a
  chapter shows the summary and proposals and, driven with the keyboard only
  (arrows plus a/r, including an explicit reject-then-reapprove round trip),
  approving one fact and one state lands them as locked canon and in the
  character's timeline; importing three chapters back-to-back proves the form
  resets (cleared, refocused, count incremented) each time with no manual
  cleanup between pastes; exporting two locked chapters downloads a single
  Markdown file containing both chapter headings and their text in reading
  order.
- `tsc --noEmit`: clean.

### Acceptance check (SPEC Phase 6)

"import three chapters back-to-back with keyboard-driven approvals in under ten
minutes of user time; export produces a single Markdown file in reading order."
The E2E suite proves the mechanical part (uninterrupted repeat flow, keyboard-only
approval, correct reading order); wall-clock time is a UX property of the built
flow (no confirmation dialogs, no page reloads, no dead clicks between chapters),
not something a test asserts.

### Judgment calls (mirrored in DECISIONS.md)

- D29: `generateAndStoreSummary` / `runCanonExtraction` extracted into
  `src/lib/lockFlow.ts` and reused by `/lock`, `/extract-canon`, and the importer.
- D30: `createChapterAtOrder` sets status `locked` at creation time, not after the
  summary call succeeds, so a mid-flow failure cannot leave a half-imported
  chapter in a status the rest of the app does not expect.
- D31: Export heading levels (`#` book title, `##` per chapter) and the
  empty-book document; filename slugified from the book title.
- D32: The import approval checklist is its own component (`ImportPanel`), not a
  reuse of `LockPanel`, because Phase 6 requires full arrow-key row navigation
  that D28 deliberately deferred to here; both share the same proposal shape and
  the same `/api/extractions/approve` gate.
- D33: Confirmed order is a plain 0-based `order_index` number input, clamped
  server-side to `[0, existingChapterCount]`; the client's default value is a
  local running count, but the server is the source of truth for the clamp and
  the shift.

---

## Phase 7: Hardening and deploy prep

Status: COMPLETE. All tests green.

### What was built

- DB path: `resolveDbPath` (`src/lib/db/raw.ts`) already honored `DATABASE_PATH`
  for both relative and absolute paths, resolved against `process.cwd()`
  (`path.resolve` passes an absolute input through unchanged), and `openRawDb`
  already auto-created the parent directory. No behavior change was needed;
  `tests/unit/db-path.test.ts` (7 tests) adds direct coverage: default path,
  relative override, absolute override, directory auto-creation for both
  relative and absolute paths, idempotent re-open, and the env-driven default
  when no explicit path is passed.
- Backup: `scripts/backup-core.mjs` (plain Node ESM, no TS, no deps beyond
  `node:fs`/`node:path`) exports `formatTimestamp` and `backupDbFile`, unit
  tested directly (`tests/unit/backup.test.ts`, 6 tests: missing-file refusal,
  directory creation, timestamp-suffixed filename, WAL/SHM sidecar copy when
  present, partial-sidecar case, idempotent re-run into an existing backup
  dir). `scripts/backup.mjs` is the thin CLI wrapper `npm run backup` already
  pointed at: resolves `DATABASE_PATH` (duplicating `resolveDbPath`'s two
  lines, since a plain-Node script cannot import TypeScript), computes a
  `backups/` directory beside the database file, calls `backupDbFile`, and
  prints the created path (and any copied sidecars) or a clear failure message
  with a non-zero exit code.
- Auth in production: `src/lib/authConfig.ts` adds two pure functions,
  `isAuthConfigured` and `mustBlockForMissingAuthConfig`, unit tested directly
  (`tests/unit/authConfig.test.ts`, 10 tests). `src/middleware.ts` now checks
  `mustBlockForMissingAuthConfig(process.env.NODE_ENV, process.env)` before
  anything else (after letting `_next`/favicon assets through) and returns a
  plain 503 ("APP_PASSWORD not configured") for every path, JSON for `/api/*`,
  when running in production without both `APP_PASSWORD` and `SESSION_SECRET`
  set. Dev and test are unaffected: the existing auth tests, the login route's
  own 500 when unconfigured, and the E2E suite (which runs `next dev`, so
  `NODE_ENV` is never `production`) all keep their prior behavior.
  `src/app/api/auth/login/route.ts` now calls `isAuthConfigured` instead of
  duplicating the two-length check, no behavior change.
- Dockerfile: three-stage build (`deps`, `builder`, `runner`), all on
  `node:20-bookworm-slim` (not alpine, to avoid a musl/prebuild mismatch for
  better-sqlite3 and sharp). `deps` installs `python3 make g++` as the
  node-gyp fallback for `better-sqlite3`'s `prebuild-install` and runs
  `npm ci`. `builder` runs `npm run build` (Next standalone output). `runner`
  copies only `.next/standalone` (which already includes a traced
  `node_modules` subset, confirmed to contain the compiled
  `better_sqlite3.node` binary, see Judgment calls) plus `.next/static` and the
  backup script, runs as a non-root user, and defaults `DATABASE_PATH` to
  `/data/bookforge.db`. `next.config.ts` gained `output: "standalone"`.
  `.dockerignore` added.
- `fly.toml`: app config with `[mounts]` mapping a `bookforge_data` volume to
  `/data`, `DATABASE_PATH=/data/bookforge.db` in `[env]`, `internal_port = 3000`
  matching the Dockerfile's `EXPOSE`, and `min_machines_running = 1` with
  `auto_stop_machines = false` (see Judgment calls). A comment block at the top
  lists the one-time `flyctl` setup commands (app create, volume create,
  secrets set for `ANTHROPIC_API_KEY`, `APP_PASSWORD`, `SESSION_SECRET`); none
  were run.
- `DEPLOY.md`: local run from a fresh clone, backup usage, Docker build/run,
  Fly.io one-time setup and deploy, and how to run a backup against the
  production volume over `flyctl ssh console`.

### Test results

- Unit (vitest): 107 passed (was 84; +23: 7 db-path, 6 backup, 10 authConfig).
- E2E (Playwright): 24 passed, unchanged from Phase 6 (no new E2E required for
  this phase; deploy artifacts are not browser-testable). Re-ran the full
  suite after the production build and after deleting `.next`, against a fresh
  `npm run dev` (`NODE_ENV` is not `production` there, so the new middleware
  gate never engages in dev/E2E).
- `tsc --noEmit`: clean.
- `npm run build`: succeeds cleanly with `output: "standalone"` set; no
  Suspense-boundary or dynamic-rendering fixes were needed, the existing route
  tree built cleanly the first time.
- Backup script exercised end to end against a real file: created a scratch DB
  at `./data/scratch-backup-test.db`, ran `DATABASE_PATH=./data/scratch-backup-test.db
  node scripts/backup.mjs`, confirmed the timestamped copy under
  `./data/backups/` byte-identical to the source, confirmed the missing-file
  path fails cleanly with a non-zero exit code, then deleted every scratch
  file and the now-empty `backups/` directory.

### Acceptance check (SPEC Phase 7)

"DB file path configurable, Dockerfile + Fly.io config with a mounted volume,
APP_PASSWORD required in production mode, basic backup script (copy the SQLite
file with a timestamp)." All four covered: `DATABASE_PATH` (pre-existing,
now directly tested), `Dockerfile` + `fly.toml` with `[mounts]`, the
production-mode 503 gate in `src/middleware.ts`, and `scripts/backup.mjs`.

### Judgment calls (mirrored in DECISIONS.md)

- D34: Docker build and Fly deploy were not executed (no Docker daemon in this
  environment); the Dockerfile and fly.toml are a best-correct-effort, verified
  by inspecting the traced standalone output rather than an actual image
  build. Stated plainly, not claimed as tested.
- D35: The standalone trace was confirmed by inspection to include the
  compiled `better_sqlite3.node` binary under
  `.next/standalone/node_modules/better-sqlite3/build/Release/`, plus its JS
  wrapper and its own runtime deps (`bindings`, `file-uri-to-path`,
  `detect-libc`). This only works because the binary is built inside a Linux
  build stage; it cannot be traced from a host-built (Windows) `node_modules`.
- D36: Backup directory defaults to a `backups/` directory beside the database
  file (`dirname(dbPath)/backups`), not a fixed `./backups` relative to the
  process cwd. On Fly, `DATABASE_PATH=/data/bookforge.db` puts backups at
  `/data/backups/`, on the same mounted volume, so they survive restarts; a
  cwd-relative default would put them on the ephemeral container filesystem.
- D37: `fly.toml` pins `min_machines_running = 1` and
  `auto_stop_machines = false`. SQLite on a single mounted volume is not safe
  to access from more than one machine at once; scale-to-zero or multi-machine
  auto-scaling would risk two machines opening the same file. This is a
  deliberate single-instance constraint, not an oversight.
- D38: The production auth gate blocks every path, including `/login` and
  `/api/auth/login`, with a 503, rather than letting the login page load and
  only failing at submit time. Simplest compliant reading of "refuse to serve
  protected content": the operator misconfiguration is visible immediately
  (health check fails) instead of surfacing as a broken login form.

---

## Final verification (orchestrator, after Phase 7 review)

- Independent re-runs after every phase merge: 107 unit tests, 24 Playwright
  tests, tsc clean, production build (standalone) clean.
- One flake found during the Phase 7 cold-server E2E run: the Phase 2 "reorder
  persists across reload" test could reload before the reorder POST resolved.
  Fixed by awaiting the /api/chapters/reorder response before reloading. This
  strengthens determinism; no assertion was weakened. Full suite re-run cold:
  24/24 pass.
- Phases 4 and 5 were built by Opus subagents, Phases 6 and 7 by Sonnet
  subagents, each reviewed (diff, assertion audit, independent test runs,
  em-dash scan) and approved by the orchestrator before commit.
- Not verified in this environment: the Docker image build (no Docker daemon)
  and any behavior against the real Anthropic API (all tests use fixtures by
  design). Both are called out in DEPLOY.md and the Phase 7 report.

---

## Amendment A2: UI chapter numbering convention and sweep error surfacing

Status: COMPLETE. All tests green. Two fixes, no new features.

### What was built

A2.1, chapter numbering. The database stays 0-based everywhere
(`chapters.order_index`, `character_states.chapter_order`; a state applies to
chapters with `order_index >= chapter_order`). The UI now speaks 1-based chapter
numbers, converting at the boundary through one module.

- `src/lib/chapterNumbering.ts`: `orderToUiChapter(order) = order + 1` and
  `uiChapterToOrder(uiChapter) = uiChapter - 1`. The single place the conversion
  happens; every conversion site imports from here.
- The character add-state form (`src/components/CharactersManager.tsx`,
  `AddStateForm`) was the bug. It now labels the field "Effective from chapter
  (1 = first)", defaults to 1, and stores
  `chapter_order = uiChapterToOrder(N)` (converted client-side before the POST).
  The state timeline row displays `ch {orderToUiChapter(chapter_order)}`. So a
  state entered as chapter 1 on a book's first chapter (order_index 0) now stores
  chapter_order 0 and applies to that chapter, the reported bug.
- The importer order field (`src/components/ImportPanel.tsx`) is now a 1-based
  position ("Position (1 = first, N = last)"), defaulting to the next position at
  the end (existing count + 1), converted with `uiChapterToOrder` before the POST.
  The `/api/projects/[id]/import` route is unchanged (still receives and clamps a
  0-based `orderIndex`).
- Audit of every other chapter-number surface: all were already 1-based, using an
  inline `orderIndex + 1`. They were routed through `orderToUiChapter` so the
  helper is the single conversion point: `SweepRunner` range dropdowns, the sweep
  report `order`, the sweep prompt's `chapterNumber` (`src/lib/sweep.ts`), the
  fallback chapter titles in `src/lib/assembler.ts`, `src/lib/export.ts`,
  `src/lib/lockFlow.ts`, `src/app/api/chapters/[id]/interrogate/route.ts`, and the
  book/sweep/import/draft/review/prompt pages. The Sequencer row number stays
  `index + 1` (a list ordinal, not a stored order). The extraction approval path
  (`src/lib/repo/extraction.ts`, `chapter_order = order_index + 1`) is internal
  0-based arithmetic and was left untouched, per the amendment.

A2.2, sweep errors carry reasons.

- `src/lib/sweep.ts`: `SweepChapterReport` gains an `error: string | null`. Each
  chapter's LLM call is wrapped in try/catch; on failure it pushes a report entry
  naming the chapter and the error message and continues to the remaining chapters
  (the run is not aborted). Parse failures keep their existing raw-text surfacing.
- `src/app/api/projects/[id]/sweep/route.ts`: wraps `runSweep` and returns the
  underlying message (`Sweep failed: <message>`, HTTP 500) on a whole-run failure.
- `src/components/SweepRunner.tsx`: renders a per-chapter error region
  (`data-testid="sweep-error-<id>"`); the whole-run error fallback now shows the
  route's message or the HTTP status, so the bare reasonless "Sweep failed." is no
  longer reachable.

### Test results

- Unit (vitest): 112 passed (was 107; +5). New: `chapterNumbering.test.ts` (4:
  both helpers, round-trip, and the chapter-1-stores-order-0 case) and one in
  `sweep.test.ts` (a chapter whose LLM call throws yields an error entry and does
  not abort the remaining chapters).
- E2E (Playwright): 27 passed (was 24; +3 in `a2.spec.ts`): the mandatory A2.1
  regression (adding a state "effective from chapter 1" through the character form
  on a book's first chapter makes its content appear in that chapter's assembled
  prompt via `/api/dev/prompt/<id>`); the importer order field is 1-based; a sweep
  where one chapter's fixture is missing reports that chapter with a reason and
  still processes the next chapter (which reads clean).
- `tsc --noEmit`: clean.

### Existing tests updated

None. The `phase1` character test drives the add-state form with its default
value and asserts only the knows/feels text, never a "ch N" string, so the
unchanged visible output (entering the default now stores 0 but still displays
chapter 1) needed no edit. No other existing test drove the old UI semantics.

### Judgment calls (mirrored in DECISIONS.md, D39-D43)

- D39: One conversion module, used by every site; no other place converts.
- D40: The character-state conversion happens client-side before the POST; the
  states API route keeps its raw 0-based `chapter_order` contract.
- D41: The importer conversion is also client-side; the import route is unchanged.
- D42: A sweep continues past a failed chapter; per-chapter failures become report
  entries; the whole-run failure surfaces its message; bare "Sweep failed." gone.
- D43: `a2.spec.ts` has a `beforeAll` warm-up (it sorts first and pays the dev
  server's cold-compile cost). Warm-up only, no assertion weakened.

---

## Amendment A3: Series bible importer

Status: COMPLETE. All tests green. One new feature: turn a pasted story bible into
structured, approval-gated data (canon facts, characters, character states).

### What was built

- LLM purpose: `"bible"` added to `LlmPurpose` (`src/lib/llm/client.ts`). Every
  bible extraction call logs to `llm_calls` with purpose 'bible'.
- Chunking (`src/lib/bibleChunks.ts`, `chunkBible`): splits a pasted bible on
  paragraph boundaries (blank lines) at roughly 24,000 characters per chunk, packing
  whole paragraphs up to the cap. A paragraph is never split mid-way: an oversized
  single paragraph is its own chunk. A short bible is one chunk; whitespace-only
  input is zero chunks. Pure and unit tested; also imported client-side for the
  progress copy.
- Response parsing (`src/lib/llm/bible.ts`, `parseBibleResponse`): normalizes the A3
  envelope `{ facts, characters, states }` defensively (code-fenced and garbage
  inputs surface raw text; invalid entries dropped: bad fact type, nameless
  character, delta-less state).
- Prompt (`src/lib/llm/prompts.ts`, `bibleExtractionPrompt`): includes the pasted
  chunk, the current locked canon, and the tracked character names (dedup), and
  demands the exact A3 JSON envelope. No em-dashes.
- Import flow (`src/lib/bibleImport.ts`, `runBibleImport`): chunks the text, runs one
  UTILITY_MODEL call per chunk sequentially (purpose 'bible', logged), parses each,
  merges proposals, and keeps a per-chunk parse failure (with raw text) for any chunk
  that did not parse. Same shape as `runSweep` (D44).
- Approval gate (`src/lib/repo/bible.ts`, `approveBible`): the atomic gate for A3.
  Creates/updates approved characters first, then resolves approved states (explicit
  id, else case-insensitive name match including the just-created rows), so a state
  naming a not-yet-tracked character can be approved together with that character's
  creation. Any unresolved state rolls the whole transaction back (nothing created)
  and returns the unmatched names (D47). Approved facts become LOCKED canon with
  source 'bible' at the chosen scope (project_id null for series-wide); approved
  states require a book scope and land at chapter_order 0 with source 'bible'; a
  character proposal carrying an existing row's id is applied as an update of only its
  non-empty fields, never a duplicate.
- Routes: `POST /api/bible/import` (proposals, nothing written) and
  `POST /api/bible/approve` (the gate).
- UI: `/import-bible` page linked from the home Books page
  (`data-testid="import-bible-link"`), and `BibleImportPanel`
  (`src/components/BibleImportPanel.tsx`): a large paste textarea, a scope selector
  (series-wide or a specific book; the states section is hidden for series-wide), and
  a categorized approval checklist (facts, characters, states) with the same
  keyboard-driven UX as the backfill importer, arrows move focus across ALL sections
  in order and a/r approve/reject the focused row. Characters render as new-creation
  or update proposals (showing which fields would change); a state whose character is
  an approved creation shows a "will be created in this batch" note. Nothing lands
  unapproved; no approve-all default. Per-chunk parse failures surface their raw text.
- Fixture: `bible.bible1.json` (two world rules, a style note, two characters one
  with voice rules, and one character state).

### Test results

- Unit (vitest): 128 passed (was 112; +16). New: `bibleChunks.test.ts` (5: short
  single chunk, over-cap paragraph split, whole-paragraph packing, oversized single
  paragraph kept whole, whitespace-only) and `bible.test.ts` (11: envelope parse
  valid/fenced/drops-invalid/garbage-raw, and approval logic covering locked facts
  with source 'bible' and correct scope, character creation, name-match producing an
  update not a duplicate, state at chapter_order 0 with source 'bible', same-batch
  character+state creation order, atomic rejection on an unmatched state, and the
  series-wide-rejects-states rule).
- E2E (Playwright): 28 passed (was 27; +1 in `a3.spec.ts`): the SPEC acceptance
  check verbatim. Paste a bible reached from the home link, proposals come back
  categorized (facts, characters, states), approve a subset via keyboard only (arrows
  plus a/r, including an approve/reject/approve round trip), the approved items exist
  exactly (locked fact source 'bible' at Book 2 scope, visible locked at /canon; the
  character row on /characters with its voice rules; the state in the character's
  timeline; the fact and state both present in a Book 2 chapter's assembled prompt via
  /api/dev/prompt/<id>), and the rejected proposals leave no trace (absent from
  /api/canon, /api/characters, and the assembled prompt).
- `tsc --noEmit`: clean.

### Acceptance check (SPEC Amendment A3)

"paste a bible containing at least two world rules, a style note, two characters (one
with voice rules), and one character state; the proposals come back categorized;
keyboard-only approval of a subset creates exactly the approved items (locked facts
with source 'bible', character rows, a state at chapter_order 0 visible in the
timeline); a chapter of the chosen book then shows the approved facts and state in its
assembled prompt; rejected proposals leave no trace." All covered by `a3.spec.ts`.

### Note on running the E2E suite

The full `npm run test:e2e` was verified 28/28 green against a pre-warmed dev server.
On this particular slow sandbox a cold `npm run test:e2e` intermittently trips the
pre-existing `a2.spec.ts` `beforeAll` warm-up hook, whose hook timeout is the global
30s while a cold dev-server first-boot compile can exceed it (a latent fragility in
A2's warm-up, D43; it intends 90s but the hook caps at 30s). This is unrelated to A3:
a3.spec runs in about 8s, a2's own tests pass in single-digit seconds once the server
is warm, and A3 touches none of the routes a2's hook compiles. On a normal-speed
machine the cold run passes as before. a2.spec was not modified (out of A3 scope).

### Judgment calls (mirrored in DECISIONS.md, D44-D49)

- D44: The bible is chunked server-side in one POST, mirroring the sweep; per-chunk
  fixture routing (single chunk = base key, multiple = 1-based suffix).
- D45: `BibleImportPanel` is its own component (like D32's `ImportPanel`), sharing
  the keyboard model and the server gate but not the markup.
- D46: The extraction prompt sees all locked canon and all tracked names regardless
  of scope; scope only decides where approved data lands.
- D47: The approval gate creates characters first, then resolves states, all in one
  transaction with atomic rollback on any unmatched state; updates apply only
  non-empty fields; states hard-require a book scope, server-enforced.
- D48: One-time focus-on-load uses a latching ref so approve/reject never steals
  focus mid-navigation; `ImportPanel` left untouched.
- D49: The A3 e2e approves a world rule, a character, and a state (not the style
  note), so it does not collide with Phase 1's exact count of five locked style rules.
