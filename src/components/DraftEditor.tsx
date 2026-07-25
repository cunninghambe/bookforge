"use client";

import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

const CONTROL_DELIM = "\n<<<BOOKFORGE_CTRL>>>\n";

interface ControlFrame {
  finalText: string;
  retried: boolean;
  emDashUnresolved: boolean;
  missingFacts: string[];
  canonTensions: string[];
  warnings: string[];
  error?: string;
}

const CANON_TYPES = [
  "world_rule",
  "character_fact",
  "plot_decision",
  "timeline_event",
] as const;

export function DraftEditor({
  chapterId,
  beats,
  pov,
  initialContent,
}: {
  chapterId: number;
  beats: string[];
  pov: string;
  initialContent: string;
}) {
  const searchParams = useSearchParams();
  const fixtureKey = searchParams.get("fx") ?? undefined;

  const [content, setContent] = useState(initialContent);
  const [selected, setSelected] = useState<Set<number>>(
    new Set(beats.length ? [0] : []),
  );
  const [streaming, setStreaming] = useState(false);
  const [missingFacts, setMissingFacts] = useState<string[]>([]);
  const [canonTensions, setCanonTensions] = useState<string[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [retried, setRetried] = useState(false);
  const [emDashUnresolved, setEmDashUnresolved] = useState(false);
  const [saved, setSaved] = useState(false);
  const segmentStartRef = useRef<number>(initialContent.length);

  const selectedBeats = useMemo(
    () => [...selected].sort((a, b) => a - b),
    [selected],
  );

  function toggleBeat(i: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(i)) next.delete(i);
      else next.add(i);
      return next;
    });
  }

  async function generate(mode: "continue" | "redraft") {
    if (streaming) return;
    setStreaming(true);
    setMissingFacts([]);
    setCanonTensions([]);
    setWarnings([]);
    setRetried(false);
    setEmDashUnresolved(false);

    // Redraft: drop the last generated segment first.
    let base = content;
    if (mode === "redraft") {
      base = content.slice(0, segmentStartRef.current);
    } else {
      segmentStartRef.current = content.length;
    }
    const prefix = mode === "redraft" ? base : content;
    const separator = prefix.length > 0 ? "\n\n" : "";
    setContent(prefix + separator);
    const streamStart = prefix.length + separator.length;
    segmentStartRef.current = mode === "redraft" ? prefix.length : segmentStartRef.current;

    const res = await fetch(`/api/chapters/${chapterId}/draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        beats: selectedBeats,
        draftedSoFar: base,
        fixtureKey,
      }),
    });

    if (!res.body) {
      setStreaming(false);
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let controlSeen = false;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      // A23.5 / D189: scan from the END. Prose that contains the delimiter
      // (manuscript text can instruct the model to emit it) would otherwise
      // hide everything after it from the author. The server always writes the
      // genuine frame last, so lastIndexOf is strictly correct.
      const delimIdx = buffer.lastIndexOf(CONTROL_DELIM);
      if (delimIdx === -1) {
        // Still streaming prose. Show it live.
        setContent(prefix + separator + buffer);
      } else {
        controlSeen = true;
        const prose = buffer.slice(0, delimIdx);
        setContent(prefix + separator + prose);
      }
    }

    // Parse the trailing control frame. D189: the genuine frame is the last one.
    const delimIdx = buffer.lastIndexOf(CONTROL_DELIM);
    if (delimIdx !== -1) {
      const json = buffer.slice(delimIdx + CONTROL_DELIM.length);
      try {
        const control = JSON.parse(json) as ControlFrame;
        if (control.error) {
          setWarnings([`Draft error: ${control.error}`]);
        } else {
          // Replace the streamed segment with the clean, marker-stripped text.
          const finalContent = prefix + separator + control.finalText;
          setContent(finalContent);
          segmentStartRef.current = prefix.length + separator.length;
          setMissingFacts(control.missingFacts ?? []);
          setCanonTensions(control.canonTensions ?? []);
          setWarnings(control.warnings ?? []);
          setRetried(control.retried);
          setEmDashUnresolved(control.emDashUnresolved);
          // Auto-save the working draft.
          void save(finalContent);
        }
      } catch {
        setWarnings(["Could not parse the draft control frame."]);
      }
    }
    void controlSeen;
    setStreaming(false);
  }

  async function save(text?: string) {
    const body = text ?? content;
    await fetch(`/api/chapters/${chapterId}/save-draft`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: body }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  }

  return (
    <div className="mt-4 grid grid-cols-1 gap-6 sm:grid-cols-[1fr_18rem]">
      <div>
        {(retried ||
          emDashUnresolved ||
          missingFacts.length > 0 ||
          canonTensions.length > 0 ||
          warnings.length > 0) && (
          <div className="mb-3 space-y-2" data-testid="alerts">
            {retried && (
              <Alert kind="info" testid="retry-alert">
                An em-dash was detected and the scene was regenerated without it.
              </Alert>
            )}
            {emDashUnresolved && (
              <Alert kind="warn" testid="emdash-unresolved">
                The regenerated draft still contains an em-dash. Edit it out before
                locking.
              </Alert>
            )}
            {canonTensions.map((t, i) => (
              <Alert kind="warn" testid="canon-tension" key={`t${i}`}>
                Canon tension: {t}
              </Alert>
            ))}
            {missingFacts.map((f, i) => (
              <MissingFactAlert
                key={`m${i}`}
                text={f}
                onAdded={() => generate("redraft")}
              />
            ))}
            {warnings.map((w, i) => (
              <Alert kind="warn" testid="assembler-warning" key={`w${i}`}>
                {w}
              </Alert>
            ))}
          </div>
        )}

        <textarea
          aria-label="Draft"
          data-testid="draft-editor"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          rows={28}
          className="w-full max-w-[70ch] rounded border border-edge bg-surface p-4 font-serif text-[15px] leading-relaxed text-ink"
        />
        <div className="mt-3 flex items-center gap-3">
          <button
            data-testid="continue-button"
            onClick={() => generate("continue")}
            disabled={streaming || selectedBeats.length === 0}
            className="rounded bg-accent hover:bg-accent-hover px-4 py-1.5 text-accent-ink disabled:opacity-50"
          >
            {streaming ? "Drafting..." : "Continue"}
          </button>
          <button
            data-testid="redraft-button"
            onClick={() => generate("redraft")}
            disabled={streaming}
            className="rounded border border-edge px-4 py-1.5 disabled:opacity-50"
          >
            Redraft
          </button>
          <button
            data-testid="save-draft-button"
            onClick={() => save()}
            disabled={streaming}
            className="rounded border border-edge px-4 py-1.5 disabled:opacity-50"
          >
            Save
          </button>
          {saved && <span className="text-sm text-ok-ink">Saved</span>}
        </div>
      </div>

      <aside className="text-sm">
        <h2 className="mb-2 text-xs uppercase tracking-wide text-faint">
          Beats to draft
        </h2>
        <p className="mb-2 text-xs text-faint">POV: {pov}</p>
        <ul className="space-y-1" data-testid="beat-picker">
          {beats.map((b, i) => (
            <li key={i}>
              <label className="flex items-start gap-2">
                <input
                  type="checkbox"
                  data-testid={`beat-check-${i}`}
                  checked={selected.has(i)}
                  onChange={() => toggleBeat(i)}
                  className="mt-1"
                />
                <span>
                  <span className="text-faint">{i + 1}. </span>
                  {b}
                </span>
              </label>
            </li>
          ))}
          {beats.length === 0 && (
            <li className="text-faint">No beats. Add beats in the sequencer.</li>
          )}
        </ul>
      </aside>
    </div>
  );
}

function Alert({
  kind,
  children,
  testid,
}: {
  kind: "info" | "warn";
  children: React.ReactNode;
  testid?: string;
}) {
  const cls =
    kind === "warn"
      ? "border-warn-edge bg-warn text-warn-ink"
      : "border-info-edge bg-info text-info-ink";
  return (
    <div
      data-testid={testid}
      className={`rounded border px-3 py-2 text-sm ${cls}`}
    >
      {children}
    </div>
  );
}

function MissingFactAlert({
  text,
  onAdded,
}: {
  text: string;
  onAdded: () => void;
}) {
  const [type, setType] = useState<string>("character_fact");
  const [content, setContent] = useState(text);
  const [added, setAdded] = useState(false);

  async function add() {
    await fetch("/api/canon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type, content, status: "locked", source: "manual" }),
    });
    setAdded(true);
  }

  return (
    <div
      data-testid="missing-fact"
      className="rounded border border-warn-edge bg-warn px-3 py-2 text-warn-ink"
    >
      <p className="mb-1 font-medium">Missing fact: {text}</p>
      {!added ? (
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Missing fact type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            className="rounded border border-warn-edge bg-surface px-2 py-1 text-xs"
          >
            {CANON_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <input
            aria-label="Missing fact answer"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            className="min-w-[16rem] flex-1 rounded border border-warn-edge px-2 py-1 text-xs"
          />
          <button
            data-testid="add-fact-button"
            onClick={add}
            className="rounded bg-accent hover:bg-accent-hover px-2 py-1 text-xs text-accent-ink"
          >
            Add to canon (locked)
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-ok-ink">Added and locked.</span>
          <button
            data-testid="redraft-after-fact"
            onClick={onAdded}
            className="rounded border border-warn-edge px-2 py-1"
          >
            Redraft with this fact
          </button>
        </div>
      )}
    </div>
  );
}
