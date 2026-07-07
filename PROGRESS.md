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
