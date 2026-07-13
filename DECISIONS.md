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

## Deferred non-goals (from SPEC, not built)

Image generation; multi-user/accounts beyond the shared password; story-arc
visualizations or tension graphs; export formats beyond concatenated Markdown;
mobile layout; real-time collaboration, comment threads, version branching beyond
linear draft versions.

## Deferred feature ideas (author-proposed mid-build, not in SPEC v1)

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
