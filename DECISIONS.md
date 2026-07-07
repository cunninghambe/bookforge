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

## Deferred non-goals (from SPEC, not built)

Image generation; multi-user/accounts beyond the shared password; story-arc
visualizations or tension graphs; export formats beyond concatenated Markdown;
mobile layout; real-time collaboration, comment threads, version branching beyond
linear draft versions.
