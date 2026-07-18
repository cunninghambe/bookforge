"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { uiChapterToOrder } from "@/lib/chapterNumbering";
import { MobileApproveReject } from "./MobileApproveReject";

const CANON_TYPES = [
  "world_rule",
  "style_rule",
  "timeline_event",
  "character_fact",
  "plot_decision",
] as const;
type CanonType = (typeof CANON_TYPES)[number];

interface ExistingChapter {
  id: number;
  title: string;
  orderIndex: number;
}

interface CharacterOpt {
  id: number;
  name: string;
}

interface FactRow {
  type: CanonType;
  content: string;
  evidenceQuote: string | null;
  approved: boolean;
}

interface StateRow {
  character: string;
  characterId: number | null;
  knows: string;
  feels: string;
  hiding: string;
  evidenceQuote: string | null;
  approved: boolean;
}

interface ImportResponse {
  ok: boolean;
  chapter: { id: number; orderIndex: number; title: string | null };
  summary: string;
  facts?: Array<{ type: CanonType; content: string; evidenceQuote: string | null }>;
  states?: Array<{
    character: string;
    knows: string | null;
    feels: string | null;
    hiding: string | null;
    evidenceQuote: string | null;
  }>;
  error?: string;
  raw?: string;
}

// The backfill importer (SPEC section 7). Designed to run many times in a row: one
// paste creates a locked chapter, generates its summary, and proposes canon facts
// plus character-state deltas (Amendment A1) through the same approval gate as
// locking (POST /api/extractions/approve, unchanged). The checklist supports full
// keyboard navigation, arrows move focus between proposal rows and a/r
// approve/reject the focused row, so a backfill session never needs a mouse.
// Finishing a chapter clears the form, refocuses the title field, and a running
// count tracks the session.
export function ImportPanel({
  projectId,
  existingChapters,
  characters,
}: {
  projectId: number;
  existingChapters: ExistingChapter[];
  characters: CharacterOpt[];
}) {
  const searchParams = useSearchParams();
  const fixtureKey = searchParams.get("fx") ?? undefined;

  const [chapterCount, setChapterCount] = useState(existingChapters.length);
  const [title, setTitle] = useState("");
  // 1-based position (1 = first). Defaults to the next position at the end
  // (existing count + 1). Converted to the stored 0-based order_index at the UI
  // boundary via uiChapterToOrder (A2.1).
  const [position, setPosition] = useState(existingChapters.length + 1);
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importedCount, setImportedCount] = useState(0);

  const [chapterId, setChapterId] = useState<number | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [chars, setChars] = useState<CharacterOpt[]>(characters);
  const [facts, setFacts] = useState<FactRow[] | null>(null);
  const [states, setStates] = useState<StateRow[] | null>(null);
  const [extractionRaw, setExtractionRaw] = useState<string | null>(null);
  const [approved, setApproved] = useState<{ facts: number; states: number } | null>(
    null,
  );

  const titleRef = useRef<HTMLInputElement>(null);

  const factsLen = facts?.length ?? 0;
  const statesLen = states?.length ?? 0;
  const totalRows = factsLen + statesLen;

  // Sensible focus flow, part one: the title field gets focus on first load and
  // again once a chapter finishes and the form re-enables. Runs in an effect
  // (not inline in finishChapter) because the input is still `disabled` from the
  // previous render at the moment finishChapter's state updates are queued; a
  // disabled element cannot receive focus, so the effect waits for the DOM to
  // reflect the new, enabled state before focusing it.
  useEffect(() => {
    if (chapterId === null) {
      titleRef.current?.focus();
    }
  }, [chapterId]);

  // Sensible focus flow, part two: once proposals land, move focus to the first
  // row so the keyboard-driven checklist can be worked immediately.
  useEffect(() => {
    if (facts !== null && extractionRaw === null && totalRows > 0) {
      document.getElementById("import-row-0")?.focus();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [facts, states, extractionRaw]);

  function matchCharacter(name: string): number | null {
    const t = name.trim().toLowerCase();
    const found = chars.find((c) => c.name.trim().toLowerCase() === t);
    return found ? found.id : null;
  }

  async function importChapter() {
    if (busy || !title.trim() || !content.trim()) return;
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/projects/${projectId}/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: title.trim(),
        content,
        orderIndex: uiChapterToOrder(position),
        fixtureKey,
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Import failed.");
      return;
    }
    const data = (await res.json()) as ImportResponse;
    setChapterId(data.chapter.id);
    setSummary(data.summary);
    setApproved(null);
    if (!data.ok) {
      setExtractionRaw(data.raw ?? data.error ?? "Extraction failed to parse.");
      setFacts([]);
      setStates([]);
      return;
    }
    setExtractionRaw(null);
    setFacts(
      (data.facts ?? []).map((f) => ({
        type: f.type,
        content: f.content,
        evidenceQuote: f.evidenceQuote,
        approved: false,
      })),
    );
    setStates(
      (data.states ?? []).map((s) => ({
        character: s.character,
        characterId: matchCharacter(s.character),
        knows: s.knows ?? "",
        feels: s.feels ?? "",
        hiding: s.hiding ?? "",
        evidenceQuote: s.evidenceQuote,
        approved: false,
      })),
    );
  }

  async function createCharacterInline(name: string, index: number) {
    const res = await fetch("/api/characters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) return;
    const data = (await res.json()) as { character: { id: number; name: string } };
    setChars((prev) => [...prev, { id: data.character.id, name: data.character.name }]);
    setStates((prev) =>
      prev
        ? prev.map((s, i) => (i === index ? { ...s, characterId: data.character.id } : s))
        : prev,
    );
  }

  async function approveChecked() {
    if (!facts && !states) return;
    setError(null);
    const approvedFacts = (facts ?? []).filter((f) => f.approved);
    const approvedStates = (states ?? []).filter((s) => s.approved);
    if (approvedFacts.length === 0 && approvedStates.length === 0) {
      setError("Approve at least one proposal, or there is nothing to add.");
      return;
    }
    const unmapped = approvedStates.filter((s) => s.characterId === null);
    if (unmapped.length > 0) {
      setError(
        `Map ${unmapped.map((s) => s.character).join(", ")} to a character before approving.`,
      );
      return;
    }
    setBusy(true);
    const res = await fetch("/api/extractions/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chapterId,
        facts: approvedFacts.map((f) => ({ type: f.type, content: f.content })),
        states: approvedStates.map((s) => ({
          characterId: s.characterId,
          character: s.character,
          knows: s.knows || null,
          feels: s.feels || null,
          hiding: s.hiding || null,
        })),
      }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Approval failed.");
      return;
    }
    setApproved({ facts: approvedFacts.length, states: approvedStates.length });
    setFacts((prev) => (prev ? prev.filter((f) => !f.approved) : prev));
    setStates((prev) => (prev ? prev.filter((s) => !s.approved) : prev));
  }

  function focusRow(idx: number) {
    const clamped = Math.max(0, Math.min(idx, totalRows - 1));
    document.getElementById(`import-row-${clamped}`)?.focus();
  }

  // A15: named setters shared by the keyboard handler (a/r on a focused row)
  // and the mobile tap targets below, so both paths approve or reject through
  // the identical state update.
  function setFactApproved(i: number, v: boolean) {
    setFacts((p) => (p ? p.map((x, j) => (j === i ? { ...x, approved: v } : x)) : p));
  }
  function setStateApproved(i: number, v: boolean) {
    setStates((p) => (p ? p.map((x, j) => (j === i ? { ...x, approved: v } : x)) : p));
  }

  function onFactKeyDown(e: React.KeyboardEvent, i: number) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(i + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(i - 1);
    } else if (e.key === "a") {
      setFactApproved(i, true);
    } else if (e.key === "r") {
      setFactApproved(i, false);
    }
  }

  function onStateKeyDown(e: React.KeyboardEvent, i: number) {
    const flat = factsLen + i;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(flat + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(flat - 1);
    } else if (e.key === "a") {
      setStateApproved(i, true);
    } else if (e.key === "r") {
      setStateApproved(i, false);
    }
  }

  function finishChapter() {
    const nextCount = chapterCount + 1;
    setImportedCount((n) => n + 1);
    setChapterCount(nextCount);
    setPosition(nextCount + 1);
    setTitle("");
    setContent("");
    setChapterId(null);
    setSummary(null);
    setFacts(null);
    setStates(null);
    setExtractionRaw(null);
    setApproved(null);
    setError(null);
    // Focus is handled by the effect above once chapterId becomes null and the
    // title field re-enables.
  }

  const hasResult = chapterId !== null;

  return (
    <div>
      <p
        className="mb-3 text-xs uppercase tracking-wide text-muted"
        data-testid="import-count"
      >
        Imported this session: {importedCount}
      </p>

      {error && (
        <div
          data-testid="import-error"
          className="mb-3 rounded border border-danger-edge bg-danger px-3 py-2 text-sm text-danger-ink"
        >
          {error}
        </div>
      )}

      <div
        className="rounded border border-edge-soft bg-inset p-3"
        data-testid="import-form"
      >
        <label className="mb-2 flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase text-faint">Title</span>
          <input
            ref={titleRef}
            data-testid="import-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            disabled={hasResult || busy}
            className="rounded border border-edge px-2 py-1"
          />
        </label>
        <label className="mb-2 flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase text-faint">
            Position (1 = first, {chapterCount + 1} = last)
          </span>
          <input
            type="number"
            data-testid="import-order"
            value={position}
            min={1}
            max={chapterCount + 1}
            onChange={(e) => setPosition(Number(e.target.value))}
            disabled={hasResult || busy}
            className="w-24 rounded border border-edge px-2 py-1"
          />
        </label>
        <label className="mb-2 flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase text-faint">Chapter text</span>
          <textarea
            data-testid="import-content"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            disabled={hasResult || busy}
            rows={10}
            className="rounded border border-edge p-2 font-serif text-sm"
            placeholder="Paste the chapter text here."
          />
        </label>

        {!hasResult ? (
          <button
            data-testid="import-button"
            onClick={importChapter}
            disabled={busy || !title.trim() || !content.trim()}
            className="rounded bg-accent hover:bg-accent-hover px-4 py-1.5 text-sm text-accent-ink disabled:opacity-50"
          >
            {busy ? "Importing..." : "Import chapter"}
          </button>
        ) : (
          <button
            data-testid="import-finish-button"
            onClick={finishChapter}
            className="rounded bg-accent hover:bg-accent-hover px-4 py-1.5 text-sm text-accent-ink"
          >
            Done, next chapter
          </button>
        )}
      </div>

      {summary && (
        <div className="mt-3">
          <p className="text-xs uppercase tracking-wide text-faint">
            Chapter summary
          </p>
          <p
            data-testid="import-summary"
            className="mt-1 rounded border border-edge-soft bg-surface p-2 text-sm text-ink"
          >
            {summary}
          </p>
        </div>
      )}

      {approved && (
        <div
          data-testid="import-approve-success"
          className="mt-3 rounded border border-ok-edge bg-ok px-3 py-2 text-sm text-ok-ink"
        >
          Approved {approved.facts} fact(s) and {approved.states} state(s).
        </div>
      )}

      {extractionRaw !== null && (
        <div className="mt-3">
          <p className="text-xs uppercase tracking-wide text-warn-ink">
            Extraction did not parse. Raw model output:
          </p>
          <pre
            data-testid="import-extraction-raw"
            className="mt-1 overflow-x-auto rounded border border-warn-edge bg-warn p-2 text-xs text-warn-ink"
          >
            {extractionRaw}
          </pre>
        </div>
      )}

      {(facts !== null || states !== null) && extractionRaw === null && (
        <div className="mt-4" data-testid="import-extraction-panel">
          <p className="mb-2 text-xs uppercase tracking-wide text-muted">
            Proposals (nothing is added until you approve). Arrows move between
            rows, a approves, r rejects.
          </p>

          <ul className="space-y-2" data-testid="import-fact-proposals">
            {factsLen === 0 && (
              <li
                className="text-xs text-faint"
                data-testid="import-no-fact-proposals"
              >
                No fact proposals.
              </li>
            )}
            {(facts ?? []).map((f, i) => (
              <li
                key={`fact-${i}`}
                id={`import-row-${i}`}
                data-testid={`import-fact-proposal-${i}`}
                tabIndex={0}
                onKeyDown={(e) => onFactKeyDown(e, i)}
                className="rounded border border-edge-soft bg-surface p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:border-edge"
              >
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    data-testid={`import-fact-approve-${i}`}
                    checked={f.approved}
                    onChange={(e) => setFactApproved(i, e.target.checked)}
                    className="mt-1"
                  />
                  <span className="flex-1">
                    <span className="mr-2 rounded bg-chip px-1.5 py-0.5 text-xs uppercase text-muted">
                      {f.type.replace("_", " ")}
                    </span>
                    {f.content}
                    {f.evidenceQuote && (
                      <span className="mt-1 block text-xs italic text-faint">
                        evidence: &ldquo;{f.evidenceQuote}&rdquo;
                      </span>
                    )}
                  </span>
                </label>
                <MobileApproveReject
                  approved={f.approved}
                  onApprove={() => setFactApproved(i, true)}
                  onReject={() => setFactApproved(i, false)}
                  testidPrefix={`import-fact-proposal-${i}`}
                />
              </li>
            ))}
          </ul>

          <ul className="mt-3 space-y-2" data-testid="import-state-proposals">
            {statesLen === 0 && (
              <li
                className="text-xs text-faint"
                data-testid="import-no-state-proposals"
              >
                No character-state proposals.
              </li>
            )}
            {(states ?? []).map((s, i) => (
              <li
                key={`state-${i}`}
                id={`import-row-${factsLen + i}`}
                data-testid={`import-state-proposal-${i}`}
                tabIndex={0}
                onKeyDown={(e) => onStateKeyDown(e, i)}
                className="rounded border border-edge-soft bg-surface p-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-focus focus-visible:border-edge"
              >
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    data-testid={`import-state-approve-${i}`}
                    checked={s.approved}
                    onChange={(e) => setStateApproved(i, e.target.checked)}
                    className="mt-1"
                  />
                  <span className="flex-1">
                    <span className="font-medium">{s.character}</span>
                    {s.characterId === null && (
                      <span
                        data-testid={`import-state-unmatched-${i}`}
                        className="ml-2 rounded bg-warn-chip px-1.5 py-0.5 text-xs text-warn-ink"
                      >
                        unmatched: map or create before approving
                      </span>
                    )}
                    <span className="mt-1 grid grid-cols-1 gap-1">
                      <ImportStateField
                        label="knows"
                        value={s.knows}
                        onChange={(v) =>
                          setStates((p) =>
                            p ? p.map((x, j) => (j === i ? { ...x, knows: v } : x)) : p,
                          )
                        }
                        testid={`import-state-knows-${i}`}
                      />
                      <ImportStateField
                        label="feels"
                        value={s.feels}
                        onChange={(v) =>
                          setStates((p) =>
                            p ? p.map((x, j) => (j === i ? { ...x, feels: v } : x)) : p,
                          )
                        }
                        testid={`import-state-feels-${i}`}
                      />
                      <ImportStateField
                        label="hiding"
                        value={s.hiding}
                        onChange={(v) =>
                          setStates((p) =>
                            p ? p.map((x, j) => (j === i ? { ...x, hiding: v } : x)) : p,
                          )
                        }
                        testid={`import-state-hiding-${i}`}
                      />
                    </span>
                    <span className="mt-1 flex items-center gap-2">
                      <select
                        aria-label={`Map ${s.character}`}
                        data-testid={`import-state-character-select-${i}`}
                        value={s.characterId ?? ""}
                        onChange={(e) =>
                          setStates((p) =>
                            p
                              ? p.map((x, j) =>
                                  j === i
                                    ? {
                                        ...x,
                                        characterId: e.target.value
                                          ? Number(e.target.value)
                                          : null,
                                      }
                                    : x,
                                )
                              : p,
                          )
                        }
                        className="rounded border border-edge px-2 py-1 text-xs"
                      >
                        <option value="">(map to character)</option>
                        {chars.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      {s.characterId === null && (
                        <button
                          data-testid={`import-state-create-${i}`}
                          onClick={() => createCharacterInline(s.character, i)}
                          className="rounded border border-edge px-2 py-1 text-xs"
                        >
                          Create &ldquo;{s.character}&rdquo;
                        </button>
                      )}
                    </span>
                  </span>
                </label>
                <MobileApproveReject
                  approved={s.approved}
                  onApprove={() => setStateApproved(i, true)}
                  onReject={() => setStateApproved(i, false)}
                  testidPrefix={`import-state-proposal-${i}`}
                />
              </li>
            ))}
          </ul>

          <button
            data-testid="import-approve-button"
            onClick={approveChecked}
            disabled={busy}
            className="mt-3 rounded bg-accent hover:bg-accent-hover px-4 py-1.5 text-sm text-accent-ink disabled:opacity-50"
          >
            Approve checked proposals
          </button>
        </div>
      )}
    </div>
  );
}

function ImportStateField({
  label,
  value,
  onChange,
  testid,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  testid: string;
}) {
  return (
    <span className="flex items-center gap-2">
      <span className="w-12 text-xs uppercase text-faint">{label}</span>
      <input
        aria-label={label}
        data-testid={testid}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 rounded border border-edge px-2 py-1 text-xs"
      />
    </span>
  );
}
