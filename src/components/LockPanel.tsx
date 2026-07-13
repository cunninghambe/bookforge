"use client";

import { useState } from "react";
import Link from "next/link";

const CANON_TYPES = [
  "world_rule",
  "style_rule",
  "timeline_event",
  "character_fact",
  "plot_decision",
] as const;
type CanonType = (typeof CANON_TYPES)[number];

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

interface ExtractResponse {
  ok: boolean;
  facts?: Array<{
    type: CanonType;
    content: string;
    evidenceQuote: string | null;
  }>;
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

// The lock, extraction, and approval surface for the review page (SPEC section 6 +
// Amendment A1). Lock is enabled only when every comment is resolved. Locking
// generates the summary and then proposes canon facts and character-state deltas as
// a shared approval checklist. Nothing enters canon or the state timeline without an
// explicit approval; a state naming an unknown character cannot be approved until it
// is mapped or the character is created inline.
export function LockPanel({
  chapterId,
  projectId,
  initialStatus,
  initialSummary,
  unresolvedCount,
  characters,
  fixtureKey,
}: {
  chapterId: number;
  projectId: number;
  initialStatus: string;
  initialSummary: string | null;
  unresolvedCount: number;
  characters: CharacterOpt[];
  fixtureKey?: string;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [summary, setSummary] = useState<string | null>(initialSummary);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chars, setChars] = useState<CharacterOpt[]>(characters);
  const [facts, setFacts] = useState<FactRow[] | null>(null);
  const [states, setStates] = useState<StateRow[] | null>(null);
  const [extractionRaw, setExtractionRaw] = useState<string | null>(null);
  const [approved, setApproved] = useState<{
    facts: number;
    states: number;
  } | null>(null);

  const canLock = unresolvedCount === 0 && !busy;

  function matchCharacter(name: string): number | null {
    const t = name.trim().toLowerCase();
    const found = chars.find((c) => c.name.trim().toLowerCase() === t);
    return found ? found.id : null;
  }

  async function runExtraction() {
    const res = await fetch(`/api/chapters/${chapterId}/extract-canon`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtureKey }),
    });
    const data = (await res.json()) as ExtractResponse;
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

  async function lock() {
    if (!canLock) return;
    setBusy(true);
    setError(null);
    setApproved(null);
    const res = await fetch(`/api/chapters/${chapterId}/lock`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fixtureKey }),
    });
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Could not lock the chapter.");
      setBusy(false);
      return;
    }
    const data = (await res.json()) as { summary: string };
    setSummary(data.summary);
    setStatus("locked");
    await runExtraction();
    setBusy(false);
  }

  async function unlock() {
    setBusy(true);
    setError(null);
    const res = await fetch(`/api/chapters/${chapterId}/unlock`, {
      method: "POST",
    });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Could not unlock the chapter.");
      return;
    }
    setStatus("review");
    setSummary(null);
    setFacts(null);
    setStates(null);
    setExtractionRaw(null);
    setApproved(null);
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
        ? prev.map((s, i) =>
            i === index ? { ...s, characterId: data.character.id } : s,
          )
        : prev,
    );
  }

  async function approve() {
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
        `Map ${unmapped
          .map((s) => s.character)
          .join(", ")} to a character before approving.`,
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
    // Mark approved rows so they cannot be double-submitted.
    setFacts((prev) => (prev ? prev.filter((f) => !f.approved) : prev));
    setStates((prev) => (prev ? prev.filter((s) => !s.approved) : prev));
  }

  const locked = status === "locked";

  return (
    <div
      className="mt-6 rounded border border-neutral-200 bg-neutral-50 p-3"
      data-testid="lock-panel"
    >
      <h2 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
        Lock, extract, approve
      </h2>

      {error && (
        <div
          data-testid="lock-error"
          className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      {!locked ? (
        <>
          <button
            data-testid="lock-button"
            onClick={lock}
            disabled={!canLock}
            className="rounded bg-neutral-900 px-4 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {busy ? "Locking..." : "Lock chapter"}
          </button>
          {unresolvedCount > 0 && (
            <p data-testid="lock-hint" className="mt-2 text-xs text-amber-700">
              Resolve all {unresolvedCount} comment(s) before locking.
            </p>
          )}
        </>
      ) : (
        <div className="flex items-center gap-3">
          <span
            data-testid="locked-indicator"
            className="rounded-full bg-neutral-200 px-2 py-0.5 text-xs uppercase tracking-wide text-neutral-600"
          >
            locked
          </span>
          <button
            data-testid="unlock-button"
            onClick={unlock}
            disabled={busy}
            className="text-sm text-neutral-500 hover:underline disabled:opacity-50"
          >
            Unlock to edit
          </button>
        </div>
      )}

      {summary && (
        <div className="mt-3">
          <p className="text-xs uppercase tracking-wide text-neutral-400">
            Chapter summary
          </p>
          <p
            data-testid="chapter-summary"
            className="mt-1 rounded border border-neutral-200 bg-white p-2 text-sm text-neutral-700"
          >
            {summary}
          </p>
        </div>
      )}

      {approved && (
        <div
          data-testid="approve-success"
          className="mt-3 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800"
        >
          Approved {approved.facts} fact(s) and {approved.states} state(s). Facts
          are now locked canon; states apply from the next chapter.{" "}
          <Link href="/canon" className="underline">
            View canon
          </Link>
          .
        </div>
      )}

      {extractionRaw !== null && (
        <div className="mt-3">
          <p className="text-xs uppercase tracking-wide text-amber-700">
            Extraction did not parse. Raw model output:
          </p>
          <pre
            data-testid="extraction-raw"
            className="mt-1 overflow-x-auto rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
          >
            {extractionRaw}
          </pre>
        </div>
      )}

      {(facts !== null || states !== null) && extractionRaw === null && (
        <div className="mt-4" data-testid="extraction-panel">
          <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
            Proposals (nothing is added until you approve)
          </p>

          <ul className="space-y-2" data-testid="fact-proposals">
            {(facts ?? []).length === 0 && (
              <li className="text-xs text-neutral-400" data-testid="no-fact-proposals">
                No fact proposals.
              </li>
            )}
            {(facts ?? []).map((f, i) => (
              <li
                key={`fact-${i}`}
                data-testid={`fact-proposal-${i}`}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "a")
                    setFacts((p) =>
                      p ? p.map((x, j) => (j === i ? { ...x, approved: true } : x)) : p,
                    );
                  if (e.key === "r")
                    setFacts((p) =>
                      p ? p.map((x, j) => (j === i ? { ...x, approved: false } : x)) : p,
                    );
                }}
                className="rounded border border-neutral-200 bg-white p-2 text-sm"
              >
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    data-testid={`fact-approve-${i}`}
                    checked={f.approved}
                    onChange={(e) =>
                      setFacts((p) =>
                        p
                          ? p.map((x, j) =>
                              j === i ? { ...x, approved: e.target.checked } : x,
                            )
                          : p,
                      )
                    }
                    className="mt-1"
                  />
                  <span className="flex-1">
                    <span className="mr-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs uppercase text-neutral-500">
                      {f.type.replace("_", " ")}
                    </span>
                    {f.content}
                    {f.evidenceQuote && (
                      <span className="mt-1 block text-xs italic text-neutral-400">
                        evidence: &ldquo;{f.evidenceQuote}&rdquo;
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <ul className="mt-3 space-y-2" data-testid="state-proposals">
            {(states ?? []).length === 0 && (
              <li
                className="text-xs text-neutral-400"
                data-testid="no-state-proposals"
              >
                No character-state proposals.
              </li>
            )}
            {(states ?? []).map((s, i) => (
              <li
                key={`state-${i}`}
                data-testid={`state-proposal-${i}`}
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "a")
                    setStates((p) =>
                      p ? p.map((x, j) => (j === i ? { ...x, approved: true } : x)) : p,
                    );
                  if (e.key === "r")
                    setStates((p) =>
                      p ? p.map((x, j) => (j === i ? { ...x, approved: false } : x)) : p,
                    );
                }}
                className="rounded border border-neutral-200 bg-white p-2 text-sm"
              >
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    data-testid={`state-approve-${i}`}
                    checked={s.approved}
                    onChange={(e) =>
                      setStates((p) =>
                        p
                          ? p.map((x, j) =>
                              j === i ? { ...x, approved: e.target.checked } : x,
                            )
                          : p,
                      )
                    }
                    className="mt-1"
                  />
                  <span className="flex-1">
                    <span className="font-medium">{s.character}</span>
                    {s.characterId === null && (
                      <span
                        data-testid={`state-unmatched-${i}`}
                        className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
                      >
                        unmatched: map or create before approving
                      </span>
                    )}
                    <span className="mt-1 grid grid-cols-1 gap-1">
                      <StateField
                        label="knows"
                        value={s.knows}
                        onChange={(v) =>
                          setStates((p) =>
                            p
                              ? p.map((x, j) => (j === i ? { ...x, knows: v } : x))
                              : p,
                          )
                        }
                        testid={`state-knows-${i}`}
                      />
                      <StateField
                        label="feels"
                        value={s.feels}
                        onChange={(v) =>
                          setStates((p) =>
                            p
                              ? p.map((x, j) => (j === i ? { ...x, feels: v } : x))
                              : p,
                          )
                        }
                        testid={`state-feels-${i}`}
                      />
                      <StateField
                        label="hiding"
                        value={s.hiding}
                        onChange={(v) =>
                          setStates((p) =>
                            p
                              ? p.map((x, j) => (j === i ? { ...x, hiding: v } : x))
                              : p,
                          )
                        }
                        testid={`state-hiding-${i}`}
                      />
                    </span>
                    <span className="mt-1 flex items-center gap-2">
                      <select
                        aria-label={`Map ${s.character}`}
                        data-testid={`state-character-select-${i}`}
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
                        className="rounded border border-neutral-300 px-2 py-1 text-xs"
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
                          data-testid={`state-create-${i}`}
                          onClick={() => createCharacterInline(s.character, i)}
                          className="rounded border border-neutral-300 px-2 py-1 text-xs"
                        >
                          Create &ldquo;{s.character}&rdquo;
                        </button>
                      )}
                    </span>
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <button
            data-testid="approve-button"
            onClick={approve}
            disabled={busy}
            className="mt-3 rounded bg-neutral-900 px-4 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Approve checked proposals
          </button>
          <span className="ml-3 text-xs text-neutral-400">
            Press a to approve or r to reject a focused proposal.
          </span>
        </div>
      )}

      <div className="mt-4 border-t border-neutral-200 pt-3 text-xs text-neutral-500">
        <Link href={`/book/${projectId}/sweep`} className="hover:underline">
          Run a consistency sweep for this book
        </Link>
      </div>
    </div>
  );
}

function StateField({
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
      <span className="w-12 text-xs uppercase text-neutral-400">{label}</span>
      <input
        aria-label={label}
        data-testid={testid}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="flex-1 rounded border border-neutral-300 px-2 py-1 text-xs"
      />
    </span>
  );
}
