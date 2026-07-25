# DECISIONS

Every ambiguity resolved during the build, with the reasoning. Simplest compliant
option chosen unless noted. Deferred non-goals are also listed at the bottom.

Never use em-dashes anywhere in this repo, per SPEC.md.

---

## Phase 1

### D1: Project runs from local disk, not the Google Drive folder

The primary working directory is `G:\My Drive\Claude`. Google Drive's file-sync
daemon holds locks on files inside `node_modules`, which makes `npm install` fail
(EPERM / ENOTEMPTY / EBADF during cleanup) and would make a live `.next` cache and a
SQLite WAL file unreliable. The tool must actually run, so the working tree lives at
`C:\Users\cunni\bookforge`. `G:\My Drive\Claude\bookforge` stays the source of
record (edited there, synced to C: with a forced robocopy that excludes
node_modules, .next, .git). At the end of the build the local tree is mirrored back
to Drive. This is reversible and does not change any code; it is purely where the
files live while running. If you prefer a different local path, move the folder and
update nothing but your shell path.

### D2: llm_calls table created in Phase 1

SPEC defines `llm_calls` in the LLM integration notes rather than the data-model
block. Creating it during the first migration avoids a schema change mid-build. No
behaviour depends on it until Phase 3.

### D3: Session cookie signed with Web Crypto HMAC, no JWT dependency

A single shared password does not need JWT claims. An HMAC-SHA256 token
(payload = version + issued-at) signed with `SESSION_SECRET` is enough, and Web
Crypto runs identically in Edge middleware and Node route handlers, so one code path
covers both.

### D4: Next.js pinned to 15.5.x

The spec text predates a published Next.js security advisory affecting 15.1.x. Since
the tool is meant to run for real, Next was upgraded to the latest patched 15.5
release. App Router APIs used here are unchanged.

### D5: assemblableCanon excludes everything except locked in-scope facts

SPEC says retired facts are excluded from all prompt assembly and that the assembler
uses locked facts. `assemblableCanon` therefore returns only `locked` facts whose
scope is series-wide or the current book. Provisional and retired facts are never
assemblable.

### D6: Model default strings kept as written in SPEC

`.env.example` keeps `DRAFT_MODEL` and `UTILITY_MODEL` at `claude-sonnet-4-6` as the
spec wrote them. They are env-configurable and every test mocks the client, so the
exact string is never exercised against the network in the loop. The user should
confirm the current model id against the Claude docs before a real run.

---

## Phase 2

### D7: Chapter reorder uses up/down buttons, not drag

SPEC describes "drag to reorder", but the Phase 2 acceptance check only requires that
reorder persists order_index. Up/down buttons persist reliably and are
deterministically testable in Playwright; drag-and-drop is fiddly to drive and adds
no functional coverage. The drag gesture is deferred as UI polish.

### D8: Interrogation answer becomes a self-contained plot_decision

When an interrogation question is answered, the created provisional plot_decision
fact's content is the question followed by the answer. That way the locked fact
reads as a complete decision in the canon list without needing the original question
for context.

### D9: LLM fixture routing by purpose

The mock client keys fixtures by call `purpose` (interrogation, summary, extraction,
sweep, draft, revision) plus an optional `fixtureKey` when one test needs a specific
variant. Fixtures live in `tests/fixtures/` and are read from disk only when
`USE_FIXTURE_LLM=1`, so a production build never bundles or reads them.

---

## Phase 3

### D10: Stream control frame uses a printable sentinel

The draft stream sends prose chunks then a control frame carrying the clean text and
alerts. They are separated by the printable sentinel `<<<BOOKFORGE_CTRL>>>` (an
earlier null-byte delimiter was dropped because git would treat the source file as
binary). The sentinel never occurs in prose, so the split is unambiguous.

### D11: Drafting is persistence-stateless; the client owns editor text

`POST /api/chapters/[id]/draft` only assembles and streams; it does not write drafts.
The editor holds the text and persists via `POST /api/chapters/[id]/save-draft`,
which upserts the working (latest) draft version. Continue appends a new segment;
Redraft drops the last segment and regenerates. This avoids tracking a scene-to-beat
mapping on the server and keeps Redraft well defined.

### D12: No book-level summaries stored

SPEC's STORY SO FAR block calls for "a one-line summary per prior book if any". The
data model stores chapter summaries, not book summaries, so the assembler emits a
pointer line per prior book instead of a synthesized one-liner. The heavy lifting is
done by the per-chapter summaries. This can be revisited when Book 2 drafting needs
richer prior-book context.

### D13: A test fixture deliberately contains an em-dash

`tests/fixtures/draft.emdash.json` contains a U+2014 on purpose: it is the negative
input that proves the em-dash linter rejects and retries. It is test-only data, read
only under `USE_FIXTURE_LLM=1`, and never appears in shipped prose, UI, or code.

### D14: Em-dash retry surfaces, never hides, a residual violation

If the single retry still contains an em-dash, the draft is not silently accepted:
the control frame sets `emDashUnresolved` and the editor shows a warning to fix it
before locking. The rule is enforced, not softened.

---

## Phase 4

### D15: Pending revisions persist in a new `revisions` table

The gap between /revise (produce the revised text and diff analysis) and /resolve
(accept or reject hunks, save a new version) needs somewhere to hold the old text,
the new text, the flagged spans, and the declared consistency fixes. Options were a
client round-trip (echo everything back on resolve) or server persistence. A table
is the simpler compliant choice: it survives a page reload, keeps the large text
bodies off the wire twice, and lets /resolve recompute the diff deterministically
rather than trusting client-supplied hunks. Added `revisions` with an idempotent
`CREATE TABLE IF NOT EXISTS` in migrate.ts and a Drizzle definition in schema.ts.
The diff is never stored; it is recomputed from old_text, new_text, flagged_spans,
and consistency_fixes at resolve time, so hunk indices are stable.

### D16: Flagged span location uses the cached offset as a hint, else first search

SPEC: quoted_text is the source of truth; offsets are cached best-effort and
recomputed by string search on load. `findSpan(text, quotedText, hint)` trusts the
cached offset only when the text still sits there verbatim (which disambiguates a
phrase that repeats), and otherwise falls back to the first `indexOf` occurrence.
The same helper anchors comments on load and locates flagged spans for the diff
classifier, so both agree.

### D17: Line-based diff, word-level refinement for display, segment-walk rebuild

`analyzeRevision` runs `diffLines` and groups consecutive changed parts into hunks,
tracking each hunk's char range in the old text. Each hunk also carries a
`diffWordsWithSpace` refinement purely for side-by-side rendering; classification
and reconstruction use the line hunks only. Reconstruction walks the same ordered
segments (common runs and hunks) and emits either the old or the new side per hunk,
which guarantees that accepting every hunk reproduces newText exactly and rejecting
one restores oldText exactly for that span while keeping the others. This is unit
tested directly.

### D18: Declared-fix matching heuristic, and authorized beats declared

A changed hunk is AUTHORIZED if its old range overlaps a flagged span widened by a
200-character tolerance window on each side (overlap test, so pure insertions at a
point count). Authorization is checked first. If not authorized, a hunk is DECLARED
when a token drawn from a [CONSISTENCY FIXES] entry appears in the hunk's changed
text; tokens are the quoted substrings in the entry (the strongest signal, since the
model names what it changed) plus capitalized words of length four or more. Anything
else is UNAUTHORIZED. The heuristic is deliberately conservative: quoted tokens make
false positives unlikely, and a miss only means a real fix shows up as an
unauthorized change for the author to accept, which is the safe direction.

### D19: Only unresolved comments are flagged spans for a revision

"Revise flagged spans" acts on the open comments. Resolved comments are excluded
from the flagged-span set sent to the model and from the authorization windows, so a
resolved note never silently authorizes a change.

### D20: A revision saves a new draft version and drops comments

Per SPEC, resolving a revision calls `createDraftVersion` (a new immutable version)
rather than mutating the working draft, and comments do not carry forward: the UI
clears the panel and the new version starts with no comments, matching the span
anchoring rule that comments belong to a specific immutable version.

### D21: Revision output is linted for em-dashes exactly like drafting

The revise route hard-rejects an em-dash in the model output and auto-retries once
with an explicit instruction; if the retry is still dirty it surfaces an
`emDashUnresolved` warning in the review panel and never silently accepts it. This
mirrors the drafting pipeline so the forbidden-character rule holds on both paths.

---

---

## Spec amendments accepted mid-build

### D22: Amendment A1, character-state extraction at lock time (2026-07-13)

Proposed during the Phase 3 stop while discussing character chatbots: the chatbot
idea stays deferred, but its prerequisite (dense, automatically maintained
character states) was accepted by the author as amendment A1 in SPEC.md. Lock-time
extraction (Phase 5) and the importer (Phase 6) will propose character_state
deltas alongside canon facts, through the same approval checklist. Approved states
land with chapter_order = locked chapter order_index + 1, so the assembler picks
them up from the next chapter onward. Rationale for N+1 rather than N: state rows
effective at N would alter the assembled context of the very chapter that produced
them; the chapter itself already contains the events, so the state should start
applying when drafting resumes after it. character_states gains a nullable source
column ('manual' default, 'extraction:<chapter_id>') via an idempotent ALTER TABLE
guarded by pragma_table_info. Unmatched character names cannot be approved until
mapped, preserving the approval gate.

---

## Phase 5

### D23: Extraction envelope carries both facts and states in one JSON object

Amendment A1 requires the extraction response to carry BOTH new-fact proposals and
character-state deltas. The envelope (a judgment call) is a single JSON object:
`{ "facts": [{ type, content, evidence_quote }], "states": [{ character, knows,
feels, hiding, evidence_quote }] }`. One object (not two calls, not a top-level
array) keeps a single UTILITY_MODEL call and one defensive parse. `facts` and
`states` are independently normalized: a fact needs a valid CanonType and non-empty
content; a state needs a non-empty character name and at least one non-empty delta
field (deltas only, never a restatement). Invalid entries are dropped; a wholly
unparseable response surfaces its raw text (`parseExtractionResponse` in
`src/lib/llm/extraction.ts`), never silently dropped.

### D24: Unlock represents "stale" by clearing the summary and un-locking extracted facts

SPEC 6.d: unlocking flags the summary and extracted facts as stale for
regeneration; the representation is a judgment call, simplest compliant. Chosen
(`unlockChapter` in `src/lib/repo/extraction.ts`): status returns to `review`, the
summary is set to NULL (a re-lock regenerates it), and every canon_fact with source
`extraction:<chapterId>` that is still `locked` drops to `provisional`, which
removes it from prompt assembly (`assemblableCanon` returns only locked) until it is
re-approved through the gate. This uses existing columns (no schema churn), is
directly testable, and only ever removes facts from canon rather than adding any, so
it cannot soften the approval gate. Extracted state rows are left intact: they are
already-applied deltas, and a re-lock re-proposes any further deltas. Seed and
non-extraction locked facts are untouched (matched by exact source string).

### D25: Sweep fixture routing is per-chapter, base key plus 1-based position

The consistency sweep makes one call per chapter. For E2E a single run needs
distinct responses per chapter (one reporting a planted contradiction, one clean).
`runSweep` derives each chapter's fixtureKey as `${baseKey}.${position}` where
position is the 1-based index within the swept (locked, in-range) set, sorted by
order_index. So `?fx=sweep1` routes chapter 1 to `sweep.sweep1.1.json` and chapter 2
to `sweep.sweep1.2.json`. The real Anthropic client ignores fixtureKey, so the
passthrough is harmless in production (same pattern as the draft/revise routes).

### D26: Lock and extraction are separate calls, driven in sequence by the Lock button

The API surface lists `/lock`, `/extract-canon`, and `/extractions/approve`
separately. The review-page Lock button (in `LockPanel`) calls `/lock` (generate and
store the summary, set status locked) and then `/extract-canon` (propose facts +
states) in sequence, then renders the approval checklist. Keeping them as distinct
routes matches the surface and lets the importer (Phase 6) reuse extraction without
re-locking. `/unlock` is added as the explicit unlock action SPEC 6.d requires
(implementing described behavior, not a new feature).

### D27: Approval gate is atomic; unmatched character names reject the whole call

`approveExtraction` resolves every approved state to an existing character first (an
explicit characterId that exists wins, else an exact case-insensitive name match).
If any approved state is unmatched, the entire call is rejected and nothing is
created, not even valid facts, so the author maps or inline-creates the character and
re-submits. Approved facts become `locked` canon sourced `extraction:<chapterId>`;
approved states insert at `chapter_order = locked order_index + 1` with the same
source (Amendment A1 / D22). Both the client (`LockPanel`) and the server
(`/api/extractions/approve` + the repo) enforce the mapping, so the gate holds even
if the UI is bypassed. Nothing auto-approves and there is no bulk-approve-all
default: each proposal is an explicit checkbox.

### D28: Extraction approval checklist keyboard parity now, full nav deferred to Phase 6

Amendment A1 says state proposals render "in the same approval checklist as fact
proposals, with the same keyboard shortcuts". Both fact and state rows are focusable
and share the same shortcuts (`a` approve, `r` reject on the focused row), giving the
parity A1 requires. The richer keyboard-driven flow the SPEC describes for the Phase
6 backfill importer (arrow navigation between rows, batch approval) is built and
tested there, where it is an explicit acceptance requirement; Phase 5 keeps the
checkbox checklist as the primary mechanism.

---

## Phase 6

### D29: Lock-time flow shared via `src/lib/lockFlow.ts`, not duplicated for the importer

The Phase 6 task explicitly requires reusing the lock-time extraction flow (SPEC
section 7, Amendment A1) rather than re-implementing it. `generateAndStoreSummary`
and `runCanonExtraction` are pulled out of the `/api/chapters/[id]/lock` and
`/api/chapters/[id]/extract-canon` route bodies verbatim (same prompts, same
`purpose` strings, same `logLlmCall` calls, same fixture-key passthrough) into
`src/lib/lockFlow.ts`. Both routes now call these functions; their request
validation (draft exists, comments resolved) stays in the route since it is
specific to the lock button, not to the underlying flow. `POST
/api/projects/[id]/import` calls the same two functions after creating the
chapter and its draft. This is one implementation with three callers, not three
implementations.

### D30: Imported chapters are `locked` from the moment of creation

`createChapterAtOrder` sets `status: 'locked'` directly, before the summary or
extraction LLM calls run, rather than starting the chapter in some other status
and promoting it to `locked` only after `generateAndStoreSummary` succeeds (which
also sets `status: 'locked'`, redundantly but harmlessly). Reasoning: SPEC section
7 says the importer should "save as a LOCKED chapter with a single draft version,
then run the same summary + canon extraction flow." If chapter creation instead
deferred locking until after the summary call, a transient LLM failure between
chapter creation and summary generation would leave a chapter with a draft but no
locked status and no summary, a state the rest of the app (export, sweep,
assembler) does not expect and has no UI to recover from. Locking at creation
means the chapter is always in a valid, exportable state the instant it exists;
worst case on an LLM failure is a locked chapter with no summary yet, which the
existing `/unlock` path can already repair (D24).

### D31: Export heading levels, and the empty-book document

SPEC section 8 leaves the heading level a judgment call ("# or ## per chapter
title"). Chosen: the book title is a single `#` at the top, and each chapter is
`##`, so the concatenation reads as one document (a book with chapters) rather
than a flat sequence of equally-weighted headings. A book with no locked chapters
still produces `# <title>\n\n(no locked chapters yet)\n` rather than an empty
string, since "sensible empty document" implies something a human opening the
file would recognize as the (empty) book, not a zero-byte file. The filename is
the book title lowercased, non-alphanumeric runs collapsed to a single hyphen,
trimmed of leading/trailing hyphens, falling back to `book.md` if that produces
nothing (e.g. a title that is entirely punctuation).

### D32: The import approval checklist is a new component, not a reuse of LockPanel

D28 (Phase 5) deliberately deferred "full keyboard-driven navigation (arrow
navigation between rows, batch approval)" to the Phase 6 importer, where it is an
explicit acceptance requirement. `ImportPanel` is therefore its own component
rather than `LockPanel` reused with new props: it needs arrow-key focus movement
across a combined facts-then-states row list (LockPanel's rows are independently
focusable but have no arrow navigation between them), plus the paste form, the
running session count, and the finish/reset flow, none of which apply to the
review page LockPanel lives on. Both components render the same proposal shape
(fact rows with type/content/evidence, state rows with knows/feels/hiding,
character mapping, and inline character creation) and submit to the same,
unmodified `POST /api/extractions/approve` gate: the approval mechanism is one
implementation; only the checklist UI around it is duplicated, and only because
the two pages have genuinely different interaction requirements.

### D33: Confirmed order is a 0-based order_index number, clamped server-side

"Confirm title and order" (SPEC section 7) does not specify a UI shape. Chosen:
a plain number input for the target `order_index` (0 = first), defaulting to
append-at-the-end, shown alongside the count of existing chapters for reference.
The server clamps whatever value arrives to `[0, existingChapterCount]` so a
stale or out-of-range client value cannot create a gap or silently fail; the
client's own running count is a UI convenience for computing the next default,
not a source of truth. Inserting between existing chapters shifts every chapter
at or after the target index by one `order_index`, in the same transaction as the
insert (D30's `createChapterAtOrder`).

---

---

## Phase 7

### D34: Docker build and Fly deploy were not executed

No Docker daemon is available in this environment. The Dockerfile and
`fly.toml` are a best-correct-effort, checked by inspecting the traced
`.next/standalone` output (see D35) rather than an actual `docker build` /
`flyctl deploy`. This is stated plainly rather than claimed as verified; the
user should run `docker build -t bookforge .` locally before a real deploy.

### D35: better-sqlite3's native binary confirmed present in the standalone trace

`next build` with `output: "standalone"` was run locally and
`.next/standalone/node_modules/better-sqlite3/build/Release/better_sqlite3.node`
was confirmed to exist, along with the package's JS wrapper and its own small
dependency set (`bindings`, `file-uri-to-path`, `detect-libc`). This confirms
`serverExternalPackages: ["better-sqlite3"]` (kept out of the JS bundle) still
gets traced into the standalone `node_modules` subset correctly. The caveat
recorded in the Dockerfile and DEPLOY.md: this only works when the binary is
compiled inside a Linux build stage; a host-built (Windows) `node_modules`
cannot be traced into a Linux runtime image, which is why the Dockerfile's
`deps` and `builder` stages both run `node:20-bookworm-slim`, not the host.

### D36: Backup directory is beside the database file, not a fixed cwd-relative path

SPEC's example (`backups/bookforge-YYYYMMDD-HHmmss.db`) does not fix whether
`backups/` is relative to the database file or the process's working
directory. Chosen: `dirname(dbPath)/backups`, so a production
`DATABASE_PATH=/data/bookforge.db` produces backups at `/data/backups/`, on
the same Fly volume mount, surviving restarts. A `./backups` relative to
`process.cwd()` would land on the container's ephemeral filesystem in
production, defeating the point of a backup.

### D37: fly.toml pins a single always-on machine

`min_machines_running = 1` and `auto_stop_machines = false`. SQLite on one
mounted volume is not safe for concurrent access from more than one machine;
Fly's default scale-to-zero / multi-machine behavior could start a second
machine against the same volume. This is a deliberate constraint of running
SQLite on Fly, not an oversight or missing feature.

### D38: The production auth gate blocks every path, not just protected ones

`mustBlockForMissingAuthConfig` in `src/middleware.ts` runs before the
public-path check, so `/login` and `/api/auth/login` also 503 in production
when `APP_PASSWORD`/`SESSION_SECRET` are unset, rather than rendering a login
form that will only fail at submit time. Chosen as the simplest compliant
reading of "the app must refuse to serve protected content": the
misconfiguration surfaces immediately (a Fly health check against `/login`
fails) instead of as a working-looking login page with a broken submit.

---

## Amendment A2 (2026-07-13): UI chapter numbering convention and sweep errors

### D39: One conversion module is the single boundary between 1-based UI and 0-based storage

Amendment A2.1 requires a unit-tested pair of helpers to be "the single place the
conversion happens". `src/lib/chapterNumbering.ts` exports
`orderToUiChapter(order) = order + 1` and `uiChapterToOrder(uiChapter) = uiChapter - 1`,
pure arithmetic, unit tested (both directions, round-trip, and the chapter-1 case).
Every conversion site imports from here, including the display sites that previously
inlined `orderIndex + 1` (the SweepRunner dropdowns and report, the sweep prompt's
chapter number, and the fallback `Chapter N` titles in the assembler, export,
lockFlow, the interrogate route, and the book pages). The Sequencer's row number
stays `index + 1`: it is a list ordinal over the rendered array, not a conversion of
a stored `order_index`, so routing it through the helper would misrepresent what it
is. The extraction approval path (`chapter_order = order_index + 1` in
`src/lib/repo/extraction.ts`) is internal 0-based arithmetic (a state effective from
the chapter after the locked one, D22) and is explicitly out of scope, so it was left
exactly as is.

### D40: The character-state form converts client-side; the states route keeps its 0-based contract

The amendment left the conversion boundary for the add-state form a judgment call
(client before POST, or in the states API route). Chosen: convert client-side in
`AddStateForm` (store `chapter_order = uiChapterToOrder(N)` in the request body) and
display timelines with `orderToUiChapter`. `POST /api/characters/[id]/states`
therefore keeps its existing contract: it receives and stores a raw 0-based
`chapter_order`, identical to the DB column and identical to the other writer of
`character_states` (the extraction-approve path, which also works in 0-based units).
The alternative (converting inside the route) would have made two writers of the same
table disagree on what the incoming number means and would have changed an API
payload's semantics. Keeping one storage semantic across all writers, with the
1-based convention living purely at the UI edge, is the simpler and safer boundary,
and it changes no API payload that any test or other code relies on.

### D41: The importer order field converts client-side too; the import route is unchanged

Symmetrically, `ImportPanel` now presents a 1-based position (1 = first), defaulting
to the next position at the end (existing count + 1), and converts with
`uiChapterToOrder` before the POST. `POST /api/projects/[id]/import` still receives a
0-based `orderIndex` and still clamps it to `[0, existingChapterCount]` server-side
(D33), so the server remains the source of truth for the clamp and the shift and no
route behavior changed.

### D42: A sweep continues past a failed chapter; failures carry reasons

Amendment A2.2. `SweepChapterReport` gains `error: string | null`. Each chapter's LLM
call in `runSweep` is wrapped in try/catch: on failure it pushes a report entry
naming the chapter and the error message and `continue`s to the next chapter, so one
chapter's failure never aborts the rest of the run (decision recorded and unit
tested: the run CONTINUES). Parse failures keep surfacing the raw model text
unchanged. `POST /api/projects/[id]/sweep` wraps `runSweep` and returns the underlying
message on a whole-run failure (`Sweep failed: <message>`, 500), and `SweepRunner`'s
client-side fallback now shows either the route's message or the HTTP status, so the
bare reasonless string "Sweep failed." is no longer reachable anywhere.

### D43: The A2 e2e spec warms the dev server in beforeAll

`a2.spec.ts` sorts before the phase specs, so it is the first file to hit the Next
dev server and pays the cold route-compile cost that the phase suite previously
absorbed with a lightweight first test. A `beforeAll` performs one full login and a
`/characters` visit with a generous timeout so the per-test 20s login helper never
races a cold compile. This is a warm-up only; no assertion, tolerance, or check was
weakened.

---

## Amendment A3 (2026-07-13): Series bible importer

### D44: The bible is chunked server-side in one POST, mirroring the sweep

SPEC A3 asks for long bibles to be processed as "sequential calls with a progress
indicator like the sweep's". The sweep (`runSweep`) does its sequential per-chapter
calls inside a single POST and the client shows a generic progress indicator; A3
follows the same shape. `runBibleImport` (`src/lib/bibleImport.ts`) splits the text
with `chunkBible`, runs one UTILITY_MODEL call per chunk in sequence (purpose
"bible", each logged to `llm_calls`), parses each defensively, and merges the
proposals from every chunk into one set returned by `POST /api/bible/import`. The
`BibleImportPanel` computes the chunk count for the progress copy the same way
`SweepRunner` computes its estimate. A single client-POST-per-chunk design was the
alternative; the single-POST server-side loop is the simpler match to the existing
sweep and keeps fixture routing straightforward. Per-chunk fixture routing (D25's
pattern): a single chunk uses the base key (`bible.<key>.json`), multiple chunks
suffix the 1-based position (`bible.<key>.<n>.json`); the real client ignores it.

### D45: `BibleImportPanel` is its own component, not a reuse of `ImportPanel`

Consistent with D32 (which chose a separate `ImportPanel` over reusing `LockPanel`),
the bible checklist is its own component. It has a genuinely different category set:
three sections (facts, characters, states) versus the importer's two, a scope
selector that hides the states section for a series-wide import, and a characters
section that renders create-vs-update proposals (with the fields that would change)
rather than the importer's evidence-quoted facts. Both components share the same
keyboard model (arrows move focus across all rows in order, a/r approve/reject the
focused row) and both submit only explicitly approved proposals to a server-side
approval gate. Extracting a shared low-level row component was weighed and rejected:
it would have meant editing the tested `ImportPanel` for marginal deduplication of
markup, against the same reasoning D32 recorded. The approval mechanism is one
implementation (`approveBible`); only the checklist markup around it differs.

### D46: The extraction prompt sees all locked canon and all tracked names, whatever the scope

To avoid duplicate proposals the bible prompt includes the current canon and the
tracked character names. `runBibleImport` passes all currently-locked canon facts
(`listCanon(db, { status: "locked" })`) and every tracked character name, regardless
of the chosen scope. Scope (series-wide or a book) determines only where approved
data lands, not what context the model reads; giving it the full locked canon is the
strongest dedup signal and the simplest rule.

### D47: The bible approval gate creates characters first, then resolves states, atomically

`approveBible` (`src/lib/repo/bible.ts`) runs entirely inside one transaction. It
creates or updates the approved characters first, then resolves every approved state
to a character id (explicit id, else case-insensitive name match, which now includes
the rows just created). This is what lets a state naming a not-yet-tracked character
be approved in the same batch as that character's creation (SPEC A3). If any approved
state still cannot resolve, an `UnmatchedStates` sentinel is thrown to roll the whole
transaction back, so nothing is created (not the characters, not the facts), and the
call returns the unmatched names, exactly the atomic-gate discipline of
`approveExtraction` (D27). Two sub-decisions: a character UPDATE proposal (one that
carries the id of an existing row) applies only its non-empty provided fields, so an
empty proposal field never wipes existing character data; and states hard-require a
book scope, enforced on the server (a series-wide scope with any approved state is
rejected) not only hidden in the UI. Approved facts become LOCKED canon with source
'bible' at the chosen scope (project_id null for series-wide); approved states land
at chapter_order 0 with source 'bible' (effective from the book's first chapter
onward).

### D48: One-time focus-on-load uses a latching ref, not an effect that fires on every toggle

`BibleImportPanel` focuses the first proposal row once when proposals arrive, using a
`focusedOnLoadRef` latch that resets only when the checklist is cleared. It
deliberately does NOT refocus row 0 whenever `facts`/`charRows`/`states` change (as a
naive effect keyed on those would), because that steals focus back to row 0 on every
approve/reject and breaks arrow navigation across the larger, three-section list.
`ImportPanel`'s equivalent effect does refocus row 0 on each toggle, a latent quirk
its narrower phase-6 sequence happens to tolerate (it only ever toggles the row it is
already on); it was left untouched to avoid disturbing a passing test.

### D49: The A3 e2e approves a world rule, a character, and a state, not the style note

Phase 1's canon test asserts exactly five locked `style_rule` facts (the seeds).
Approving a bible `style_rule` as a locked fact would make that count six and break an
unrelated, out-of-scope test. The A3 acceptance check only requires approving a
subset and verifying the approved items exist and the rejected ones leave no trace,
so the e2e approves the world rule (which also carries the assembled-prompt check),
the character, and the state, and leaves both the second world rule and the style
note rejected (both asserted absent). This is a test-design choice to avoid coupling
to another phase's fixed count, not a narrowing of the A3 gate.

## Amendment A4 (2026-07-13): Token efficiency without losing quality

### D50: Cacheable blocks built in a pure function; the SDK types are bridged with a cast

A4.1 needs `cache_control` on the system and prefix content blocks and needs the
`cache_creation_input_tokens` / `cache_read_input_tokens` usage fields. The installed
`@anthropic-ai/sdk` (0.32.1) types these only on the beta endpoint, not on the
non-beta `messages.create` / `messages.stream` this app uses; prompt caching is GA at
the API level, so the fields are runtime-valid on the standard endpoint. Rather than
switch the whole app to the beta namespace, `buildMessageRequest`
(`src/lib/llm/client.ts`) is a pure, exported, unit-tested function that builds the
block shape (system and prefix as `{type:"text", cache_control:{type:"ephemeral"}}`
blocks, remainder uncached; no prefix returns the old plain-string shape), and the
real client passes those blocks through a narrow `as unknown as string` cast (a string
is assignable to the SDK's `string | TextBlockParam[]`), reading cache usage through a
widened `UsageWithCache` shape. The pure function is what the tests exercise; the cast
is the only place the SDK's stale types are worked around, documented at the call site.

### D51: The assembler stable prefix carries the block separator so prefix + remainder is byte-identical

`assemblePrompt` now exposes `stablePrefix` (the first four blocks: CANON, CHARACTERS,
STORY SO FAR, PREVIOUS CHAPTER) and `variableRemainder` (CURRENT CHAPTER, TASK). To
guarantee the cached path shows the model exactly the same bytes as the old
single-string path, `stablePrefix` ends with the `"\n\n"` that used to join the two
halves, so `stablePrefix + variableRemainder === prompt` exactly. The draft route
passes `promptPrefix: stablePrefix, prompt: variableRemainder`; the API concatenates
the two content blocks with no inserted separator, reconstituting the original prompt.
The four/two split is where the content stops being stable across scene-by-scene draft
calls (current-chapter drafted-so-far and the marked beats change every call).

### D52: The revision cache prefix is system + chapter text

For revision, the chapter text is the large stable block and the flagged spans plus
task are the small variable remainder, so `promptPrefix` is the chapter text and the
system prompt is cached separately. Both the em-dash retry and the patch-JSON retry
reuse the cached system + chapter text and only resend the short remainder. Patch mode
and full mode share the same `chapterPrefix`.

### D53: Existing full-text tests keep exercising full mode via a same-key patch retry then fallback

Patch mode is the default; the route falls back to full-text mode when the patch JSON
fails to parse after one patch-mode retry. That retry deliberately reuses the SAME
`fixtureKey` (not a `.retry` suffix, unlike the em-dash retry). Consequence: a fixture
whose content is a full-text revision (the existing `revision.phase4.json` and
`revision.emdashrev.json`) parses as "not a patch envelope" on both the first attempt
and the same-key retry, so the route falls back and makes a fresh full-text-contract
call using that same base fixtureKey, running the OLD full-text path (extract
consistency fixes, em-dash lint with the `.retry` key, analyzeRevision) byte-for-byte
as before. This is why `phase4.spec.ts` and the Phase 4 em-dash test pass UNCHANGED
with no new fixtures and no spec edits: their fixtures are full-text, so they always
take the fallback path. New patch fixtures (`revision.a4patch.json`) return a valid
envelope on the first attempt and never retry or fall back. The extra fixture reads on
the fallback path are harmless (fixtures are static files); token logging sums all
calls into one `llm_calls` row.

### D54: Patch mode uses complete(); full mode keeps streaming; the client buffers either way

`ReviewEditor.revise()` reads the entire response body before locating the trailing
control frame; it never renders streamed revision prose incrementally. So the mode's
transport does not matter to the client: patch mode uses non-streaming `complete()`
(SPEC A4.2 permits it) and full mode keeps the existing `stream()` behavior (SPEC
requires it). Both end the same way, with `CONTROL_DELIM` + a JSON control frame that
now carries `mode` and `failedPatches`. The UI shows an in-progress note while
revising (defaulting to the patch-mode wording, since patch is the default), the mode
that ran once the frame arrives, and any failed patches.

### D55: Both fallback routes make a full-text-contract call; justifications are the declared entries

The two fallbacks (flagged coverage > 40%, decided before any call; and patch JSON
unparseable after one retry) converge on the same behavior: a full-text-contract call
(system = `revisionSystemPrompt`, the old `## FLAGGED SPANS` / `## TASK` remainder)
whose output flows through the unchanged `extractConsistencyFixes` + `analyzeRevision`
path. In patch mode, `applyPatches` produces the revised full text mechanically and the
justifications of the applied `consistency_fixes` are passed as the `consistencyFixes`
string array to the UNMODIFIED `analyzeRevision`, so a `patch` touching an unflagged
span is UNAUTHORIZED while a declared `consistency_fix` is DECLARED, reproducing Phase
4's classification exactly. `analyzeRevision` and `applyResolution` are untouched, and
the revisions table stores the same `{oldText, newText, flaggedSpans, consistencyFixes}`
so `/resolve` recomputes identically for both modes.

### D56: Patch-mode em-dash lint targets replacements; failed anchors are collected, not fatal

In patch mode the model only authors the replacement text (originals are verbatim
copies of existing chapter prose), so the em-dash lint checks the patch and
consistency-fix REPLACEMENTS (`replacementsHaveEmDash`). A dirty replacement triggers
one patch-mode retry (the `.retry` fixtureKey); if it is still dirty the revision
proceeds but sets the existing `emDashUnresolved` warning. `applyPatches` anchors each
`original` with the same `findSpan` the classifier uses, applies non-overlapping
anchors offset-safely (resolve against the original text, sort by position, splice left
to right, so order does not matter), and collects any patch whose anchor is absent or
overlaps an already-accepted one as a `failedPatch` while the rest still apply. Failed
patches surface in the control frame and the UI; they do not abort the revision.

### D57: A dev-only llm_calls readback route backs the token-efficiency assertion

`GET /api/dev/llm-calls` (disabled in production, mirroring `/api/dev/prompt`) returns
recent `llm_calls` rows filtered by chapter and purpose. The A4 e2e asserts, through
it, that the patch revision's logged `outputTokens` is a small fraction of the
chapter's character count (a full rewrite of the ~600 char chapter would log well over
100 output tokens; the patch envelope logs 48). This was the simplest compliant way to
assert the token win end to end without weakening any existing check.

## Amendment A5 (2026-07-13): Character chatbots

### D58: The chat prompt splits into a fixed system and a cacheable character-context prefix

SPEC A5 requires the character context to be the A4.1 cacheable prefix and the
running transcript plus new message to be the variable remainder. `buildChatContext`
(`src/lib/chat.ts`) therefore returns three parts: a `system` string holding the fixed
knowledge-hygiene and voice rules (character-agnostic template, filled only with the
character name for readability, so it is stable across turns and cacheable); a
`contextPrefix` string holding the character card, the effective state as of the pin,
the locked style rules, the locked character_fact canon mentioning the character, and
the knowledge-horizon chapter summaries (the promptPrefix); and the remainder is built
separately by `buildChatRemainder` from the transcript and the new message. The route
passes `system`, `promptPrefix: contextPrefix`, and `prompt: remainder`, so every turn
after the first reads the cached system + context and resends only the short tail. The
dialogue-subtext rule comes from including the locked style_rule facts in the context;
the character's own voice_rules ride in the character card. This keeps the whole
context assembly in one pure, importable module with no route, streaming, or
persistence concerns, so A6's MCP server can reuse it unchanged.

### D59: The pure module returns structured pieces alongside the rendered strings

`buildChatContext` returns `effectiveState`, `characterFacts`, `chapterSummaries`, and
`styleRules` in addition to the rendered `system` and `contextPrefix`. This lets the
unit test assert the context-boundary semantics directly (the chapter-1 state is
present and the chapter-4 state absent at pin 3; summaries stop at the pin; character
facts are scoped and name-filtered) rather than only string-grepping the prefix, and
it gives A6's `character_chat` tool the same structured data without re-deriving it.
The rendered strings are still asserted too (hygiene rules, `[MISSING FACT]`, no
em-dash), since those are what the model actually receives.

### D60: A dev-only table-name route backs the no-transcript assertion

SPEC A5's acceptance check says the database must contain no chat transcript and
offers "sqlite table list has no chat table" as the simplest compliant assertion.
`GET /api/dev/tables` (`src/app/api/dev/tables/route.ts`, disabled in production like
`/api/dev/prompt` and `/api/dev/llm-calls`) returns the SQLite table names from
`sqlite_master`, and the e2e asserts none matches `/chat|transcript|message/i`. This
is the least invasive way to prove non-persistence end to end without opening the DB
file from the test process or coupling to `DATABASE_PATH`. No chat table, migration,
or repo write path was added; the route only ever calls `logLlmCall` (a cost row,
purpose "chat", chapterId null) and the read-only `buildChatContext`.

### D61: Propose-as-fact prefills the full reply, defaults character_fact / pinned book / provisional

SPEC A5 leaves the propose-as-canon-fact form's exact prefill a judgment call ("the
reply or a selection of it"). Chosen: the editable content textarea is prefilled with
the full reply text, and the author trims it to a selection by hand if they want less;
this is the simplest compliant behavior and keeps the whole reply available. The type
selector defaults to character_fact (the chatbot's subject), the scope selector
defaults to the pinned book (with a series-wide option), and the POST to the existing
`/api/canon` sets status `provisional` and source `chat:<characterId>`. Nothing
auto-locks; the fact must pass the normal canon lock flow, so the approval gate is not
softened and chat cannot write locked canon.

### D62: Chat reuses the drafting stream protocol and em-dash discipline verbatim

The chat route streams on the same `CONTROL_DELIM` sentinel protocol as the draft
route (raw prose chunks, then a JSON control frame), reuses `extractMarkers` to strip
and surface `[MISSING FACT]` lines, and applies the same em-dash lint (hard reject,
regenerate once with an explicit instruction on the `.retry` fixtureKey, then set
`emDashUnresolved` and never silently accept). Mirroring the established path rather
than inventing a chat-specific protocol keeps the client consumption identical to the
draft editor's and keeps the forbidden-character rule enforced on the chat path too.
The reply is non-persisted; only a cost row is logged.

## Amendment A7 (2026-07-13): Claude Code auth as the default LLM transport

### D63: Transport selection is USE_FIXTURE_LLM, then LLM_TRANSPORT defaulting to claude-code

`getLlmClient` selects in priority order: `USE_FIXTURE_LLM=1` always returns the
unchanged `FixtureClient` (the automated loop never makes real calls); otherwise
`LLM_TRANSPORT` chooses the transport. Only the explicit value `api-key` selects the
existing `AnthropicClient`; every other value, including unset, selects the new
`ClaudeCodeClient`. Defaulting unknown values to claude-code (rather than throwing)
is the simplest compliant option and matches the SPEC's "claude-code is the default".
The three client classes are now exported so the selection matrix can be unit-tested
with `instanceof`; their behavior is otherwise unchanged.

### D64: The claude-code transport spawns the resolved claude.exe with shell:false

On Windows, modern Node (verified on v22.14.0 here) refuses to spawn a `.cmd`/`.bat`
with `shell:false` (EINVAL), and `shell:true` mangles empty-string and multi-line
argv entries, which we need for `--tools ""` and `--system-prompt`. So binary
discovery prefers a real `.exe` spawned with `shell:false`: `CLAUDE_CODE_BIN`
overrides everything; otherwise on win32 we search PATH for `claude.exe`, then read
the npm `claude.cmd` shim to recover the nested `claude.exe` it launches (verified:
the shim is `"%dp0%\node_modules\@anthropic-ai\claude-code\bin\claude.exe" %*`), and
only fall back to a shell as a last resort. With `shell:false` and an argv array, the
system prompt passes as one argv entry with no quoting and no temp file needed (the
SPEC's temp-file escape hatch proved unnecessary). Non-win32 spawns `claude` directly.

### D65: Prompt over stdin, system prompt REPLACED, tools off, single-turn, no sessions

`buildCliArgs` produces `--print --model <m> --max-turns 1 --no-session-persistence
--tools "" --output-format json|stream-json` (plus `--verbose
--include-partial-messages` for streaming, since `--print` with `stream-json` requires
`--verbose` on the installed CLI), and `--system-prompt <text>` when a system prompt is
given. `--system-prompt` REPLACES the default Claude Code system prompt (never
`--append-system-prompt`) so prose calls do not inherit the tool-oriented default;
verified by a real call where a persona system prompt produced a fully in-character
reply with no mention of Claude Code. `--tools ""` disables every built-in tool. The
assembled prompt (`promptPrefix + prompt`) is written over stdin, never as an argv
argument, because assembled prompts exceed Windows argv length limits.

### D66: promptPrefix is concatenated; cache_control is an api-key-only detail

The claude-code transport concatenates `promptPrefix + prompt` into the stdin payload
so the model sees a prompt byte-identical to the api-key transport. Block-level
`cache_control` breakpoints (A4.1) remain an api-key-only detail; Claude Code applies
its own caching, and the `cache_creation_input_tokens` / `cache_read_input_tokens` it
reports flow into `CompleteResult.cacheWriteTokens` / `cacheReadTokens` and thus into
`llm_calls` exactly as in A4.1.

### D67: maxTokens is not enforceable on the claude-code transport

The installed CLI (2.1.207) exposes no output-token cap flag (only `--max-budget-usd`,
a dollar cap, not a token cap). So `maxTokens` is honored on the api-key transport but
is a no-op on the claude-code transport. Documented in `.env.example` and DEPLOY.md
rather than silently ignored. No env escape hatch exists for an output-token cap; the
per-call time bound is `CLAUDE_CODE_TIMEOUT_MS` (default 600000ms / 10 minutes).

### D68: Timeouts are non-transient; spawn and non-4xx CLI errors are transient

`ClaudeCodeError` carries a `transient` flag driving the retry-once wrapper, which
mirrors `AnthropicClient.withRetry` and wraps only `complete()` (a partially streamed
generator cannot be safely replayed, matching `AnthropicClient.stream`, which also does
not retry). Spawn-level failures (ENOENT/EINVAL and other launch errors) and CLI
`is_error` results without a 4xx `api_error_status` are transient (retried once); a 4xx
status (auth or bad request) is non-transient. A per-call timeout is non-transient: it
kills the child and surfaces immediately rather than risking a second full timeout.
Spawn ENOENT/EINVAL surfaces a clear message naming the fixes (install the CLI and log
in, set `CLAUDE_CODE_BIN`, or set `CLAUDE_CODE_OAUTH_TOKEN`).

### D69: llm-smoke runs via tsx and loads .env.local with a minimal parser

`scripts/llm-smoke.mjs` (npm run `llm-smoke`) is run with `tsx` so it can import the
TypeScript client, and loads `.env.local` with a tiny inline KEY=VALUE parser because
standalone scripts do not get Next's env loading and this repo has no dotenv dependency
(same reasoning as `backup.mjs` duplicating DB-path logic). It makes one real call
through the selected transport, prints the transport, reply, and token/cache usage, and
exits nonzero with the clear error message on failure. It is not part of `npm test`.

## Amendment A5.1 (2026-07-13): Chat fixes from the live test drive

### D70: The A5.1a rules are an explicit "Speaking" block in the chat system prompt

The pre-A5.1 prompt already said "You speak in the first person" in passing. A5.1a
requires the three corrections to be explicit and unit-asserted, so `chatSystemPrompt`
(`src/lib/chat.ts`) gained a dedicated "Speaking, all mandatory" block: first person
ONLY; no third-person stage directions or narration about oneself (the drive produced
"She pulled the edge of her left glove straighter"); and no reference to the author or
anyone outside the conversation except the `[MISSING FACT]` marker line (which is
explicitly called out as the sole exception). `chat.test.ts` asserts each rule is
present in the assembled `system` string. The `buildChatRemainder` "Author:" speaker
labels are the context handed TO the model, not the character speaking, and are
unchanged; the rule constrains the character's reply.

### D71: Pin validation lives in one pure helper used by client, route, and MCP

A5.1b needs the pinned chapter clamped to [1, chapter count of the selected book] in
three places. `src/lib/chatPin.ts` (pure, unit tested) is the single source:
`validatePinChapter(uiChapter, chapterCount)` returns `{ valid, min, max, clamped }`
and `pinRangeLabel` renders "1 to N". `CharacterChat.tsx` clamps on submit and shows
the range (the page passes a per-book `chapterCount`); the chat route rejects an
out-of-range pin with a 400 before building any context; the MCP `character_chat` tool
throws the same clear error. "Number of chapters in the selected book" is read as the
book's total chapter count (`listChapters(...).length`), matching the reported "chapter
13 in a four-chapter book" scenario. A book with no chapters cannot be pinned. The
conversion to 0-based order still happens once, inside `buildChatContext`, unchanged.

### D72: A5.1b test coverage is unit + route + one free e2e line

The task allowed unit coverage plus the route check when an e2e is not cheap. Chosen:
`chatPin.test.ts` (8 cases, including the exact reported bug and the inclusive bounds)
covers the helper; the route and MCP tool both call it and are covered by
`mcp-server.test.ts`'s out-of-range assertion; and one no-new-setup assertion was added
to the existing `a5.spec.ts` (the valid-range hint renders for the selected book).
Adding a full new e2e for the clamp was not worth the cold-compile flakiness this
sandbox has; the added line rides setup that already exists.

## Amendment A6 (2026-07-13): MCP server

### D73: Tool handlers are exported for in-process tests; the spawn test is the acceptance

`src/mcp/tools.ts` exports `TOOL_DEFS` (each `{ name, description, inputSchema (Zod
raw shape), handler(ctx, args) }`), `TOOL_NAMES`, and `registerTools(server, ctx)`.
The handlers are plain functions over an injected `{ db, client, draftModel,
utilityModel }` context, so they are unit-testable in-process against an in-memory DB
with a stub client (`mcp-tools.test.ts`), and `registerTools` wraps each on the SDK's
`McpServer` (turning a thrown error into an MCP tool error carrying the message). The
SPEC acceptance test (`mcp-server.test.ts`) spawns the real server over stdio. Both run
under `npm test`. The in-process tests are fast coverage, NOT a fallback: the spawn
test worked on the first real attempt.

### D74: The spawn test launches node --import tsx directly, not npx/tsx via a shim

To dodge the Windows `.cmd` shim problems A7 documented (D64: modern Node refuses to
spawn a `.cmd` with `shell:false`, which is what the MCP SDK's `StdioClientTransport`
uses via cross-spawn), the acceptance test spawns `process.execPath` (node.exe) with
`["--import", "tsx", "src/mcp/server.ts"]`. That runs the TypeScript server through
tsx's loader while spawning node directly, so there is no `.cmd` in the chain. It
connected and drove all tools cleanly, so the SPEC's "fall back to in-process plus one
spawn smoke assertion" escape hatch was not needed.

### D75: LLM-calling tools take no fixtureKey; base fixtures back the acceptance test

The web routes accept a `fixtureKey` in their body for tests. The MCP tools do NOT
expose one, to keep the tool surface clean for real agents. Instead the fixture-routed
LLM tools load their base fixture by purpose, so `tests/fixtures/draft.json`,
`chat.json`, and `sweep.json` were added (`interrogation.json` already existed) as
test-only data read only under `USE_FIXTURE_LLM=1`. `draft.json` carries a
`[MISSING FACT]` line so marker extraction is verifiable; `sweep.json` carries one
contradiction. This keeps the fixture mechanism unchanged and the tool inputs free of
test-only parameters.

### D76: MCP-created canon facts and states are sourced "mcp"

`canon_add` and `character_add_state` record `source: "mcp"` for provenance, distinct
from `seed` / `manual` / `interrogation:<id>` / `extraction:<id>` / `bible` /
`chat:<id>`. Nothing filters on these two sources (assembly keys on status, unlock
keys on `extraction:<id>`), so "mcp" is safe and makes agent-created rows visible in
the DB. `answer_question` keeps the route's `interrogation:<chapterId>` source so its
plot_decision fact is indistinguishable from the UI's.

### D77: interrogate_chapter runs the interrogation call, mirroring the route

"interrogate_chapter (returns the stored questions)" is read as: run the interrogation
flow like `POST /api/chapters/[id]/interrogate` (UTILITY_MODEL, store the questions,
move the chapter to `interrogating`) and return the stored questions, not merely read
back questions a UI already generated. Otherwise there would be no way to generate
questions through MCP and `answer_question` would have nothing to answer. It is an
LLM-calling tool and logs to `llm_calls` with purpose "interrogation".

### D78: The hard boundary is enforced by omission, not by a guard

The human-only gates (approve extraction/bible, resolve revision hunks, lock/unlock a
chapter, import a chapter) are simply not in `TOOL_DEFS`, so the server never registers
them and a confused agent cannot invoke one. `chapter_update` patches only title, pov,
synopsis, and beats; status and summary are absent from its schema, so it cannot lock,
unlock, or re-summarize a chapter. A comment block in `src/mcp/server.ts` names the
boundary and its rationale (the SPEC quality bar: never soften the diff-enforcement and
approval gates). Both `mcp-tools.test.ts` and `mcp-server.test.ts` assert the forbidden
names are absent (by regex and by exact name) and that the registered set is exactly
the SPEC A6 list. canon_lock and canon_retire remain, since locking a canon FACT is an
explicit SPEC tool (not a chapter lock).

### D79: 1-based conversion happens at the tool boundary; beats convert inline

Every chapter number in tool inputs/outputs is 1-based (A2), stated in each tool
description. Chapter conversions go through `orderToUiChapter` / `uiChapterToOrder`
(the single chapterNumbering module): `character_add_state`, `chapters_list`,
`chapter_get`, `chapter_create`, `sweep_book`'s range, and every state timeline row.
Beat numbers are also 1-based per SPEC A6, but beats are a different axis from chapters
(a beat index into a chapter's array, not a stored `order_index`), so `draft_scene` and
`assembled_prompt` convert beat number to 0-based index with an inline `n - 1` and a
comment, rather than routing an unrelated axis through the chapter helper.

### D80: The .env.local loader is extracted and shared

The minimal `.env.local` parser was lifted out of `scripts/llm-smoke.mjs` into
`src/lib/loadEnvLocal.ts` (same logic: sets only keys absent from `process.env`, strips
matching quotes, no interpolation) and is now imported by both the llm-smoke script and
`src/mcp/server.ts`, so the two standalone entry points parse `.env.local` identically,
satisfying the SPEC A6 "loads .env.local the way llm-smoke does" requirement by genuine
reuse rather than a second copy.

---

## Amendment A8 (2026-07-13): Per-purpose model routing

### D84: One resolver is the sole reader of DRAFT_MODEL / UTILITY_MODEL

`src/lib/modelFor.ts` is the single place the env vars are consulted. Every prior
call site (draft, revise, interrogate, chat, sweep routes; lockFlow summary and
extraction; bibleImport; and the four LLM-calling MCP tools) now calls
`modelFor(db, purpose)` and passes the resolved string into both the client call and
`logLlmCall`. No route, lockFlow, sweep, bibleImport, chat, or MCP file keeps a
private `process.env` read, and `grep -rn "DRAFT_MODEL\|UTILITY_MODEL" src/` shows
hits ONLY in `modelFor.ts`. Comment and MCP-description mentions of the env-var names
elsewhere were reworded to satisfy the same grep constraint. `runSweep` already took
a `model` parameter, so its caller resolves and passes it (and `runSweep` logs that
model per chapter); nothing else about the sweep changed.

### D85: Precedence is override, then env default, then hardcoded fallback

`resolveModel(db, purpose)` returns `{ model, source }`: a settings override
(`model.<purpose>`) if present and non-blank wins (source "override"); else the
purpose's env default (source "env"); else `claude-sonnet-4-6` (source "fallback").
Env grouping per SPEC A8: draft and revision read DRAFT_MODEL, the other six read
UTILITY_MODEL. A blank env var or a blank override is treated as absent, so a
whitespace value never masks the next level. An unknown purpose throws a clear error
rather than silently falling back, so a typo fails loudly. `model_test` is a real
`LlmPurpose` (the Test button) but is deliberately NOT one of the eight routable
purposes: the Test button uses the user-entered model directly, so `modelFor` rejects
"model_test" like any other unknown purpose.

### D86: The MCP ToolCtx drops its fixed model strings

A6's `ToolCtx` carried `draftModel` / `utilityModel` computed once at server start.
A8 removes both fields; each LLM-calling tool now resolves its model per call via
`modelFor(ctx.db, purpose)`, so an override set in the web UI takes effect on the next
MCP call without restarting the server. `server.ts` no longer reads the env vars. The
in-process tool test's context was updated to `{ db, client }`.

### D87: PUT /api/settings/models sets or clears one purpose; blank clears the row

The write route takes `{ purpose, model }`. A non-blank string upserts
`model.<purpose>`; a null, omitted, or blank model deletes the row (revert to the env
default), matching SPEC A8's "clearing = deleting the row". Both GET and PUT return
the full purpose map (`modelMap`) so the client refreshes from the server's own
resolution rather than guessing. `PUT` rejects an unknown purpose with a 400.

### D88: The Test button call is one tiny non-cached complete() with the model_test fixture

`POST /api/settings/models/test` makes ONE `complete()` call through the ACTIVE
transport with purpose "model_test" and the entered model, logs it to `llm_calls`
(purpose "model_test", model recorded) like every other call, and returns
`{ ok:true, replySnippet, usage }` or `{ ok:false, error: <verbatim message> }`. The
error is passed through verbatim so an unentitled or misspelled model id fails at
settings time with the transport's real message, not a mid-draft surprise. The
automated loop stays fixture-only: `tests/fixtures/model_test.json` backs the Test
button in e2e; the real invalid-model error path is verified manually against the
real transport (SPEC A8), not in the loop.

### D89: A8 e2e uses the existing dev llm-calls readback and the fixture draft flow

`tests/e2e/a8.spec.ts` sets a draft override on /settings, runs the existing
`?fx=clean` fixture draft, and asserts via `/api/dev/llm-calls?chapterId&purpose` that
the draft row logged the override while an interrogation call (no override) logged the
env default; then Reset restores the env default and the next draft logs it; a second
test clicks the Test button and asserts the fixture snippet. The dev readback route
needed no change: `recentLlmCalls` selects all columns, so the new `model` column
flows through automatically. The test resets its own override so it leaves no global
settings state for later specs (and model overrides are inert under the fixture client
anyway, which ignores the model).

---

## Canon filter race fix

### D81: No new unit test for the CanonManager sequence guard

Fix for a diagnosed E2E-reproducible race: `CanonManager.tsx`'s `load()` fetched
`/api/canon` on every filter change with no request sequencing, so a late response
for an earlier (now-stale) filter combination could overwrite a fresher, correctly
filtered response and silently show stale data. Fixed with a monotonically
increasing request id held in a `useRef`; each `load()` call captures its own id and
only applies its response if that id is still the latest when the fetch resolves.

Audited every other list component in `src/components` for the identical shape (a
load/fetch keyed to multiple independently user-changeable filter states, fired on
every change with no sequencing). None match: `CharactersManager.tsx`'s top-level
`load()` has empty `useCallback` deps (fires once on mount plus after each create
action, never concurrently from user input); its `CharacterCard`'s `loadStates()` is
keyed to the stable `character.id` and only refires on `expanded` toggling, not on a
changing query; `Sequencer.tsx`'s `load()` is keyed to `projectId`, fixed per page.
Only `CanonManager.tsx` was changed.

No new unit test was added. This repo deliberately has no React component-testing
library installed, and the guard is a closure over component state/refs, not a pure
function worth extracting for one narrowly-scoped fix. Instead,
`tests/e2e/phase1.spec.ts` ("seeded style rules render as locked") was strengthened
to wait for the specific type+status filtered `/api/canon` response before asserting
(mirroring the existing wait pattern in `tests/e2e/phase2.spec.ts` "reorder persists
across reload"), which is a genuine regression test for this exact race: it fails
without the guard and passes with it. Simplest compliant fix; no assertion weakened.

---

## Login navigation race fix (cold-start flake cluster, follow-up)

### D82: router.refresh() removed from the login success path

The login page ran `router.push("/canon")` immediately followed by
`router.refresh()`. The refresh re-fetches the CURRENT route and can cancel the
in-flight push navigation on a slow (cold dev) server: warm servers win the race,
cold ones lose it, leaving the URL stuck on /login for 30+ seconds even though the
login API returned 200 and the cookie was set (independently reproduced in a manual
browser session: POST 200, no navigation). Fixed by removing the `refresh()` call
entirely rather than sequencing it after the navigation: pushing to a new route
fetches fresh server components anyway, so the refresh was redundant, and removal
is the simplest compliant fix. A comment at the call site says why refresh must not
be reintroduced. The hardened `tests/e2e/helpers.ts` `login()` (pre-hydration click
retry until the API responds, plus diagnostic breadcrumb) covers the OTHER layer of
this cluster and was deliberately left exactly as hardened.

### D83: phase2's reload assertion waits for the rows instead of re-running

The first fully cold validation run after D82 failed
`tests/e2e/phase2.spec.ts` "reorder persists across reload" with
`indexOf` returning -1 for BOTH titles. The failure snapshot showed both chapter
rows present and in the correct order at failure time, so the product was correct;
the test read `allInnerTexts()` immediately after `page.reload()`, and
`allInnerTexts` does not auto-wait, so on a cold server it captured the client-side
list before the rows rendered. Strengthened, not weakened: two strictly additional
`toHaveCount(1)` waits for the two rows now precede the order check, and the order
assertion itself is byte-for-byte unchanged. Chosen over re-running until green
(hides the race) and over a fixed timeout (slow and still racy).

## Deferred feature idea (recorded, not built)

### CLI session reuse for chat caching (from A5.1)

Update 2026-07-14: built as Amendment A10. See D98 and D99.

SPEC A5.1 deferred: per-conversation reuse of the `claude` binary's resume capability so
chat turns on the claude-code transport hit the provider cache. The live drive measured
cache writes every turn but zero reads across one-shot spawns (each turn is a fresh
`claude` process, so the provider cache from the prior turn is never read).

## Amendment A10: chat session reuse on the claude-code transport

### D98: Route asks hasSession; the transport owns all session state

The conversation-to-session mapping lives entirely inside ClaudeCodeClient (an
exported, bounded SessionStore: 64 entries, oldest-first eviction). The chat route
only asks the optional `LlmClient.hasSession(key)` before assembling the prompt:
true means it sends a minimal resume remainder (the new author message alone),
false means the full transcript remainder exactly as before. The fixture and
api-key clients do not implement hasSession, so every fixture-driven test and the
api-key transport behave byte-identically to pre-A10. The alternative (the route
holding session ids) was rejected: it would leak a transport detail into a route
and into client state.

Recovery is lossless by construction: the chat client still sends the full
transcript every turn, so an evaporated CLI session (restart, cleanup, eviction)
just means the next turn re-seeds a fresh session from the transcript. A resumed
call that fails with the CLI's "No conversation found with session ID" text drops
the entry and retries fresh once (complete() always; stream() only when nothing
has been yielded yet, so the restart is invisible). The worst case is one turn
answered without prior-transcript context.

### D99: Resumed calls never re-pass the system prompt

Verified against the installed CLI (2.1.209) before coding, per the A7 rule: a
resumed session retains the original `--system-prompt`, returns the same
session_id, and reports nonzero cache_read_input_tokens; resuming a missing
session fails fast on stderr (json mode) and in the result event's `errors` array
(stream-json mode). buildCliArgs therefore omits `--system-prompt` and
`--no-session-persistence` when resuming, and parseCliResult folds the `errors`
array into the thrown detail so both failure shapes are detectable from the error
message. The MCP character_chat tool stays stateless (callers pass the transcript
each call): a session per MCP caller would need a conversation identity the tool
contract does not have.

## Amendment A9: design pass with dark mode

### D90: Semantic tokens as CSS-variable RGB triplets, mapped into Tailwind

Colors are defined once in `src/app/globals.css` as `--name: R G B` triplets,
light on `:root` and dark on `.dark`, and mapped in `tailwind.config.ts` with
`rgb(var(--name) / <alpha-value>)` so Tailwind opacity modifiers still work. The
triplet form (not `#hex`) is what makes `bg-warn/50` and `text-ink/70` possible.
`globals.css` and `tailwind.config.ts` define the tokens and are exempt from the
repo check by nature.

The token vocabulary (small and semantic):

- Surfaces: `paper` (page), `surface` (cards, inputs, pre blocks), `inset`
  (recessed grouping panels), `chip` (pills and tags).
- Text: `ink` (primary, full contrast), `muted` (secondary chrome), `faint`
  (captions, meta, labels).
- Lines: `edge` (interactive borders), `edge-soft` (card borders and dividers;
  also the bare-`border` default via `borderColor.DEFAULT`).
- Accent: `accent` (primary action fill), `accent-ink` (label on accent),
  `accent-hover`.
- `focus` (the keyboard focus ring, a calm slate-blue in both themes).
- Alert families `warn` (amber), `info` (sky), `danger` (red), `ok` (green), each
  with `DEFAULT` (fill), `ink` (text), `edge` (border), `chip` (badge fill);
  `danger` and `ok` add `strong` for the selected accept/reject borders.

### D91: The accent is a monochrome inversion (no new hue)

Primary buttons stay monochrome: light uses a near-black fill with paper-colored
ink; dark inverts to an off-white fill with dark ink. A near-black button would
vanish on the dark paper, so inversion is the simplest compliant option that keeps
"quiet confidence" without introducing a brand hue. Recorded per the ambiguity
rule. The only hue introduced anywhere is the focus ring (`focus`), which is a
standard accessibility affordance, not decoration.

### D92: Dark theme keeps full contrast on reading surfaces, reduced on chrome

Dark `ink` is a warm off-white (`236 232 224`) on warm dark-gray `paper`
(`26 25 23`, never pure black), so the draft textarea, review prose, chat, and
summaries stay high-contrast for reading. `muted`/`faint` and `edge` are pulled in
for chrome so navigation and borders sit back. Alert fills are darkened and their
`ink` lightened for dark legibility.

### D93: The migration was a deterministic 1:1 class swap, scripted then verified

`scripts/a9-migrate.mjs` applied exact-substring replacements (raw palette class to
token class) across `src/app` and `src/components`, so the sweep is auditable and
re-runnable rather than hand-edited file by file. The forbidden list in the repo
check (`tests/unit/a9-tokens.test.ts`) matches exactly what was migrated: `bg-white`,
`text-white`, and the `neutral` / `amber` / `sky` / `red` / `green` scales across
`bg-`, `text-`, `border-`, and `divide-`. Text neutrals collapsed by role
(700/800/900 to `ink`, 500/600 to `muted`, 400 to `faint`); the four alert palettes
collapsed their text shades to a single `*-ink` per family. Button hierarchy became
consistent recipes: primary is `bg-accent hover:bg-accent-hover text-accent-ink`,
secondary is `border border-edge`, quiet is `text-muted hover:text-ink`, destructive
is `text-danger-ink`; the four are also available as `.btn-*` classes in the
components layer (used by the theme toggle).

### D94: Theme persisted in a plain year-long cookie, read server-side for no flash

`bookforge_theme=dark|light` is a plain (not httpOnly) cookie, `path=/`, one year,
so the client toggle in `TopNav` (`ThemeToggle.tsx`, `data-testid="theme-toggle"`)
can both flip `document.documentElement`'s `dark` class immediately and write the
cookie. The root layout is `async` and reads the cookie with `next/headers`
`cookies()`, stamping `class="dark"` on `<html>` at server render, so there is no
flash. `/login` is public and wrapped by the same layout, so it is themed pre-auth
with no middleware change. The toggle lives only in `TopNav` (authed chrome); the
login page has no toggle, matching the SPEC wording ("toggle in the top navigation").

### D95: Focus rings via a global focus-visible outline plus explicit rings on rows

A base rule in `globals.css` gives every interactive element (and `[tabindex]`) a
`focus-visible` outline in the `focus` color, so focus is visible everywhere in both
themes without editing every element. The keyboard-driven approval rows in
`ImportPanel` and `BibleImportPanel` additionally carry
`focus-visible:ring-2 focus-visible:ring-focus` (their old `focus:border-neutral-500
focus:outline-none` recipe was replaced), and `LockPanel`'s `tabindex` rows rely on
the global outline. This satisfies the SPEC requirement that the approval checklists
show focus clearly.

### D96: Reading measure bounded at 70ch on the draft and review surfaces

The draft textarea and review prose get `max-w-[70ch]` plus `bg-surface` and
`text-ink`, so long chapters read at a comfortable measure on wide screens. Chat
already sits in a `max-w-2xl` column. Empty states for canon, characters, chapters,
and comments were warmed from bare gray one-liners to a sentence plus the obvious
next action; all `data-testid` and aria labels are byte-identical so the e2e suite
is undisturbed.

### D97: Favicon is an inline SVG data URI, not a served file

A minimal book glyph is inlined as a `data:image/svg+xml` URI in the layout
`metadata.icons`, so it needs no network request and is not gated by middleware on
the pre-auth login page (a served `/icon.svg` route would 302 to `/login`).

## Uh-oh crash reporting wiring

### D100: Vendored client, no-op without a DSN, UH_OH_DSN / NEXT_PUBLIC_UH_OH_DSN

Crash reporting rides `@uh-oh/js` (the author's own self-hosted tool at
github.com/cunninghambe/uh-oh), vendored verbatim as one dependency-free file at
`src/lib/uh-oh-client.ts` via `node <uh-oh repo>/scripts/vendor-js-client.mjs`
rather than an npm dependency, matching every other consumer of that tool. `init()`
is called unconditionally from `src/instrumentation.ts` (server, nodejs runtime
only), `src/instrumentation-client.ts` (browser), and `src/mcp/server.ts`
(the MCP process), each passing `dsn: process.env.UH_OH_DSN` (server/MCP) or
`process.env.NEXT_PUBLIC_UH_OH_DSN` (browser). With no DSN configured the client is
a silent no-op: no listeners installed, no console output, `captureException`
returns `''`. This ships the wiring safely today, before any uh-oh server exists
for this app, and turns on the moment a DSN is set with no further code changes.
`release` is `<package.json version>+0` (`src/lib/uh-oh-release.ts`): this repo has
no build-id/git-sha convention, so the build segment is a fixed placeholder per the
wiring convention shared across the author's repos.

### D101: NEXT_PUBLIC_UH_OH_DSN is a Docker/Fly build arg, not a runtime secret

This is the first `NEXT_PUBLIC_` env var in the repo. Next.js inlines
`NEXT_PUBLIC_` vars into the client bundle at build time, not at request time, so
`flyctl secrets set` or a plain `docker run -e` (both runtime-only) would have no
effect on it. The Dockerfile's builder stage gained `ARG NEXT_PUBLIC_UH_OH_DSN=`
promoted to `ENV` before `npm run build`, defaulting to empty (identical image
output to before this change when the arg is omitted). Documented in `.env.example`
and DEPLOY.md as `docker build --build-arg ...` / `flyctl deploy --build-arg ...`.
Server-side `UH_OH_DSN` has no such issue: it is read at request time, so it is a
normal runtime secret like `ANTHROPIC_API_KEY`.

### D102: MCP server flushes on SIGINT/SIGTERM before exit

`src/mcp/server.ts` installs `SIGINT`/`SIGTERM` handlers that `await flush(2000)`
then `process.exit(0)`, so a queued-but-unsent event is not silently dropped when
the MCP client shuts the server down (the SDK's `StdioClientTransport.close()`
sends `SIGTERM`, then `SIGKILL` after its own timeout, so this window is real and
exercised by the existing stdio acceptance test). Without a DSN, `flush()` resolves
immediately (no client installed), so this adds no observable delay to shutdown.
The startup-failure path (`main().catch`) also calls `captureException` and
`flush(2000)` before its existing `process.exit(1)`. The tool-dispatch catch in
`registerTools` (`src/mcp/tools.ts`) adds one breadcrumb naming the tool and calls
`captureException` before returning the existing MCP tool-error response; the
response shape and message are unchanged.

## Amendment A11: universal search and command palette

### D103: One denormalized FTS5 table, trigger-maintained, rebuilt at migrate

The index is a single FTS5 virtual table `search_index` (unindexed `kind`,
`ref_id`, `project_id`, `meta`; indexed `title`, `body`; tokenizer
`unicode61 remove_diacritics 2`) rather than external-content FTS per source
table. External content does not fit here: a chapter's searchable body joins two
tables (chapters plus the latest drafts row), and four separate FTS tables would
push the UNION and ranking mess into every query. The copy cost of a contentful
table is a few MB at novel scale. Sync is by SQL triggers on `chapters`,
`drafts`, `canon_facts`, `characters`, and `character_states` (a character
UPDATE also refreshes that character's state rows, whose titles carry the name),
so no JS code path can write around the index. `migrate()` also wipes and
rebuilds the whole index on every startup: it is O(project size), trivially
cheap for a single user, guarantees pre-A10 databases are indexed on upgrade,
and self-heals any drift. Porter stemming was considered and rejected: prefix
queries operate on stemmed terms and can silently miss, and predictable verbatim
recall matters more here than recall breadth.

### D104: The sanitizer makes FTS syntax unreachable, and the last token is a prefix

`toFtsQuery` tokenizes on whitespace, strips double quotes, control characters,
and the operator characters `*` `^` `(` `)`, wraps each surviving token in
double quotes (a phrase), and appends `*` to the final token when it has at
least two characters, so the palette feels like typeahead while single-letter
scans are avoided. Hyphens, apostrophes, and colons are deliberately KEPT:
inside a quoted phrase they are plain token separators, exactly as they are in
indexed content, so "well-worn" and "don't" match their prose forms. Operator
words (AND/OR/NEAR) become quoted literals. Tokens are capped (first 8) to
bound cost. A malformed MATCH expression is therefore impossible by
construction, which is asserted by unit tests that feed operator soup and
expect results or emptiness, never a throw. Queries that sanitize to nothing
return `[]` without touching the database.

### D105: meta stores raw DB values; 1-based conversion stays in chapterNumbering

The `meta` column carries raw database fields (`orderIndex`, `chapterOrder`,
statuses, types) as JSON written by the triggers. The A2 rule says the 0-based
to 1-based conversion happens in exactly one place, so the query layer
(`src/lib/search.ts`) converts with `orderToUiChapter` when shaping hits; the
SQL never adds 1. All three surfaces (palette, `/api/search`, MCP `search`)
speak 1-based chapter numbers because they all go through that layer.

### D106: Snippet markers are control characters; each surface renders its own

`snippet()` wraps matched ranges in U+0001/U+0002 (inserted via `char(1)` /
`char(2)` so no SQL string literals are involved). Control characters cannot be
typed into a novel, so they cannot collide with content. The palette splits on
them and emits `<mark>` React elements (no `dangerouslySetInnerHTML` anywhere);
the MCP tool replaces them with `**`. The API returns the raw markers so future
consumers choose their own rendering.

### D107: Palette wiring: window event from TopNav, hidden on /login, highlight deep-links

The palette mounts once in the root layout (a client island) and owns the
Ctrl/Cmd+K listener; the TopNav search button is a tiny client component that
dispatches a `bookforge:open-palette` window event, avoiding any context
plumbing through server components. The palette renders nothing on `/login`
(usePathname check): the API would 401 there anyway. Canon and character hits
deep-link as `?highlight=<id>`; the server pages pass that param into
`CanonManager` / `CharactersManager`, which scroll the row into view and apply a
temporary ring. Chapter hits land on the draft page, matching the sequencer's
canonical link for a chapter.

## Amendment A12: story threads and the braid view (phase 1)

Phase 1 is the whole backend: data model, repo, flags, extraction integration,
assembler block, API routes, search kind, and MCP tools. The braid page, its
layout function, the CommandPalette threads group, and e2e are Phase 2.

### D108: threads and thread_touches follow the canon patterns, index as a fifth search kind

The two tables mirror the SPEC DDL verbatim as idempotent CREATE TABLE IF NOT
EXISTS in migrate.ts, with drizzle mirrors in schema.ts, exactly like every
prior table. project_id NULL means series-wide, reusing the canon_facts
convention rather than inventing a scope column. A thread joins the A11 FTS index
as kind 'thread': the title is the thread name; the body concatenates type,
status, note, and every touch's evidence (group_concat in a subquery), so a hit
lands whether the term is in the author note or in a chapter's quoted evidence;
meta carries type, status, and the RAW project_id (D105: no 1-based conversion in
SQL). Sync is by triggers on BOTH tables: a thread change refreshes its own row,
and a touch insert/update/delete refreshes the parent thread's row (the body
embeds touch evidence), plus threads are added to the full rebuildSearchIndex.
Putting the touch refresh on thread_touches (not only threads) is what keeps the
index correct when a lock-time approval adds a touch to an existing thread.

### D109: the repo speaks book-plus-series-wide, and touches carry their chapter's order and book

listThreads({ projectId }) returns that book's threads AND series-wide (NULL)
threads in one call, because every consumer (the prompt's open-thread list, the
assembler block, the API list, threadFlags) wants exactly that set. A separate
"series only" mode was not needed in Phase 1 and was left out. listTouches returns
TouchWithChapter, each touch enriched with its chapter's 0-based order and book id
via a join, ordered chronologically by chapter order. Carrying chapterOrder and
chapterProjectId on the touch means the flag and assembly code never re-joins and
never has to guess which book a touch belongs to. The 0-based order stays internal
(A2): the 1-based conversion happens only at the route and MCP boundary through
orderToUiChapter.

### D110: dropped-thread detection is a pure function measured against the locked frontier

computeThreadFlags(status, touchOrders, maxLockedOrder) is pure and unit-tested
rule by rule. STALE_GAP is an exported const of 4. A thread flags only when it is
open and the gap from the book's highest LOCKED chapter order to its latest touch
EXCEEDS STALE_GAP (a gap of exactly 4 does not flag). ORPHAN is the sharper case,
the same gap with at most one touch ever, so an orphan is also stale and the UI
shows the "introduced and never developed" wording. Two boundary rulings were made
and recorded here: a thread with zero touches flags nothing (the rule is defined
against a latest-touched chapter, which does not exist), and a book with no locked
chapters (maxLockedOrder null) flags nothing (there is no frontier to measure).
Resolved and retired threads are exempt. Series-wide threads are evaluated per book
by threadsWithFlagsForBook, which filters a thread's touches to the book being
looked at (chapterProjectId) before computing, so the same thread can be stale in
one book and current in another. The alternative, pooling a series-wide thread's
touches across books, was rejected: it would hide a thread dropped in book 2 just
because book 3 touched it.

### D111: lock-time thread proposals ride the existing extraction call, name match beats the model's hint

The A1 extraction JSON contract gains a "threads" array; the prompt now lists the
book's open threads (its own plus series-wide) by name and instructs the model to
attach with isNew false rather than duplicate. parseExtractionResponse tolerates a
missing or non-array "threads" key as an empty list (old replies and the empty
fixtures stay valid) and drops proposals lacking a name or a valid touch kind.
normalizeThreadProposals then splits proposals into attach vs new by
case-insensitive, trimmed name match against the advertised threads, and the match
is authoritative: the model's isNew hint is ignored, so a mislabeled proposal
cannot create a duplicate thread. A new-thread proposal that omitted a type
defaults to 'arc' (recorded here rather than dropping the proposal or inventing a
richer guess). runCanonExtraction does the normalization (it has the db) and
returns a CanonExtractionResult carrying threadAttaches and threadNews alongside
facts and states; the extract-canon route and the importer route (which reuses
runCanonExtraction) both surface them, so the importer path keeps working with no
second implementation.

### D112: thread approval extends the one gate, atomically, and stays human-only

approveExtraction gained optional threadAttaches and newThreads, so the single
approval endpoint and repo function handle facts, states, and threads together and
every existing facts-plus-states caller is byte-unchanged. Approved attaches insert
a thread_touch on the chapter; approved new-thread proposals create the thread and
its first touch, all inside the SAME db.transaction so a new thread never lands
without its touch. An attach that targets a thread that no longer exists rejects
the whole call (added to the unmatched list) exactly like an unmatched state, so
nothing partial lands. Rejection needs no code: only the proposals the author
explicitly sends are persisted, so an unapproved thread leaves no trace. No MCP
tool and no code path can approve a thread proposal, preserving the sacred gate;
the touch source is 'extraction:<chapter_id>', matching the state convention.

### D113: the OPEN THREADS block is a conditional member of the cacheable stable prefix

The assembler now builds explicit stableBlocks and variableBlocks arrays instead of
slicing at a fixed STABLE_BLOCK_COUNT (removed), because the OPEN THREADS block is
present only when the book has open threads. It sits between CHARACTERS and STORY
SO FAR, inside the stable prefix, so it caches with CANON like the rest (A4.1).
When there are no open threads the block is omitted entirely, so a pre-A12 book
produces a byte-identical prompt and every existing assembler assertion holds
unchanged. Each open thread (book plus series-wide) renders as "name (type): ch N,
kind: evidence snippet" or "not yet touched", ordered by most recently touched,
capped at 12 with a "+N more" line, evidence snippet bounded near 120 characters.
The instruction sentences are the SPEC's, rewritten without em-dashes: keep threads
alive where the beats allow, do not force every thread into every chapter, never
resolve a thread the beats do not resolve.

### D114: search and MCP round out the surface; thread_resolve and thread_retire are author-equivalent

Thread hits deep-link to /book/<projectId>/threads?highlight=<id>; a series-wide
thread (project_id null) resolves to the first book by order_index, computed once
per request in the search route from the projects repo. The MCP surface gains
threads_list (per-book flags), thread_get (touch timeline, 1-based), thread_create,
thread_touch_add (1-based chapter in, resolved to a chapter row, source 'mcp'),
thread_resolve, and thread_retire. Resolve and retire are allowed for the same
reason canon_lock is: a status change on standing data is an author-equivalent
action, not an extraction-approval or chapter-lock gate. That forced a narrowing of
the two tool-surface absence assertions, which used a blanket /resolve/i to catch a
revision-hunk-resolve tool: they now except thread_resolve and thread_retire by
name while still forbidding any other resolve tool, so the human-only boundary is
kept exactly, just stated more precisely.

## Amendment A12: the braid view (phase 2)

### D115: buildBraidLayout's stale rule is shared with the run-out, not reserved for between-touch gaps

`src/lib/braidLayout.ts` imports `STALE_GAP` from `threadFlags.ts` rather than
redefining the threshold, so the braid's dashed-segment cutoff and the list's
stale/orphan chips can never drift apart. A segment's `stale` boolean uses the
same `toOrder - fromOrder > STALE_GAP` rule whether it is a between-touch
segment or the trailing run-out from an open thread's last touch to the locked
frontier. This matters for a thread with exactly one touch: it has no
between-touch segment at all, so without this unification a badly dropped
single-touch thread would never render dashed-in-warn, only faint. Making the
run-out compute `stale` the same way means "orphan and dropped" reads the same
in the line as "many touches then dropped," which is what the SPEC's line
"the drop is visible in the line itself" asks for.

### D116: retired threads get neither run-out nor terminal; row order mirrors the braid exactly

The SPEC states the run-out/terminal split as two cases (open gets a run-out,
resolved gets a terminal tick) and says nothing about retired threads beyond
"render at reduced opacity." Read literally, retired is a third status that
gets neither: its line simply stops at its last touch, and BraidView applies
the opacity reduction as a rendering concern, not a geometry one. Separately,
ThreadsManager's thread list is reordered to `layout.rows` (looked up back to
full thread objects by id) rather than kept in API order, so the list and the
braid are pixel-row-aligned, matching the SPEC's "the braid and list are two
views of one selection."

### D117: SVG anchors carry focus, click, and tooltip for free; payoff nodes keep a permanent accent ring

Braid nodes and chapter-column labels are plain SVG `<a href>` elements instead
of `<g tabIndex>` with manual keydown handling: an anchor is natively
focusable, Enter and click both navigate, and the global `focus-visible`
outline (D95) already matches on the `a` element name regardless of SVG
namespace, so no new CSS or JS was needed for "keyboard-focusable... Enter
opens the chapter." An SVG `<title>` child gives the native tooltip carrying
kind and evidence. Colors are semantic Tailwind utilities (`fill-ink`,
`stroke-warn-edge`, `fill-inset/70`, and so on) that resolve through the same
CSS-variable tokens as the rest of the app (A9's `fill`/`stroke` core plugins
read from the same `colors` theme as `bg`/`text`), so both themes render
correctly with no bespoke SVG palette. Payoff nodes keep a permanent thin
accent-colored ring as part of their kind-shape (matching the SPEC's own list
of four node shapes) even when not selected; this is not a "per-thread color"
violation because every thread's payoff nodes look identical, it is a
kind-level exception the SPEC itself carves out, parallel to filled-circle
advance, ring mention, and diamond complicate. Co-touch bands use the neutral
`inset` token rather than `warn`: convergence is not a problem, so it does not
borrow the alert family.

### D118: the stale-gap chapter count is computed client-side from data already on hand

The API only returns the boolean `flags: {stale, orphan}`, not the numeric gap,
so the list row's "gone quiet for N chapters" wording computes N itself from
the thread's already-fetched touches and the book's already-fetched chapters:
the highest 1-based chapter number among locked chapters minus the highest
1-based touched chapter number. This stays correct without an extra 0-based
detour because a gap between two chapter numbers is the same whether both ends
are expressed 1-based or 0-based; only single chapter-number values need the
`chapterNumbering` conversion, never a difference of two.

### D119: LockPanel's thread proposals reuse the fact/state approval recipe verbatim

Thread-attach and new-thread proposal rows in `LockPanel.tsx` are copies of the
existing fact/state row recipe: a `tabIndex={0}` `<li>` with an `onKeyDown` for
`a`/`r`, a checkbox mirroring the same approved flag, and the one shared
`Approve checked proposals` button gathering all four categories into a single
`POST /api/extractions/approve` call. No new keyboard machinery (no arrow-key
row-to-row navigation) was added; approving a specific row via keyboard is
`.focus()` on that row's testid followed by a real `a` keypress, matching how
the fact/state rows already work and were already designed to be driven. Touch
kind and thread type vocabularies are mirrored locally in the component (like
`CanonManager`'s local `TYPES` array) rather than imported from the repo layer,
keeping client components decoupled from server-only modules. A response
missing `threadAttaches`/`threadNews` (an old fixture, or a backend that lags
this amendment) degrades to empty lists rather than a crash, so the panel is
forward-compatible.

### D120: the threads page's new-thread form is book-scoped only; no series-wide toggle

Unlike canon's Add form, the threads page's new-thread form has no scope
selector: a thread created from `/book/<id>/threads` is always created with
that book's `projectId`. The SPEC's new-thread form line only asks for "name,
type, optional character pair for relationship," and a book-scoped default
keeps the common case a single field fewer; a series-wide thread can still be
created directly against the API (as the MCP tool and any future series view
would) without adding UI surface this amendment does not call for.

## Amendment A13: Claude-inspired design language

### D121: The re-skin is a token revaluation, not a component pass

Every color change lands in `globals.css` token VALUES (same variable names,
light and dark), plus one shared Tailwind radius scale, the favicon, and the
TopNav wordmark. Zero component markup, class vocabulary, or data-testid
changes, so the entire A9 through A12 test suite passes untouched, including
the a9-tokens repo check. This is the payoff of A9's token architecture and
the reason a whole-app restyle is a small amendment.

### D122: Terracotta supersedes D91's monochrome accent; the focus ring stays blue

The light accent is a deeper terracotta (193 95 60) so the cream label reads
at button sizes; the dark accent is the brighter 217 119 87 with a near-black
label, which contrasts more strongly on the warm dark surface. D91 (accent as
a monochrome light/dark inversion) is superseded by the SPEC A13 directive.
The focus ring deliberately keeps its slate blue in both themes: keyboard
focus must never be confusable with the terracotta selection and hover
highlights the braid and the palette use.

### D123: Radius softens at the scale; the wordmark is the only new chrome

`borderRadius` DEFAULT goes to 0.5rem (lg 0.75rem, xl 1rem) in the Tailwind
theme, so every `rounded` card, input, and overlay softens at once; arbitrary
values like the palette's `rounded-[2px]` marks and `rounded-full` dots are
unaffected. The TopNav wordmark (accent book glyph plus serif "bookforge"
linking home) and the recolored favicon are the only new visual elements.
`ui-shots` seeds two threads with touches and captures the threads page, so
the A12 braid is part of the standing visual review set in both themes.

## Amendment A14: listen and voice notes

### D124: The two service URLs gate the feature; fixture mode is orthogonal

`TTS_SERVICE_URL` and `STT_SERVICE_URL` are the single gate. When a URL is blank
or unset, that half renders nothing and its routes 404 (`ttsEnabled` /
`sttEnabled` in `src/lib/audio/config.ts`), so a fresh clone shows no trace of
listen or voice notes. Visibility is URL-only and never keys off the fixture
flag, which keeps the route-404 unit test deterministic regardless of the test
env. `USE_FIXTURE_LLM=1` is a separate axis: it only decides whether a bridge
short-circuits to a canned response instead of calling the loopback service, so
the automated loop never touches the network. E2e sets both URLs to
`http://fixture.invalid` so the surfaces show while the bridges short-circuit.

### D125: One paragraph-boundary function is the source of truth

`paragraphRanges` in `src/lib/audio/paragraphs.ts` is the only boundary
computation; `splitParagraphs`, `paragraphIndexForOffset`, and the anchoring path
all derive from it. A paragraph is a block separated by a blank line (interior
single newlines stay in the paragraph), trimmed, empties dropped, which is
exactly what the reader sees on the whitespace-pre-wrap surfaces. So a paragraph
index means the same thing in the manifest, the per-paragraph audio route, and
the voice-note anchor.

### D126: Audio is cached content-addressed, pruned oldest-first to a cap

The cache key is `sha256(voiceId + " " + paragraphText)` (a NUL-free separator so
no voice/text pair aliases another), stored as `data/audio/<key>.<ext>`. Revising
a chapter re-synthesizes only the paragraphs whose text changed; re-listening is
free. `planPrune` is a pure oldest-first eviction to a byte cap (default 2 GB,
`AUDIO_CACHE_MAX_BYTES`), run after every write. Key derivation and prune planning
are pure and unit-tested; the filesystem wrappers are thin.

### D127: ffmpeg is detected once; Opus with a WAV fallback, never an error

Detection runs `ffmpeg -version` once per process, memoized, logged once. Present
means the Piper WAV is transcoded to Opus (Ogg, `audio/ogg`) before caching, since
raw WAV over mobile data is heavy; absent means the WAV is served as is
(`audio/wav`). `chooseAudioFormat(ffmpegPresent)` is the pure fallback decision and
is unit-tested with detection mocked. A per-file transcode hiccup falls back to
serving the WAV rather than surfacing an error, honoring the "never an error" rule.

### D128: A voice note IS a comment, anchored by quoted-text-is-truth

`POST /api/voice-notes` forwards the audio to the STT bridge and creates an inline
comment on the chapter's LATEST draft through the existing comments machinery. The
anchor (`quoted_text`) is the opening sentence of the target paragraph (a verbatim
prefix, so `findSpan` locates it); offsets are the usual best-effort cache. Nothing
about comments' role in revision changes: the revision flow consumes a voice note
exactly like a typed comment. The transcript is returned so the client can show it
immediately with an inline edit (PATCH the comment) and an undo, because
transcription is imperfect.

### D129: Fixture services are a tiny WAV file and a canned transcript, no network

In fixture mode the TTS bridge serves `tests/fixtures/audio.tiny.wav` (a minimal
valid RIFF/PCM file generated by the pure `minimalWav`, checked in and marked
binary in `.gitattributes`; the bridge falls back to `minimalWav()` if the file is
missing) and the STT bridge returns `tests/fixtures/stt.note.json`'s `text`
(whisper's leading space trimmed by the pure `parseTranscript`). Both short-circuit
before any `fetch`, mirroring the LLM `FixtureClient` pattern, so the loop never
calls Piper or Whisper.

### D130: The player is state-driven so e2e asserts transitions, not sound

`ListenPlayer` exposes `data-playing` and `data-paragraph` and a "paragraph N of
M" position, all driven by React state, so e2e asserts play/pause, skip, and the
audio element `src` without decoding audio. Play is optimistic: clicking sets the
state and attempts `audio.play()`, ignoring a rejected promise, so an autoplay or
codec quirk never desyncs the assertion from intent. Position persists per chapter
in `localStorage` (`bookforge_listen_pos_<chapterId>`); the next paragraph is
prefetched while the current one plays so on-miss synthesis latency hides.

### D131: Paragraph indices are 0-based internally, displayed 1-based with a local +1

Paragraph indices are 0-based everywhere in code (cache, routes, anchor, player
state). They are shown 1-based ("paragraph 12 of 48") with a local `+1` at the
display site only. Paragraphs are not chapters, so `chapterNumbering` is
deliberately not used for them; the display convention is kept consistent by hand.

## Amendment A15: mobile-friendly layout

### D132: One breakpoint, added by pushing the original class behind `sm:`

Every responsive change follows one mechanical pattern: the pre-A15 class
becomes the `sm:`-prefixed class, and a new mobile-appropriate value takes the
unprefixed slot (`grid-cols-1 sm:grid-cols-[1fr_18rem]`, `px-4 sm:px-6`,
`pt-0 sm:pt-[18vh]`). Because Tailwind's responsive utilities always sit after
the base layer in the generated stylesheet, the `sm:` value wins at 640px
regardless of source order, so desktop's computed CSS is unchanged bit for
bit. No component gained a second implementation for mobile; each one gained a
wider or narrower value at the existing breakpoint boundary.

### D133: TopNav's disclosure is a Fragment child, not a wrapper div, and `nav-settings` exists exactly once

`NavDisclosure` (a small client component, mirroring SearchTrigger's D107
composition) returns the toggle button and the links panel as siblings, not
wrapped in an extra div: `<nav>` already owns the flex row and its `gap-6`,
and a wrapper would have doubled up on that gap's math between the wordmark,
the links, and the ml-auto group. `<nav>` gained `relative` so the mobile
panel can anchor with `position:absolute` beneath it; at `sm:` the panel
reverts to `static` and the row reads identically to the pre-A15 markup. Only
one `Link` carries `data-testid="nav-settings"`; visibility is entirely
CSS-driven (`hidden` below the breakpoint unless `open`, forced `sm:flex` at
and above it), so the id is never duplicated in the DOM and a strict-mode
`getByTestId` lookup resolves to one element on both layouts.

### D134: The command palette becomes a full-screen sheet through class changes only

No new markup, no new state, no new testids: the backdrop's `pt-[18vh]`
becomes `pt-0 sm:pt-[18vh]`, the panel's `max-w-xl rounded-lg border` becomes
full-bleed below the breakpoint (`h-full w-full rounded-none border-0`,
restored at `sm:`), the input's rounded top corner follows the same flip, and
the results list's `max-h-[50vh]` grows to `max-h-[70vh]` on mobile so a
full-screen sheet does not leave dead space beneath a short result list.
Behavior (open/close, the debounce, keyboard nav, the stale-response guard)
is untouched.

### D135: Mobile approve/reject tap targets call the same setter the keyboard shortcut calls

LockPanel, ImportPanel, and BibleImportPanel each gained (or, for
BibleImportPanel, already had) one named setter per proposal list
(`setFactApproved`, `setStateApproved`, etc). The `onKeyDown` handler for
`a`/`r` and the new `MobileApproveReject` component
(`src/components/MobileApproveReject.tsx`, shared by all three panels) both
call that same setter; the tap buttons render only below the breakpoint
(`sm:hidden`) and are additive markup, so desktop's checklist DOM, testids,
and keyboard behavior are byte-identical to pre-A15. The approval gate itself
(`POST /api/extractions/approve`, `POST /api/bible/approve`) is untouched:
both entry points still just flip a boolean in local state before an
explicit Approve click.

### D136: A CSS floor, not per-button edits, for the 44px touch-target rule

Rather than hand-edit padding on every button, a `@media (max-width: 639px)`
block in globals.css sets `min-height: 44px` (with `inline-flex` centering)
on the shared `.btn-*` recipes and on the `bg-accent` primary-CTA pattern
used consistently, and exclusively on real buttons and links (checked by
grep before adding the selector), across the app. The rule is invisible
above 640px, so it cannot touch desktop rendering, and it reaches most
primary and secondary actions app-wide without a file-by-file pass. A
handful of small raw-styled edit/delete controls in CanonManager and
CharactersManager use neither pattern and are not covered; noted here as a
residual gap rather than silently left unaddressed.

### D137: Grid-column and flex-wrap fixes were the load-bearing part of "no horizontal body scroll"

Three concrete bugs, not the disclosure or the palette, were what would
actually have broken the SPEC's automated acceptance check. DraftEditor and
ReviewEditor's `grid-cols-[1fr_18rem|20rem]` (an unconditional fixed-width
aside column, wider on its own than a 390px viewport) became
`grid-cols-1 sm:grid-cols-[...]`. ThreadsManager's braid column gained
`min-w-0` (a CSS Grid item without it sizes to its content's min-content
width, defeating BraidView's own `overflow-x-auto` and forcing the whole
page to scroll instead of the braid's own container). Sequencer's
add-chapter form (a `min-w-[20rem]` input with no `flex-wrap`), its chapter
row, and the ten `page.tsx` header rows (an `h1` beside a row of nav links)
all gained `flex-wrap`, since none of them had ever needed to wrap before
A15 introduced a viewport narrow enough to require it.

### D138: Viewport metadata leaves zoom available

`export const viewport` in `src/app/layout.tsx` sets
`width: "device-width", initialScale: 1` and deliberately omits
`maximumScale` or `userScalable: false`. The acceptance check is "without
pinch-zooming", not "unable to"; locking zoom out would be an accessibility
regression the SPEC never asked for.

### D139: The mobile Playwright project is manual iPhone-13 numbers on Chromium, sharing one server

`playwright.config.ts` gained a `projects` array: `desktop` (the pre-A15
settings, unchanged, with `testIgnore` excluding `a15-mobile.spec.ts`) and
`mobile` (390x844, deviceScaleFactor 3, `isMobile`, `hasTouch`, a mobile
Safari UA, with `testMatch` restricted to `a15-mobile.spec.ts`). The settings
are written out manually rather than spreading `devices["iPhone 13"]`,
because the preset also carries `defaultBrowserType: "webkit"` and only
Chromium is installed on the test machine; a first run failed on exactly
that. Manual settings keep both projects on one engine (uniform flake
profile, no new browser download). Both share the existing single `webServer`
and the root-level `workers: 1`, so the two projects still run strictly
serially in one worker, preserving the pre-A15 non-flaky execution model
rather than introducing project-level parallelism.

## Amendment A16: multiple series and creating books

### D140: series_id added by guarded ALTER plus a self-healing backfill, never a NOT NULL column

The four tables that were implicitly series-wide (`projects`, `canon_facts`,
`characters`, `threads`) gain `series_id` through the existing
`addColumnIfMissing` pattern, added as a plain nullable INTEGER with no
REFERENCES clause so the ALTER never has to validate existing rows. NOT NULL is
enforced in code, not in the schema. A `backfillSeries` step runs on every
migrate: if any of the four tables has a NULL `series_id`, it get-or-creates one
default series ("The Trilogy", editable) and assigns every orphan to it. The
orphan check means the backfill is a no-op on an already-migrated database and
on a truly empty one (where `seed()` makes the series instead), so it never
creates a spurious second series. This is what makes the acceptance keystone
hold: on a database carrying the trilogy, everything lands under one series and
an existing chapter's assembled prompt is byte-identical before and after.

### D141: repos default an omitted series to the first series; the MCP tools are strict

`createCanon`, `createThread`, and `createCharacter` resolve `series_id` from the
`projectId` when one is given (a book item inherits its book's series) and fall
back to the first series when a series-wide item names no series. This keeps
every pre-A16 internal caller and existing test working unchanged (a repo call
with `projectId: null` still succeeds). The MCP `canon_add` and `thread_create`
handlers are the strict layer: omitting BOTH `projectId` and `seriesId` throws
"a series-wide item must name its series", per SPEC. The one existing tool test
that created a series-wide fact with neither was adapted to pass `seriesId: 1`
(its status/source/lock assertions are unchanged, so nothing is weakened) and a
new test covers the rejection.

### D142: project order_index is scoped within a series, not global

`createProject` computes the next `order_index` as the max among that series'
books plus one, so a new series' first book is order 0 exactly like the trilogy's
Book 1, and reading order is per-series. This is load-bearing for prompt
isolation: `buildStorySoFar` now filters "prior books" to earlier books OF THE
SAME SERIES, so a new series' book never lists the trilogy's books as prior
context even though their order_index values overlap. The home page groups by
series and orders books within a series by this index, so global order_index
uniqueness was never needed.

### D143: assemblableCanon is the single canon-scoping seam; everything flows through it

Rather than re-implement series scoping in each consumer, `assemblableCanon`
resolves the book's series once and returns "this book, plus series-wide facts of
this book's series". The assembler, character chat, sweep, lock-time extraction,
and interrogation all call it, so all five inherit the boundary from one change.
Each still gets its own cross-series isolation test (assembler prompt, chat
context, sweep prefix capture, and the listThreads/listCharacters queries that
feed extraction), because sharing an implementation is not the same as proving
each surface honors it.

### D144: characters carry a series_id; listCharacters gains an optional series filter, defaulting to global

`listCharacters(db, seriesId?)` returns one series' roster when a series is named
and every character across all series when it is not. The assembler, extraction,
review @-mentions, the characters page, and the threads relationship picker pass
the book's or switcher's series; `GET /api/characters` returns all characters
when no `seriesId` query param is present (so pre-A16 global callers, including
existing e2e setup, keep working) and one series' roster when it is. `POST
/api/characters` defaults an omitted `seriesId` to the first series, documented
so the A3 and other specs that create a character with only a name still land it
in the trilogy.

### D145: the FTS index gains an unindexed series_id, self-heals its schema, and stays globally searchable by default

`search_index` gains a `series_id UNINDEXED` column populated by the triggers and
the rebuild (derived from the project for chapters and states, carried directly
for canon, characters, and threads). A pre-A16 index built without that column is
detected by probing `sqlite_master.sql` and dropped so it is recreated with the
current schema, since migrate rebuilds it from source every run anyway. The bm25
weight vector gained a leading 0 for the new column. Default palette search stays
global across all series (finding things is the point); the API and MCP `search`
gain an optional `seriesId` filter. A series-wide thread hit now deep-links to the
first book of ITS series (`firstProjectOfSeries`), resolved from the hit's
`seriesId`, falling back to the overall first book.

### D146: creating a series copies the five seed style rules into it and lands a first book

`createSeries` inserts the series, COPIES the five seed style rules as locked
series-wide `style_rule` facts (source 'seed') owned by the new series, and
creates a first book with a default editable title ("Book 1"), so the author
lands ready to write. The copies are independent rows, so a series can retire or
edit its own style contract without touching another series'. The em-dash
prohibition remains repo law regardless of any per-series edit.

### D147: four new MCP tools, and the tool-list tests extended exactly

`series_list`, `series_create`, `book_create`, and `book_rename` join the surface;
`characters_list` gains an optional `seriesId`. None match the human-only gate
patterns (approve/resolve/revise/import/lock-chapter), so the absence assertions
keep passing untouched in meaning. Both exact tool-list tests
(`mcp-tools.test.ts` and `mcp-server.test.ts`) were extended by the four names,
which is the required and expected way to keep those lists exact. `book_rename`
does not move a book between series (there is no cross-series move), matching the
SPEC non-goal.

### D148: the canon page gains the same series switcher as the characters page; the bible importer resolves its scope's series

The characters page's series switcher pattern (default first series, or the
deep-linked row's series on a `?highlight=`) is applied identically to the canon
page. This was not only for coherence: a global canon page would show every
series' copied seed style rules mixed together, and the existing phase1 e2e
asserts exactly five locked style rules, which only holds when the list is scoped
to one series. Scoping the canon list to the switcher's series (series-wide facts
of that series plus that series' book facts) keeps that assertion true no matter
how many series exist, and a series-wide fact created from the page (or from
`POST /api/canon`) lands in the selected series (`seriesId` in the body), falling
back to the first series when none is named. The bible importer resolves its
scope's series the same way: a book scope from the chosen book, a series-wide
import to the first series (the documented default), which keeps the A3 e2e green
because its Book 2 scope resolves to the trilogy exactly as before. Cross-series
character sharing, per-series settings/theming, and deleting or archiving a
series or book remain non-goals (removal stays a manual database operation).

## Amendment A17: thread backfill scan

### D149: web UI only, no MCP scan tool (recorded non-goal)

The scan is a threads-page flow with no MCP surface. Scan proposals are ephemeral
until approved, and MCP must never approve extraction-style proposals (the standing
gate discipline: no tool approves what only the human checklist may). Exposing a
`threads_scan` tool would either return unapproved proposals nobody can act on
through MCP or smuggle an approval path around the gate, so neither is built. The
MCP tool-surface tests are untouched: no new tool name joins the list.

### D150: the scan is the sweep loop reshaped, over the A12 normalization, not a new pipeline

`runScan` is `runSweep`'s shape (sequential one-call-per-locked-chapter, every call
logged with the chapter id, per-chapter LLM/parse failure carried as an outcome
while the run continues per A2.2) pointed at thread recovery. Parsing REUSES
`parseExtractionResponse` (a reply carrying only a `threads` key parses with empty
facts/states), and the attach-vs-new split REUSES `normalizeThreadProposals`. The
model routing is the existing `extraction` purpose via `modelFor`; no new purpose,
per SPEC. So the scan adds a loop and a merge, not a second extraction stack.

### D151: default range is locked and touchless; an explicit rescan opts in with includeTouched

`scanTargets` returns the locked chapters in the order range, minus any that
already carry a thread touch, unless `includeTouched` is set. The default
(includeTouched false) is exactly "every locked chapter with no touches yet", so
running the default scan again proposes nothing for chapters a prior run already
populated. Unlocked chapters are never scanned in either mode: locked text is the
settled record. The threads page derives the touched-chapter set from the loaded
threads so the estimate matches the server's target set without a second query.

### D152: within-run linkage merges attaches by thread id and new threads by case-insensitive name

`accumulateScanProposals` extends the A12 normalization across a whole run: each
chapter is split with `normalizeThreadProposals` (attach-to-existing preference
intact), then attaches merge by the existing thread id and new threads merge by
trimmed-lowercased name, in first-appearance order, so chapter 7's "Theo and Mara"
lands on chapter 2's proposed thread instead of duplicating. The loop also feeds
the names proposed so far forward into each later chapter's prompt (the model is
nudged to reuse them), but the merge is authoritative regardless of what the model
echoes back. Group and touch order are deterministic (Map insertion order), so the
checklist and its flat keyboard sequence are stable.

### D153: source 'scan:<chapter_id>' per touch, via a chapter-scoped approveScan sibling

Lock-time approval stamps one chapter's id on every touch; a scan approval spans
several chapters, so `approveScan` stamps `scan:<chapter_id>` per touch from the
touch's own chapter, distinguishing scan provenance from lock-time
`extraction:<chapter_id>`. It is a sibling of `approveExtraction`, not an extension:
it validates that every referenced chapter is a LOCKED chapter of this book and
every attach targets a live thread, and rejects the WHOLE call on any dangling
reference (atomic, no trace), then creates new threads with their touches and
inserts attach touches in one transaction. `createThread` resolves the series from
the book, so A16 scoping holds automatically. Nothing auto-resolves; flags
recompute on the next load and the braid fills in.

### D154: one merged checklist grouped by thread, inside the threads manager so approval reloads the braid

Results merge into ONE approval checklist (the bible importer's chunks-merge
pattern) grouped by thread: an attach group shows the existing thread's name, a new
group shows name and type, and each carries every touch the run found (chapter,
kind, evidence) as an individually check-off-able row. The rows share the standard
keyboard recipe (arrows move across the whole flat touch sequence, a approves, r
rejects) and the A15 `MobileApproveReject` tap targets, wired to the same setters,
so there is one approval code path. `ScanPanel` lives inside `ThreadsManager` and
takes its `load` as `onApproved`, so approving reloads threads, chapters, and the
braid in place. The threads empty state (locked chapters, zero threads) renders the
scan invitation and opens the panel, so the empty page is the entry point.

### D155: a dedicated scan prompt that asks only for the A12 threads section

`scanThreadsPrompt` is a sibling of `extractionPrompt` reusing its threads-section
contract text, but it asks ONLY for thread touches (the scan recovers threads, not
facts or states) and carries the chapter's locked text and summary, the book's open
threads as attach targets, and the names already proposed earlier in the run. The
reply contract is exactly `{ "threads": [...] }`, which `parseExtractionResponse`
reads unchanged. It forbids em-dashes like every other template.

### D156: e2e provisions its own series and book for a deterministic default range

Because the default scan range is the whole book's locked chapters, the A17 e2e
cannot share Book 1 (other specs seed it with unpredictable chapters and threads).
Each test creates its own series (which lands a first book) via `POST /api/series`,
locks two chapters in it, and scans that book, so the range is exactly two known
chapters. Per-chapter fixtures follow the sweep pattern: base key plus 1-based
position (`extraction.scan1.1.json`, `extraction.scan1.2.json`), with a
deliberately unparseable `extraction.scanfail.1.json` planting a per-chapter failure
whose reason surfaces while `extraction.scanfail.2.json` still proposes.

## Sequencer chapter-link fix

### D157: Chapter titles are links; locked and in-review chapters open the reading surface

Found live: a book whose chapters are all locked (an imported finished book)
had no clickable path into any chapter, because the sequencer's only
navigation was the Start drafting link inside the expanded editor, a path
that assumes the chapter is still moving through the pipeline. Every e2e
flow drove chapters through that pipeline, so the gap never surfaced until
real imported data hit it. The title is now a link on every row: planned,
interrogating, and drafting chapters open the draft surface; locked and
in-review chapters open the review surface (reading plus notes, where
Listen also lives), which is what an author wants from finished text. The
Edit button and every existing testid are unchanged; a regression e2e
(fix-chapter-links.spec.ts) pins both link targets and the click-through.

## Scan 502 fix

### D158: No HTTP request spans more than one model call; the client drives the scan

The first production scan died as a 502 at 944 seconds: chapter-sized prompts
run minutes per call on the claude-code transport, and the original design ran
every chapter's call inside ONE request. Revised flow: POST .../scan only PLANS
(returns the target list, no LLM); the client loops POST .../scan/chapter, one
chapter per request, sending the run's raw proposal history so the server can
statelessly rebuild the proposed-names feed-forward and return the whole run's
merged checklist after each chapter (merge logic stays server-side and
unit-tested in scanChapter/deriveProposedNames/accumulateScanProposals). A
failed chapter, whether HTTP, model, or parse, becomes its outcome row and the
loop continues (A2.2). Progress is now real ("chapter 3 of 24"), and the same
per-position fixture routing is preserved, so the a17 e2e drives the new flow
unchanged. The sweep shares the old single-request shape and the same latent
risk on long ranges; flagged separately rather than smuggled into this fix.

## Amendment A18: sweep restructure

### D159: the sweep is the scan 502 fix applied verbatim, one model call per request

D158 flagged the sweep as carrying the same latent risk it had just fixed for the
scan: chapter-sized prompts run minutes per call on the claude-code transport, and
the old sweep ran every chapter's call inside ONE request, which on a real book
outlives the serving chain and dies as a 502 partway through, discarding completed
work. A18 applies the identical reshaping. POST .../sweep now only PLANS (validates
the order range, returns the ordered locked-chapter targets, no LLM); the client
loops POST .../sweep/chapter, one chapter per request, so no HTTP request ever
spans more than one model call. Unlike the scan the sweep carries no cross-chapter
state (each chapter is checked against the locked canon independently), so the
per-chapter request needs no run history and the client aggregates the report by
concatenation. Progress is now real ("chapter 3 of 24" naming the chapter), and the
report is assembled as chapters complete so a mid-run failure loses only its own
chapter's slice, never the ones already done.

### D160: sweepChapter is the shared engine; runSweep delegates; MCP is untouched

The single-chapter step is extracted as sweepChapter, exactly as runScan delegates
to scanChapter. runSweep builds the shared prefix once and calls sweepChapter per
chapter, so every existing sweep unit test still exercises the same engine through
runSweep, and the new per-chapter endpoint calls sweepChapter directly. A per-call
LLM or parse failure becomes the returned report entry's error fields (A2.2), never
a throw; a missing or non-locked chapter is a request-level error and throws, which
the endpoint surfaces with its reason (mirroring scanChapter). The MCP sweep_book
tool still calls runSweep in-process over stdio with no HTTP hop, so the 502 mode
does not exist there and it is unchanged.

### D161: the A4.1 prefix is rebuilt per request, byte-identical; no spec adjustment needed

The A4.1 cacheable locked-canon prefix is built by sweepCanonPrefix, which both
runSweep (once per run) and the per-chapter endpoint (once per request) call over
the same series canon, so the bytes are identical and provider-side prompt caching
keeps hitting across a client-driven run. The prompts themselves (sweepPrefix,
sweepChapterPrompt) are untouched, so the prompt-construction and cache tests hold
unchanged, and a unit test now pins sweepCanonPrefix to sweepPrefix over the book's
assemblable canon. Per-position fixture routing (base key plus the 1-based position
in the swept set) is preserved: the client rebuilds the same suffix the old run
built, so the existing sweep fixtures drive the new flow and both sweep e2e specs
(the phase5 planted contradiction and the a2 per-chapter error surfacing) pass
unchanged. Neither spec asserted the old transport mechanics; both drive the UI and
assert outcomes, so no spec was adjusted.

## Listen and voice-note field fixes

### D162: Voice notes transcode to WAV server-side; the player buffers visibly and warms the whole chapter

Two field failures from the first real phone session. (1) Voice notes always
failed: browsers record webm/opus (or mp4), and the whisper.cpp server only
reads WAV natively; production returned "failed to read audio data" (the A14
verification had used a WAV, masking it). The STT bridge now transcodes
anything that is not RIFF/WAVE to 16 kHz mono WAV via ffmpeg before posting
(original bytes pass through when ffmpeg is absent), and a whisper error field
is surfaced as the failure reason instead of degrading to an empty transcript.
(2) Listen went silent mid-chapter: production logs showed 5 to 15 second
synthesis times per paragraph while short dialogue paragraphs play in 3 to 5,
so the one-ahead prefetch starved; a rejected audio.play() after a stall was
also swallowed while the UI claimed to be playing. The player now runs a
sequential whole-chapter warm loop (one request at a time; the synthesizer is
the bottleneck), shows a visible synthesizing state while stalled, and turns a
rejected play() into an explicit tap-to-continue prompt. Fixture-driven tests
never stall, so every existing a14 assertion is unchanged.

## Pending-revision restore fix

### D163: A pending revision is reachable after the call that made it is gone

Field failure: a 103 second revision call completed server-side (pending
revision persisted, HTTP 200) but the phone browser lost the in-flight
response, and the UI had no path to the durable state: hunks existed only in
the streamed control frame's memory, so the author saw silence and even a
reload showed nothing. Fixes: GET /api/drafts/[id]/revision returns the
draft's newest pending revision in the exact control shape the stream
delivers, with hunks recomputed deterministically from the stored old/new
text (the same analyzeRevision call the resolve route makes); ReviewEditor
loads it on mount and shows a restored banner; revise() is fully guarded
(the chat-audit pattern) and on a dropped connection immediately checks for
a completed pending revision and restores it. Transient call diagnostics
(mode, failed patches, retry flags) are not persisted and restore with
defaults; the substance (hunks, declared fixes) is exact. The gate is
untouched: resolution still requires every unauthorized hunk decided through
the resolve route. New unit coverage for newestPendingRevisionForDraft and
an e2e that reloads mid-resolution and resolves from the restored state.

## Amendment A19: better voices, same contracts

### D164: The flip is an env change gated by a measured realtime factor

Kokoro-82M behind a repo-owned adapter (scripts/kokoro-speak-server.py,
Piper's exact /speak contract, loopback bind, body cap) benchmarked on three
real Chapter One paragraphs at median RTF 0.509 (long 0.509, mid 0.494, short
dialogue 0.635), comfortably under the 1.0 gate, so both env vars flipped
(TTS to the Kokoro service on 3110, STT to a second whisper.cpp instance
running large-v3-turbo q5 on 3111; the shared autogeny services untouched on
their original ports). AUDIO_VOICE_ID moved to kokoro-af_heart so the
content-addressed cache re-keys: old Piper audio ages out of the size cap and
chapters re-synthesize in the new voice on next listen. Deployment gotcha
recorded in DEPLOY.md: pm2 bakes env at first start and Next does not
overwrite existing process env, so an env-file change requires sourcing the
file into the shell before pm2 restart --update-env. Rollback is the env
backup plus restart; nothing else changes.

### D165: Unspeakable paragraphs synthesize as silence; a failed load offers Retry

Field failure on the first Kokoro listen: the chapter's scene-break
separators (a bare "---" is its own paragraph) phonemize to zero segments,
the Kokoro runtime throws, the adapter 500d, and the player showed the
misleading browser-pause message with a Play button that could not help.
Two fixes. The adapter answers text with nothing voiceable (and any
synthesis yielding zero samples) with 0.8 seconds of silence at the model
rate: a beat of quiet is exactly what a scene break should sound like, and
the /speak contract stays total. The player distinguishes a LOAD failure
from a browser-blocked play: an audio element error now pauses honestly and
offers Retry (which reloads the element and resumes), instead of a resume
nudge that cannot work until the source refetches.

## Amendment A20: bible import restructure

### D166: the 500 was the bible call's output exceeding the transport's per-call token cap

Reproduced on the deployment box before restructuring. The bible extraction call for
a 24,000-char chunk asks the model for a large structured JSON reply; measured on the
box with the exact prompt, dense bible content produces about 0.9 output tokens per
input character, so one chunk wants 12,000 to 15,000 output tokens. The running app
uses the claude-code transport, whose ClaudeCodeClient never forwards the call's
maxTokens to the CLI; the effective output cap is instead the process environment's
CLAUDE_CODE_MAX_OUTPUT_TOKENS, which pm2 baked at 2048 (in /root/.pm2/dump.pm2). When
a reply exceeds that cap the CLI returns is_error with "API Error: Claude's response
exceeded the 2048 output token maximum" rather than a partial result; parseCliResult
throws a transient ClaudeCodeError, withRetry runs it a second time, and each attempt
takes about three minutes (the CLI internally iterates to 8,192 tokens before giving
up), so the two attempts total the observed ~418 seconds and the unguarded route
returns 500. It is NOT a Next route timeout and NOT a response-size limit: the
request completed at the app level and returned 500. Restructuring alone does not fix
this (each per-chunk call would still exceed 2048); the binding fix is smaller chunks
(D168), so each request's output stays under the cap on the box as configured.

### D167: plan call plus one request per chunk, the scan/sweep shape applied verbatim

POST /api/bible/import now only PLANS: it validates the pasted text, splits it with
chunkBible, and returns the chunk texts and count (no model call, no DB access). A
new POST /api/bible/import/chunk runs exactly ONE chunk (one model call, purpose
"bible", logged) and returns that chunk's proposals and any parse failure. The
single-chunk step is extracted as importBibleChunk, exactly as runScan delegates to
scanChapter and runSweep to sweepChapter; runBibleImport keeps looping over it, so
its behavior and the fixture path are unchanged and the shared engine stays covered.
The dedup context (locked canon plus roster, series-scoped per A16) is rebuilt per
request by bibleDedupContext, byte-identical to the context runBibleImport builds
once, so the prompt bytes match across a run. BibleImportPanel drives the loop
client-side: plan, then one request per chunk with live progress ("Reading chunk 3
of 40"), a per-chunk parse or model-call failure carried into the existing raw-text
surface (A2.2) while the loop continues, and every chunk's proposals merged into the
one approval checklist exactly as before. A thrown model call becomes the chunk's
parseFailure inside importBibleChunk, never a throw, so an outlier dense chunk that
still exceeds the cap surfaces as one recoverable failed chunk rather than a 500. The
gated POST /api/bible/approve and the keyboard-and-tap approval are untouched:
nothing lands unapproved. There is no bible MCP tool, so no MCP surface changes.
Per-position fixture routing is preserved (bibleChunkFixtureKey: a single chunk uses
the base key, multiple chunks suffix the 1-based position), so the existing bible
fixture drives the new flow and the a3 e2e passes unchanged; it asserts the UI and DB
outcomes, not the single-request transport, so no spec was adjusted.

### D168: the chunk cap drops from 24,000 to 2,000 characters, justified by measurement

DEFAULT_BIBLE_CHUNK_CHARS drops from 24,000 to 2,000; chunkBible's paragraph-boundary
behavior is unchanged. Measured on the box with the exact extraction prompt: a
pathologically dense 2,243-char sample returned 2,049 output tokens (0.91 tok/char,
right at the cap), while ordinary bible prose returned about 0.39 tok/char, and the
author's real bible sits near 0.55 (its whole was six 24k calls of 12 to 15k tokens).
At 2,000 characters even the dense ceiling stays near 1,800 output tokens, safely
under the 2,048-token cap whose breach caused the 500, so a normal import runs chunk
by chunk with no failed chunks; a single per-chunk call measured about 20 to 30
seconds, far from any timeout. Smaller input also shortens every per-chunk output.
The chunkBible unit tests are unaffected: the one test that depended on the default
still yields two chunks because each of its 15,000-char paragraphs now exceeds the
smaller cap and becomes its own chunk. The fixture-driven a3 e2e is single-chunk
regardless of the cap.

## Amendment A21: markdown emphasis

### D169: emphasis is a display and audio concern only; the stored content stays raw markdown

parseEmphasis (src/lib/markdown.ts) turns raw content into ordered segments
{ text, kind, rawStart }, where text is the visible text with markers removed and
rawStart is the raw offset of that visible text's first character (past any leading
marker). stripEmphasis is the concatenation of those segments' visible text, so the
rendered surface and the spoken text derive from one segmentation and can never
disagree. The draft is never rewritten: the draft editor still edits raw markdown,
export still emits it, and every offset the app computes (comment quotedText and
spans, revision findSpan, voice-note paragraph anchoring) stays on the raw content
exactly as before. Bold is ** or __, italic is * or _; a marker with no matching
close, a space just inside the open or the close, or a lone marker is literal, never
a broken segment; the parser never throws and never drops or reorders a visible
character. No markdown library was added: it is a small hand-rolled scanner for
emphasis only.

### D170: the review surface renders segments in data-raw-start spans and maps selections back to raw offsets

ReviewEditor renders each segment as a <span data-raw-start={rawStart}> wrapping
plain text, an <em>, or a <strong>, inside the existing whitespace-pre-wrap serif
container, with no dangerouslySetInnerHTML. The selectionchange handler no longer
sums text-node lengths across the prose (which would yield the marker-stripped
offset); it resolves each endpoint's enclosing [data-raw-start] span and adds the
offset within that span's visible text to the span's rawStart. Because a segment's
visible text is a contiguous run of the raw input, this is exact, so
quotedText = content.slice(lo, hi) is byte-identical to the pre-A21 single-text-node
behavior: a selection inside an emphasized word yields the plain word, and a
selection spanning a marker yields the raw substring including the marker. Comment
save, revision diff, and highlight are therefore unchanged, which the phase4, phase5,
and a4 suites confirm by running green unmodified.

### D171: stripEmphasis is applied where synth text and cache key are derived, in the route and the manifest

The per-paragraph audio route derives one stripped value from the raw paragraph and
feeds it to both the cache key and synthesizeSpeech, so the spoken audio and its key
cannot diverge. The manifest's cache-state probe keys on the same
stripEmphasis(paragraph): the route now writes under the stripped key, so a probe on
the raw key would always read as uncached. Paragraph splitting itself stays on the
raw content (paragraphs.ts is untouched), so paragraph indices and voice-note
anchoring are unchanged; only the text handed to TTS changes. Changing the keyed
text re-keys the content-addressed cache, so each paragraph re-synthesizes once
without its markers and the old marker-bearing audio ages out of the cap. The
manifest's chars field stays the raw paragraph length, which is display only.

### D172: underscores obey the intraword restraint, asterisks do not

Asterisk emphasis is recognized intraword the way markdown allows (foo*bar*baz
italicizes bar), but an underscore does not open or close emphasis when it sits
against an alphanumeric character, so snake_case_name and file_name_here stay literal
and are spoken verbatim rather than mangled into snakecasename. This is the standard
markdown asymmetry and the only flanking rule the parser applies beyond the
space-just-inside restraint, and it keeps technical tokens intact without pulling in
a markdown library. Apostrophes and hyphens are not markers at all, so they are
untouched throughout.

### D173: the pending preview and stored comment quotes render through the same parser

The selected-span preview and each existing comment's quoted text render through
parseEmphasis (as <em>, <strong>, or plain text), so a marker never appears as
literal text anywhere on the review surface. In the common case the stored quote is
a clean word with no marker and renders as plain text; the shared parser matters only
when a quote legitimately contains emphasis. The draft editor and the Markdown export
are deliberately untouched (they show the raw asterisks, since the author edits and
exports the source), and character chat is not affected.

## Deferred non-goals (from SPEC, not built)

Image generation; multi-user/accounts beyond the shared password; story-arc
visualizations or tension graphs; export formats beyond concatenated Markdown;
real-time collaboration, comment threads, version branching beyond linear draft
versions. (Mobile layout was on this list through A14; Amendment A15 superseded
it and built it.)

## Deferred feature ideas (author-proposed mid-build, not in SPEC v1)

Update 2026-07-13: both ideas below were accepted into scope as amendments A5
(character chatbots) and A6 (MCP server) in SPEC.md and are being built.

Recorded 2026-07-13 during the Phase 3 stop. Not built in this run per the SPEC
rule against unspecced features; candidates for a v1.1 spec amendment after
Phase 7.

### Character chatbots

Per-character chat seeded from the character card (voice_rules, role, physical,
notes), the locked style rules, and the character's effective state as of a chosen
chapter N (existing `effectiveState` + `priorLockedChapters` machinery). On opening
a chat the bot asks "when in the book am I?" to pin N. Knowledge hygiene mirrors
POV drafting: the bot knows only what the character knows at N, deflects
in-character about what it is hiding at N, refuses post-N knowledge, and emits a
missing-fact line instead of inventing. Primary use: voice audition ("what would
you say in this situation") before drafting. Guardrail: chat is ephemeral; nothing
enters canon except through an explicit propose-as-provisional-fact button that
uses the normal approval gate. Runs on UTILITY_MODEL, logged to llm_calls. Its
prerequisite (dense character states) was accepted separately as amendment A1; see
D22.

### MCP server exposing BookForge

A local MCP server wrapping the repo layer (same functions the route handlers
call): canon CRUD/lock, characters and states, chapters and reorder,
interrogation, draft generation, sweep, import, export, character chat. Constraint
carried over from the SPEC quality bar: extraction approval and revision hunk
accept/reject stay human-only decisions; MCP may read proposals and reports but
must not auto-approve either gate.

### D174: The popover is additive; the static panel and every existing testid stay byte-identical

The selection popover and inline composer are new elements with new testids
(selection-toolbar, toolbar-comment-button, toolbar-suggest-button,
inline-composer, inline-comment-input, inline-suggest-input, inline-note-input,
inline-composer-submit). The static "Selected span" panel remains untouched as
the fallback surface (it is also the phone flow, where floating popovers fight
native selection handles). This keeps every existing e2e green without edits,
per the test-preservation law.

### D175: A suggestion is a comment row with non-null suggested_text; nullability is the discriminator

No kind enum, no second table. The comments table gains one nullable
suggested_text column by guarded ALTER (the D140 pattern). Suggestions share
quoted-text-is-truth anchoring, the sidebar, resolution, and the lock gate with
plain comments; they differ only in what consumes them. The revise prompt
excludes them (a filtered sibling of listUnresolvedComments); the lock gate
counts every unresolved row, so an unapplied suggestion still blocks locking.

### D176: Suggestions apply mechanically, one transaction, one new draft version, no model call

The author's exact replacement text needs no model. Apply anchors each
unresolved suggestion via findSpan, skips unanchorable ones ("not found") and
later overlapping ones ("overlap"), applies the rest in one transaction, and
inserts exactly one new draft version. Skips are reported with reasons, the
A2.2 pattern, and skipped suggestions stay unresolved. suggestedText is linted
for em-dashes at creation (400), so apply cannot introduce one.

### D177: On apply, resolved rows stay on their version; unresolved rows move to the new draft

Applied suggestions are marked resolved and keep their draft_id (they record
what was applied to which version). Every unresolved row, plain comments and
skipped suggestions alike, has its draft_id updated in place to the new draft,
so review continuity survives a mechanical apply. The existing rule that
comments do not carry forward across an LLM revision is unchanged; that path
still clears.

### D178: Anchors are computed client-side with the server's own findSpan; decoration is a pure function

No API change: the client imports the same pure findSpan the repo uses, so
anchor positions can never disagree with the server's recomputation. Decoration
lives in src/lib/reviewAnchors.ts as a pure function layered on parseEmphasis:
it splits the A21 segments at anchor boundaries and tags each finer segment
with its covering anchor ids. Every finer segment still carries a correct
data-raw-start, so rawOffsetForEndpoint and selection capture are untouched.

### D179: Single-key shortcuts are safe because the prose is read-only

c (comment) and e (suggest) act only while a non-collapsed selection sits
inside review-prose AND focus is outside any input, textarea, or
contenteditable, so they can never eat typed text. Ctrl+Enter (Cmd on Mac)
submits a composer, Escape cancels, clicking outside cancels. Toolbar buttons
preventDefault on mousedown so the click does not collapse the selection it is
acting on.

### D180: Shortcut reminders live on the surface, not only in muscle memory

Field report follow-up to A22: the c and e shortcuts existed but nothing on
screen said so. The toolbar buttons now carry key-cap chips (Comment c,
Suggest edit e), the composer's save/cancel hint shows the platform's own
modifier (Cmd on Mac, Ctrl elsewhere, resolved the SearchTrigger way in an
effect so the server and first client render agree), and a quiet one-line
reminder sits under the prose. That line is hidden below the sm breakpoint:
on a phone there is no keyboard, so the reminder would be noise. One new
testid (shortcut-hints); every pre-existing testid untouched.

### D181: The fallback composer moves into the sidebar

Field report follow-up to A22: with the popover covering the in-context flow,
the static "Selected span" panel and the shortcut reminder were dead weight
pinned below the whole chapter, while the wide layout left the right column
mostly empty. Both now sit at the top of the aside, beside the prose. Every
testid is unchanged (the e2e suite locates them by testid, never by
position); the only copy change is dropping the word "above" from the
panel's empty-state line, which position made false. On phones the aside
stacks below the prose as before, and the popover remains the primary
composer there.

### D182: The review's threat model, written down so severity is arguable

Public internet, ONE shared password, unpublished manuscript, paid model
calls, running as root beside other services. No multi-tenancy, so per-user
authorization is not a concern and classic IDOR findings were dismissed.
What counts: unauthenticated reach, availability, untrusted text reaching a
shell or a path, and anything that weakens an approval gate. Five surfaces
were audited independently (auth, API and data, the LLM subprocess, the
client, the box) and every finding below was re-verified against the code
or against the deployed site before being acted on.

### D183: Headers are set in next.config.ts, not in middleware or Caddy

One place, applied to every path, versioned with the app. Caddy could set
them, but then the repo's posture would depend on infrastructure the repo
cannot see. frame-ancestors 'none' is the load-bearing one: no destructive
control in this UI has a confirmation step, so a framed click deletes canon
or starts a paid run. script-src is deliberately omitted: it needs a
per-request nonce, and the review found NO html injection sink in the app
(no dangerouslySetInnerHTML, no innerHTML, nothing), so a script policy
would be defense in depth against a hole that does not exist. Recorded as a
follow-up, not a gap.

### D184: Cross-site requests are refused by Sec-Fetch-Site, not by a CSRF token

SameSite=Lax already blocks cross-SITE writes, but the cookie's site is the
registrable domain, so any sibling host under the same domain is same-site
and can drive writes. A token would mean threading state through every form
and fetch. One header check in the middleware covers every route at once:
same-origin requests report "same-origin", typed URLs and bookmarks report
"none", and only genuine cross-site traffic reports "cross-site". This also
closes the audio GET vector, where Lax does send the cookie on a top-level
navigation.

### D185: The session key is derived from both secrets, so rotating either revokes

Sessions were signed with SESSION_SECRET alone, so changing APP_PASSWORD
after a suspected compromise revoked nothing and "Log out" only cleared the
local cookie. Keying the HMAC on both secrets makes password rotation the
revocation lever a single-user app actually reaches for. Accepted cost: the
deploy that lands this signs the author out once. Max age drops 30 days to
7 for the same reason.

### D186: A malformed cookie must fail closed AND quietly

fromBase64Url ran atob outside the try, so any non-base64 cookie threw
through verifySessionToken into the middleware and returned 500 on every
gated path. Verified live before the fix: four malformed cookies, four
500s, no session required. It never granted access, so this is availability
and noise (it also floods crash reporting), not a bypass. Both token halves
are now shape-checked before decoding.

### D187: save-draft validates its input and refuses locked chapters

saveWorkingDraft updates the latest draft row IN PLACE by design (one
evolving working draft until a revision or lock cuts a version). Combined
with `typeof body.content === "string" ? body.content : ""`, a request
carrying {} or a non-string silently replaced a finished chapter with an
empty string, with no new version to recover from, on a LOCKED chapter.
That is the manuscript, so the coercion is replaced with a 400 and the
route refuses to write to a locked chapter. The in-place update stays: it
is correct for its purpose, and the danger was the coercion, not the shape.

### D188: The subprocess boundary keeps its safety property; the crash is the bug

Command injection is NOT present on the production path: Linux always
spawns with shell false and the prompt rides stdin, never argv (D65). That
property is preserved, not rebuilt. The real defect was an unhandled EPIPE:
when the CLI exits before draining stdin, writing the prompt emits an error
on a stream with no listener, which is an uncaught exception that kills the
server. One authenticated request with a bad model id does it. ffmpeg.ts
already installs exactly the handler needed; llm/client.ts now does too.
The Windows shell fallback stays working (it is the author's dev machine)
but the model id is validated so no metacharacter can reach that argv.

### D189: Delimiter scanning uses lastIndexOf because the server writes the frame last

The streaming control delimiter is documented as a string that "will never
occur in generated prose", which is an assumption about model output, not
an invariant. Manuscript text can instruct the model to emit it, splitting
its own stream and hiding everything after it from the author who is about
to approve a revision. The server always appends the genuine frame last, so
scanning from the end is strictly correct and cannot be spoofed by content.

### D190: Locking is gated in one place, so PATCH stops accepting it

POST /lock refuses while comments are unresolved; PATCH /api/chapters/[id]
accepted {"status":"locked"} with no such check, so the gate was enforced
in one route and open in another. PATCH now rejects a locked status and
points at the lock endpoint. The canon PATCH-to-locked is left alone: it is
documented as an author-equivalent action on standing data (see the MCP
boundary note), whereas chapter locking has a real precondition to skip.

### D191: The login limiter is in-memory because the deploy pins one instance

A pure decideLogin(state, key, now) backs a module-level counter, per IP and
global, since XFF is attacker-controlled. DEPLOY.md pins exactly one pm2
instance, so shared storage would be ceremony. The password is long and
random, so this is not credential defense; it is cost control and the
detection signal that was missing (the Caddy log shows the box being
probed). Failures log one warning line and return 429 with Retry-After.

### D192: Source maps delete by default, because a remembered flag is not a control

productionBrowserSourceMaps plus an opt-in --delete-browser-maps published
the app's client source to the internet whenever a deploy forgot the flag.
That happened, twice, on 2026-07-24, and was caught by this review: 28 maps
were live and fetchable. Deletion is now the default with an explicit
--keep-browser-maps opt-out, so the unsafe outcome requires a deliberate
choice rather than a perfect memory.

### D193: A correct password is never throttled

The limiter as first built consulted the throttle before checking the
password, which is the textbook ordering and wrong here. The global bound
exists because X-Forwarded-For is attacker-controlled, so anyone on the
internet could push the global counter past its limit and lock the AUTHOR
out of his own manuscript for the rest of the window. The box is
demonstrably probed (the Caddy log carries 1855 hits on /login and 57
requests for /.env), so that is an operational certainty, not a theory.
The password is therefore checked first, and the throttle now decides only
whether a FAILED attempt is answered with 429 instead of 401. Nothing is
conceded: a wrong guess still reveals nothing, still costs the attacker a
request, and still trips both counters, and the credential itself carries
about 95 bits (D191), which is what actually defeats guessing. Availability
for the one legitimate user beats a rate limit that cannot protect a secret
this strong.

### D194: Cross-site refusal covers writes and the API, not links to the app

Refusing every cross-site request breaks an ordinary thing: clicking a link
to bookforge from a chat client, an email, or any other site sends
Sec-Fetch-Site: cross-site on that top-level navigation, so the author would
get a 403 where he expected his book. Bookmarks and typed URLs send "none"
and were never affected, which is exactly why this is easy to miss in
testing. The rule is therefore: refuse cross-site requests that are writes
(any method other than GET or HEAD), and refuse cross-site requests to
/api/ even when they are GETs, since the audio route synthesizes speech on a
plain GET and nothing honest navigates cross-site into this API. A
cross-site GET of a PAGE is allowed, because rendering a page mutates
nothing and the session still has to be valid to see it. This keeps every
attack D184 was written for closed while leaving the app linkable.

### D195: A failing speech service is a 502, and its message stays server-side

Reworked from an auto-filed PR (#3) that had gone stale against three later
amendments. The defect was real and still present: the audio route called
the TTS bridge with no error handling, so a service that was down,
restarting, or erroring threw out of the handler and the listener got an
opaque failure part way through a chapter. D165 had fixed the neighbouring
case (text the voice cannot speak now synthesizes as silence), which is why
this one survived: it is the SERVICE failing, not the text. The route now
answers 502, which ListenPlayer already renders as a Retry rather than a
dead stop. The PR returned the underlying error message to the browser;
that part was dropped. The message comes from another service and the
client has no use for it, so it is logged with the chapter and paragraph
and a fixed sentence goes over the wire, consistent with A23 keeping
service and subprocess text off the response.
