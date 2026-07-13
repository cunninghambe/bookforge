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
