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

## Spec amendments accepted mid-build

### D15: Amendment A1, character-state extraction at lock time (2026-07-13)

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
D15.

### MCP server exposing BookForge

A local MCP server wrapping the repo layer (same functions the route handlers
call): canon CRUD/lock, characters and states, chapters and reorder,
interrogation, draft generation, sweep, import, export, character chat. Constraint
carried over from the SPEC quality bar: extraction approval and revision hunk
accept/reject stay human-only decisions; MCP may read proposals and reports but
must not auto-approve either gate.
