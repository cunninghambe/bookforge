"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

const CANON_TYPES = [
  "world_rule",
  "style_rule",
  "timeline_event",
  "character_fact",
  "plot_decision",
] as const;
type CanonType = (typeof CANON_TYPES)[number];

interface ProjectOpt {
  id: number;
  title: string;
}

interface CharacterOpt {
  id: number;
  name: string;
  role: string | null;
  voiceRules: string | null;
  physical: string | null;
  notes: string | null;
}

interface FactRow {
  type: CanonType;
  content: string;
  approved: boolean;
}

interface CharRow {
  name: string;
  role: string | null;
  voiceRules: string | null;
  physical: string | null;
  notes: string | null;
  // Set when the proposed name matched an existing character (case-insensitive):
  // this is an UPDATE proposal against that row, not a duplicate creation.
  existingId: number | null;
  existingName: string | null;
  // Field labels that would change on the matched existing row (for display).
  changes: string[];
  approved: boolean;
}

interface StateRow {
  character: string;
  characterId: number | null;
  knows: string;
  feels: string;
  hiding: string;
  approved: boolean;
}

interface ImportResponse {
  ok: boolean;
  chunks: number;
  facts: Array<{ type: CanonType; content: string }>;
  characters: Array<{
    name: string;
    role: string | null;
    voiceRules: string | null;
    physical: string | null;
    notes: string | null;
  }>;
  states: Array<{
    character: string;
    knows: string | null;
    feels: string | null;
    hiding: string | null;
  }>;
  parseFailures: Array<{ chunk: number; error: string; raw: string }>;
}

// The series-bible importer (Amendment A3). A large paste textarea, a scope
// selector (series-wide or a specific book), then a categorized approval checklist
// (facts, characters, states) with the same calm keyboard-driven UX as the backfill
// importer: arrows move focus across ALL sections in order (facts, then characters,
// then states), a approves the focused row, r rejects it. Nothing lands until the
// author approves it through POST /api/bible/approve; there is no approve-all
// default. The states section is hidden for a series-wide scope, since a state
// requires a book to be effective from.
export function BibleImportPanel({
  projects,
  characters,
}: {
  projects: ProjectOpt[];
  characters: CharacterOpt[];
}) {
  const searchParams = useSearchParams();
  const fixtureKey = searchParams.get("fx") ?? undefined;

  const [scope, setScope] = useState<string>("series");
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chunkCount, setChunkCount] = useState<number | null>(null);

  const [chars] = useState<CharacterOpt[]>(characters);
  const [facts, setFacts] = useState<FactRow[] | null>(null);
  const [charRows, setCharRows] = useState<CharRow[] | null>(null);
  const [states, setStates] = useState<StateRow[] | null>(null);
  const [parseFailures, setParseFailures] = useState<
    Array<{ chunk: number; error: string; raw: string }>
  >([]);
  const [approvedSummary, setApprovedSummary] = useState<{
    facts: number;
    characters: number;
    states: number;
  } | null>(null);

  const textRef = useRef<HTMLTextAreaElement>(null);
  const focusedOnLoadRef = useRef(false);

  const statesShown = scope !== "series";
  const factsLen = facts?.length ?? 0;
  const charsLen = charRows?.length ?? 0;
  const statesLen = statesShown ? states?.length ?? 0 : 0;
  const totalRows = factsLen + charsLen + statesLen;

  const hasResult = facts !== null;

  // Move focus to the first row exactly once when proposals first land, so the
  // keyboard-driven checklist can be worked immediately. This must NOT refocus on
  // every approve/reject (which change facts/charRows/states), or it would steal
  // focus back to row 0 mid-navigation. A ref latches the one-time focus and resets
  // when the checklist is cleared.
  useEffect(() => {
    if (facts === null) {
      focusedOnLoadRef.current = false;
      return;
    }
    if (!focusedOnLoadRef.current && totalRows > 0) {
      focusedOnLoadRef.current = true;
      document.getElementById("bible-row-0")?.focus();
    }
  }, [facts, totalRows]);

  function matchCharacter(name: string): CharacterOpt | null {
    const t = name.trim().toLowerCase();
    return chars.find((c) => c.name.trim().toLowerCase() === t) ?? null;
  }

  function computeChanges(
    existing: CharacterOpt,
    proposed: {
      role: string | null;
      voiceRules: string | null;
      physical: string | null;
      notes: string | null;
    },
  ): string[] {
    const changes: string[] = [];
    const check = (
      label: string,
      next: string | null,
      prev: string | null,
    ) => {
      const n = (next ?? "").trim();
      if (n && n !== (prev ?? "").trim()) changes.push(label);
    };
    check("role", proposed.role, existing.role);
    check("voice", proposed.voiceRules, existing.voiceRules);
    check("physical", proposed.physical, existing.physical);
    check("notes", proposed.notes, existing.notes);
    return changes;
  }

  async function importBible() {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    setApprovedSummary(null);
    const res = await fetch("/api/bible/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, fixtureKey }),
    });
    setBusy(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Import failed.");
      return;
    }
    const data = (await res.json()) as ImportResponse;
    setChunkCount(data.chunks);
    setParseFailures(data.parseFailures ?? []);
    setFacts(
      (data.facts ?? []).map((f) => ({
        type: f.type,
        content: f.content,
        approved: false,
      })),
    );
    setCharRows(
      (data.characters ?? []).map((c) => {
        const existing = matchCharacter(c.name);
        return {
          name: c.name,
          role: c.role,
          voiceRules: c.voiceRules,
          physical: c.physical,
          notes: c.notes,
          existingId: existing ? existing.id : null,
          existingName: existing ? existing.name : null,
          changes: existing ? computeChanges(existing, c) : [],
          approved: false,
        };
      }),
    );
    setStates(
      (data.states ?? []).map((s) => {
        const existing = matchCharacter(s.character);
        return {
          character: s.character,
          characterId: existing ? existing.id : null,
          knows: s.knows ?? "",
          feels: s.feels ?? "",
          hiding: s.hiding ?? "",
          approved: false,
        };
      }),
    );
  }

  // A state resolves if it is mapped to an existing character, or its name matches a
  // character-creation proposal that is itself approved in this batch (the server
  // creates characters first, then resolves states).
  function approvedCharCreationNames(): Set<string> {
    const out = new Set<string>();
    for (const c of charRows ?? []) {
      if (c.approved && c.existingId === null) {
        out.add(c.name.trim().toLowerCase());
      }
    }
    return out;
  }

  function stateResolvable(s: StateRow): boolean {
    if (s.characterId !== null) return true;
    return approvedCharCreationNames().has(s.character.trim().toLowerCase());
  }

  async function approveChecked() {
    if (!hasResult) return;
    setError(null);
    const approvedFacts = (facts ?? []).filter((f) => f.approved);
    const approvedChars = (charRows ?? []).filter((c) => c.approved);
    const approvedStates = statesShown
      ? (states ?? []).filter((s) => s.approved)
      : [];
    if (
      approvedFacts.length === 0 &&
      approvedChars.length === 0 &&
      approvedStates.length === 0
    ) {
      setError("Approve at least one proposal, or there is nothing to add.");
      return;
    }
    const unresolvable = approvedStates.filter((s) => !stateResolvable(s));
    if (unresolvable.length > 0) {
      setError(
        `Map ${unresolvable
          .map((s) => s.character)
          .join(", ")} to a character, or approve its creation above, before approving.`,
      );
      return;
    }
    setBusy(true);
    const res = await fetch("/api/bible/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        scope: scope === "series" ? "series" : Number(scope),
        facts: approvedFacts.map((f) => ({ type: f.type, content: f.content })),
        characters: approvedChars.map((c) => ({
          id: c.existingId,
          name: c.name,
          role: c.role,
          voiceRules: c.voiceRules,
          physical: c.physical,
          notes: c.notes,
        })),
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
    setApprovedSummary({
      facts: approvedFacts.length,
      characters: approvedChars.length,
      states: approvedStates.length,
    });
    setFacts((prev) => (prev ? prev.filter((f) => !f.approved) : prev));
    setCharRows((prev) => (prev ? prev.filter((c) => !c.approved) : prev));
    setStates((prev) => (prev ? prev.filter((s) => !s.approved) : prev));
  }

  function focusRow(idx: number) {
    const clamped = Math.max(0, Math.min(idx, totalRows - 1));
    document.getElementById(`bible-row-${clamped}`)?.focus();
  }

  function moveOrToggle(
    e: React.KeyboardEvent,
    flat: number,
    approve: (v: boolean) => void,
  ) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      focusRow(flat + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(flat - 1);
    } else if (e.key === "a") {
      approve(true);
    } else if (e.key === "r") {
      approve(false);
    }
  }

  function setFactApproved(i: number, v: boolean) {
    setFacts((p) => (p ? p.map((x, j) => (j === i ? { ...x, approved: v } : x)) : p));
  }
  function setCharApproved(i: number, v: boolean) {
    setCharRows((p) =>
      p ? p.map((x, j) => (j === i ? { ...x, approved: v } : x)) : p,
    );
  }
  function setStateApproved(i: number, v: boolean) {
    setStates((p) => (p ? p.map((x, j) => (j === i ? { ...x, approved: v } : x)) : p));
  }

  return (
    <div>
      {error && (
        <div
          data-testid="bible-error"
          className="mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800"
        >
          {error}
        </div>
      )}

      <div
        className="rounded border border-neutral-200 bg-neutral-50 p-3"
        data-testid="bible-form"
      >
        <label className="mb-2 flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase text-neutral-400">Scope</span>
          <select
            data-testid="bible-scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            disabled={hasResult || busy}
            className="w-64 rounded border border-neutral-300 px-2 py-1"
          >
            <option value="series">Series-wide (all books)</option>
            {projects.map((p) => (
              <option key={p.id} value={String(p.id)}>
                {p.title}
              </option>
            ))}
          </select>
        </label>
        {!statesShown && (
          <p
            className="mb-2 text-xs text-neutral-500"
            data-testid="bible-states-disabled-note"
          >
            Character states need a book scope, so they are not proposed for a
            series-wide import.
          </p>
        )}
        <label className="mb-2 flex flex-col gap-1 text-sm">
          <span className="text-xs uppercase text-neutral-400">Bible text</span>
          <textarea
            ref={textRef}
            data-testid="bible-content"
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={hasResult || busy}
            rows={14}
            className="rounded border border-neutral-300 p-2 font-serif text-sm"
            placeholder="Paste the story bible here: world rules, character sheets, timeline notes, standing decisions."
          />
        </label>

        {!hasResult ? (
          <button
            data-testid="bible-import-button"
            onClick={importBible}
            disabled={busy || !text.trim()}
            className="rounded bg-neutral-900 px-4 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {busy ? "Reading the bible..." : "Read bible"}
          </button>
        ) : (
          <button
            data-testid="bible-reset-button"
            onClick={() => {
              setFacts(null);
              setCharRows(null);
              setStates(null);
              setParseFailures([]);
              setError(null);
              setChunkCount(null);
            }}
            className="rounded border border-neutral-300 px-4 py-1.5 text-sm"
          >
            Start over
          </button>
        )}
      </div>

      {busy && !hasResult && (
        <p data-testid="bible-progress" className="mt-2 text-sm text-sky-700">
          Reading the bible in order...
        </p>
      )}

      {chunkCount !== null && (
        <p className="mt-2 text-xs text-neutral-500" data-testid="bible-chunk-count">
          Processed {chunkCount} chunk{chunkCount === 1 ? "" : "s"}.
        </p>
      )}

      {approvedSummary && (
        <div
          data-testid="bible-approve-success"
          className="mt-3 rounded border border-green-300 bg-green-50 px-3 py-2 text-sm text-green-800"
        >
          Approved {approvedSummary.facts} fact(s), {approvedSummary.characters}{" "}
          character(s), and {approvedSummary.states} state(s).
        </div>
      )}

      {parseFailures.length > 0 && (
        <div className="mt-3" data-testid="bible-parse-failures">
          <p className="text-xs uppercase tracking-wide text-amber-700">
            Some chunks did not parse. Raw model output:
          </p>
          {parseFailures.map((pf) => (
            <pre
              key={pf.chunk}
              data-testid={`bible-parse-failure-${pf.chunk}`}
              className="mt-1 overflow-x-auto rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-900"
            >
              chunk {pf.chunk}: {pf.raw}
            </pre>
          ))}
        </div>
      )}

      {hasResult && (
        <div className="mt-4" data-testid="bible-proposals">
          <p className="mb-2 text-xs uppercase tracking-wide text-neutral-500">
            Proposals (nothing is added until you approve). Arrows move between rows,
            a approves, r rejects.
          </p>

          <p className="mb-1 text-xs font-semibold uppercase text-neutral-400">
            Facts
          </p>
          <ul className="space-y-2" data-testid="bible-fact-proposals">
            {factsLen === 0 && (
              <li className="text-xs text-neutral-400" data-testid="bible-no-facts">
                No fact proposals.
              </li>
            )}
            {(facts ?? []).map((f, i) => (
              <li
                key={`fact-${i}`}
                id={`bible-row-${i}`}
                data-testid={`bible-fact-proposal-${i}`}
                tabIndex={0}
                onKeyDown={(e) => moveOrToggle(e, i, (v) => setFactApproved(i, v))}
                className="rounded border border-neutral-200 bg-white p-2 text-sm focus:border-neutral-500 focus:outline-none"
              >
                <label className="flex items-start gap-2">
                  <input
                    type="checkbox"
                    data-testid={`bible-fact-approve-${i}`}
                    checked={f.approved}
                    onChange={(e) => setFactApproved(i, e.target.checked)}
                    className="mt-1"
                  />
                  <span className="flex-1">
                    <span className="mr-2 rounded bg-neutral-100 px-1.5 py-0.5 text-xs uppercase text-neutral-500">
                      {f.type.replace("_", " ")}
                    </span>
                    {f.content}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <p className="mb-1 mt-3 text-xs font-semibold uppercase text-neutral-400">
            Characters
          </p>
          <ul className="space-y-2" data-testid="bible-character-proposals">
            {charsLen === 0 && (
              <li className="text-xs text-neutral-400" data-testid="bible-no-characters">
                No character proposals.
              </li>
            )}
            {(charRows ?? []).map((c, i) => {
              const flat = factsLen + i;
              return (
                <li
                  key={`char-${i}`}
                  id={`bible-row-${flat}`}
                  data-testid={`bible-character-proposal-${i}`}
                  tabIndex={0}
                  onKeyDown={(e) =>
                    moveOrToggle(e, flat, (v) => setCharApproved(i, v))
                  }
                  className="rounded border border-neutral-200 bg-white p-2 text-sm focus:border-neutral-500 focus:outline-none"
                >
                  <label className="flex items-start gap-2">
                    <input
                      type="checkbox"
                      data-testid={`bible-character-approve-${i}`}
                      checked={c.approved}
                      onChange={(e) => setCharApproved(i, e.target.checked)}
                      className="mt-1"
                    />
                    <span className="flex-1">
                      <span className="font-medium">{c.name}</span>
                      {c.existingId === null ? (
                        <span
                          data-testid={`bible-character-new-${i}`}
                          className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-800"
                        >
                          new character
                        </span>
                      ) : (
                        <span
                          data-testid={`bible-character-update-${i}`}
                          className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
                        >
                          updates {c.existingName}
                          {c.changes.length
                            ? `: ${c.changes.join(", ")} would change`
                            : " (no field changes)"}
                        </span>
                      )}
                      <span className="mt-1 block text-xs text-neutral-500">
                        {c.role && <span className="mr-2">role: {c.role}</span>}
                        {c.voiceRules && (
                          <span className="mr-2">voice: {c.voiceRules}</span>
                        )}
                        {c.physical && (
                          <span className="mr-2">physical: {c.physical}</span>
                        )}
                        {c.notes && <span className="mr-2">notes: {c.notes}</span>}
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>

          {statesShown && (
            <>
              <p className="mb-1 mt-3 text-xs font-semibold uppercase text-neutral-400">
                Character states
              </p>
              <ul className="space-y-2" data-testid="bible-state-proposals">
                {statesLen === 0 && (
                  <li
                    className="text-xs text-neutral-400"
                    data-testid="bible-no-states"
                  >
                    No character-state proposals.
                  </li>
                )}
                {(states ?? []).map((s, i) => {
                  const flat = factsLen + charsLen + i;
                  const willCreate = approvedCharCreationNames().has(
                    s.character.trim().toLowerCase(),
                  );
                  return (
                    <li
                      key={`state-${i}`}
                      id={`bible-row-${flat}`}
                      data-testid={`bible-state-proposal-${i}`}
                      tabIndex={0}
                      onKeyDown={(e) =>
                        moveOrToggle(e, flat, (v) => setStateApproved(i, v))
                      }
                      className="rounded border border-neutral-200 bg-white p-2 text-sm focus:border-neutral-500 focus:outline-none"
                    >
                      <label className="flex items-start gap-2">
                        <input
                          type="checkbox"
                          data-testid={`bible-state-approve-${i}`}
                          checked={s.approved}
                          onChange={(e) => setStateApproved(i, e.target.checked)}
                          className="mt-1"
                        />
                        <span className="flex-1">
                          <span className="font-medium">{s.character}</span>
                          {s.characterId !== null ? null : willCreate ? (
                            <span
                              data-testid={`bible-state-batch-${i}`}
                              className="ml-2 rounded bg-sky-100 px-1.5 py-0.5 text-xs text-sky-800"
                            >
                              will be created in this batch
                            </span>
                          ) : (
                            <span
                              data-testid={`bible-state-unmatched-${i}`}
                              className="ml-2 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-800"
                            >
                              unmatched: map, or approve its creation above
                            </span>
                          )}
                          <span className="mt-1 grid grid-cols-1 gap-1">
                            <BibleStateField
                              label="knows"
                              value={s.knows}
                              onChange={(v) =>
                                setStates((p) =>
                                  p
                                    ? p.map((x, j) =>
                                        j === i ? { ...x, knows: v } : x,
                                      )
                                    : p,
                                )
                              }
                              testid={`bible-state-knows-${i}`}
                            />
                            <BibleStateField
                              label="feels"
                              value={s.feels}
                              onChange={(v) =>
                                setStates((p) =>
                                  p
                                    ? p.map((x, j) =>
                                        j === i ? { ...x, feels: v } : x,
                                      )
                                    : p,
                                )
                              }
                              testid={`bible-state-feels-${i}`}
                            />
                            <BibleStateField
                              label="hiding"
                              value={s.hiding}
                              onChange={(v) =>
                                setStates((p) =>
                                  p
                                    ? p.map((x, j) =>
                                        j === i ? { ...x, hiding: v } : x,
                                      )
                                    : p,
                                )
                              }
                              testid={`bible-state-hiding-${i}`}
                            />
                          </span>
                          <span className="mt-1 flex items-center gap-2">
                            <select
                              aria-label={`Map ${s.character}`}
                              data-testid={`bible-state-character-select-${i}`}
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
                          </span>
                        </span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </>
          )}

          <button
            data-testid="bible-approve-button"
            onClick={approveChecked}
            disabled={busy}
            className="mt-3 rounded bg-neutral-900 px-4 py-1.5 text-sm text-white disabled:opacity-50"
          >
            Approve checked proposals
          </button>
        </div>
      )}
    </div>
  );
}

function BibleStateField({
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
