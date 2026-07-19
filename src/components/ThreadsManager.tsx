"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { orderToUiChapter, uiChapterToOrder } from "@/lib/chapterNumbering";
import { buildBraidLayout, type BraidChapterInput, type BraidThreadInput, type BraidTouchInput } from "@/lib/braidLayout";
import { BraidView } from "./BraidView";
import { ScanPanel } from "./ScanPanel";

// Amendment A12 (phase 2): the threads page. Mirrors the CanonManager pattern
// (sequence-guarded fetch, highlight scroll-and-flash) but with a second data
// source (chapters) so buildBraidLayout has what it needs, and a shared
// selection state so the list and the braid are two views of one thread.

const THREAD_TYPES = ["arc", "mystery", "promise", "relationship"] as const;
type ThreadType = (typeof THREAD_TYPES)[number];
const TOUCH_KINDS = ["advance", "complicate", "payoff", "mention"] as const;
type TouchKind = (typeof TOUCH_KINDS)[number];

const TYPE_LABEL: Record<ThreadType, string> = {
  arc: "arc",
  mystery: "mystery",
  promise: "promise",
  relationship: "relationship",
};

interface Touch {
  id: number;
  threadId: number;
  chapterId: number;
  chapter: number; // 1-based (A2)
  kind: TouchKind;
  evidence: string | null;
  source: string | null;
}
interface Flags {
  stale: boolean;
  orphan: boolean;
}
interface ThreadRow {
  id: number;
  projectId: number | null;
  name: string;
  type: ThreadType;
  status: "open" | "resolved" | "retired";
  characterAId: number | null;
  characterBId: number | null;
  note: string | null;
  flags: Flags;
  touches: Touch[];
}
interface ChapterRow {
  id: number;
  orderIndex: number;
  status: string;
  title: string | null;
}
interface Character {
  id: number;
  name: string;
}

export function ThreadsManager({
  projectId,
  seriesId,
  highlightId,
}: {
  projectId: number;
  seriesId?: number | null;
  highlightId?: number | null;
}) {
  const [threads, setThreads] = useState<ThreadRow[]>([]);
  const [chapters, setChapters] = useState<ChapterRow[]>([]);
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  // A11-style deep link: ?highlight=<id> scrolls to that row and flashes it.
  const [flashId, setFlashId] = useState<number | null>(null);
  const flashedForRef = useRef<number | null>(null);
  const requestIdRef = useRef(0);

  const load = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    const charactersUrl =
      seriesId === null || seriesId === undefined
        ? `/api/characters`
        : `/api/characters?seriesId=${seriesId}`;
    const [threadsRes, chaptersRes, charactersRes] = await Promise.all([
      fetch(`/api/threads?projectId=${projectId}`),
      fetch(`/api/chapters?projectId=${projectId}`),
      fetch(charactersUrl),
    ]);
    const threadsData = await threadsRes.json().catch(() => ({}));
    const chaptersData = await chaptersRes.json().catch(() => ({}));
    const charactersData = await charactersRes.json().catch(() => ({}));
    if (requestIdRef.current !== requestId) return;
    setThreads(threadsData.threads ?? []);
    setChapters(chaptersData.chapters ?? []);
    setCharacters(charactersData.characters ?? []);
    setLoading(false);
  }, [projectId, seriesId]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (highlightId && highlightId !== flashedForRef.current) load();
  }, [highlightId, load]);

  useEffect(() => {
    if (loading || !highlightId || flashedForRef.current === highlightId) return;
    const el = document.getElementById(`thread-${highlightId}`);
    if (!el) return;
    flashedForRef.current = highlightId;
    el.scrollIntoView({ block: "center" });
    setFlashId(highlightId);
    const t = setTimeout(() => setFlashId(null), 2000);
    return () => clearTimeout(t);
  }, [loading, highlightId]);

  // The pure geometry. Touches arrive from the API with a 1-based chapter
  // number (A2); the conversion back to the 0-based DB value buildBraidLayout
  // expects happens here, via chapterNumbering, and nowhere else.
  const layout = useMemo(() => {
    const braidThreads: BraidThreadInput[] = threads.map((t) => ({
      id: t.id,
      name: t.name,
      type: t.type,
      status: t.status,
    }));
    const braidTouches: BraidTouchInput[] = threads.flatMap((t) =>
      t.touches.map((touch) => ({
        threadId: t.id,
        chapterOrder: uiChapterToOrder(touch.chapter),
        kind: touch.kind,
        evidence: touch.evidence,
      })),
    );
    const braidChapters: BraidChapterInput[] = chapters.map((c) => ({
      id: c.id,
      orderIndex: c.orderIndex,
      status: c.status,
      title: c.title,
    }));
    return buildBraidLayout(braidThreads, braidTouches, braidChapters);
  }, [threads, chapters]);

  // A17: the scan runs over the book's LOCKED chapters. The touched-chapter set
  // (drawn from the loaded threads) lets the estimate skip chapters that already
  // have touches, matching the server's default range.
  const lockedChapters = useMemo(
    () =>
      chapters
        .filter((c) => c.status === "locked")
        .map((c) => ({
          id: c.id,
          orderIndex: c.orderIndex,
          title: c.title || `Chapter ${orderToUiChapter(c.orderIndex)}`,
        })),
    [chapters],
  );
  const touchedChapterIds = useMemo(
    () => threads.flatMap((t) => t.touches.map((touch) => touch.chapterId)),
    [threads],
  );

  const threadsById = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  // The list mirrors the braid's row order exactly, so the two panels stay
  // pixel-aligned as one selection (SPEC: "two views of one selection").
  const orderedThreads = layout.rows
    .map((r) => threadsById.get(r.threadId))
    .filter((t): t is ThreadRow => Boolean(t));

  return (
    <div>
      <NewThreadForm projectId={projectId} characters={characters} onCreated={load} />

      <ScanPanel
        projectId={projectId}
        lockedChapters={lockedChapters}
        touchedChapterIds={touchedChapterIds}
        startInvited={!loading && threads.length === 0 && lockedChapters.length > 0}
        onApproved={load}
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-[380px_1fr]">
        <div className="min-w-0">
          <ul className="divide-y divide-edge-soft" data-testid="threads-list">
            {loading && <li className="py-3 text-sm text-faint">Loading...</li>}
            {!loading && threads.length === 0 && (
              <li className="py-6 text-sm text-muted">
                Threads track the promises, mysteries, and relationships running
                through this book. Add the first one above to start weaving the
                braid.
              </li>
            )}
            {orderedThreads.map((t) => (
              <ThreadListRow
                key={t.id}
                thread={t}
                chapters={chapters}
                projectId={projectId}
                selected={selectedId === t.id}
                flash={flashId === t.id}
                onSelect={() => setSelectedId(t.id)}
                onChanged={load}
              />
            ))}
          </ul>
        </div>
        {/* A15: min-w-0 lets this grid cell shrink below the braid SVG's
            intrinsic width so BraidView's own overflow-x-auto container is what
            scrolls on a narrow screen, not the page body (a well-known CSS grid
            trap: without it, the track grows to fit the content's min-content
            size and forces page-level horizontal scroll). */}
        <div className="min-w-0">
          <BraidView
            layout={layout}
            chapters={chapters}
            projectId={projectId}
            selectedThreadId={selectedId}
            onSelectThread={setSelectedId}
          />
        </div>
      </div>
    </div>
  );
}

function staleGap(thread: ThreadRow, chapters: ChapterRow[]): number | null {
  if (thread.touches.length === 0) return null;
  const lockedUi = chapters
    .filter((c) => c.status === "locked")
    .map((c) => orderToUiChapter(c.orderIndex));
  if (lockedUi.length === 0) return null;
  const maxLockedUi = Math.max(...lockedUi);
  const latestTouchUi = Math.max(...thread.touches.map((t) => t.chapter));
  return maxLockedUi - latestTouchUi;
}

function NewThreadForm({
  projectId,
  characters,
  onCreated,
}: {
  projectId: number;
  characters: Character[];
  onCreated: () => void;
}) {
  const [name, setName] = useState("");
  const [type, setType] = useState<ThreadType>("arc");
  const [characterAId, setCharacterAId] = useState("");
  const [characterBId, setCharacterBId] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length === 0) return;
    setBusy(true);
    await fetch("/api/threads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: name.trim(),
        type,
        projectId,
        characterAId:
          type === "relationship" && characterAId ? Number(characterAId) : undefined,
        characterBId:
          type === "relationship" && characterBId ? Number(characterBId) : undefined,
      }),
    });
    setBusy(false);
    setName("");
    setCharacterAId("");
    setCharacterBId("");
    onCreated();
  }

  return (
    <form
      onSubmit={submit}
      data-testid="new-thread-form"
      className="flex flex-wrap items-end gap-2 rounded border border-edge-soft bg-surface p-3 text-sm"
    >
      <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-faint">
        Name
        <input
          aria-label="New thread name"
          data-testid="new-thread-name"
          placeholder="Thread name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className="min-w-[16rem] rounded border border-edge px-2 py-1 text-sm normal-case tracking-normal text-ink"
        />
      </label>
      <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-faint">
        Type
        <select
          aria-label="New thread type"
          data-testid="new-thread-type"
          value={type}
          onChange={(e) => setType(e.target.value as ThreadType)}
          className="rounded border border-edge px-2 py-1 text-sm normal-case tracking-normal text-ink"
        >
          {THREAD_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      {type === "relationship" && (
        <>
          <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-faint">
            Character A
            <select
              aria-label="Character A"
              data-testid="new-thread-character-a"
              value={characterAId}
              onChange={(e) => setCharacterAId(e.target.value)}
              className="rounded border border-edge px-2 py-1 text-sm normal-case tracking-normal text-ink"
            >
              <option value="">(none)</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-faint">
            Character B
            <select
              aria-label="Character B"
              data-testid="new-thread-character-b"
              value={characterBId}
              onChange={(e) => setCharacterBId(e.target.value)}
              className="rounded border border-edge px-2 py-1 text-sm normal-case tracking-normal text-ink"
            >
              <option value="">(none)</option>
              {characters.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      <button
        type="submit"
        disabled={busy || name.trim().length === 0}
        className="btn-primary px-3 py-1 text-sm"
      >
        Add thread
      </button>
    </form>
  );
}

function ThreadListRow({
  thread,
  chapters,
  projectId,
  selected,
  flash,
  onSelect,
  onChanged,
}: {
  thread: ThreadRow;
  chapters: ChapterRow[];
  projectId: number;
  selected: boolean;
  flash: boolean;
  onSelect: () => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(thread.name);
  const [note, setNote] = useState(thread.note ?? "");
  const [busy, setBusy] = useState(false);

  async function patch(body: Record<string, unknown>) {
    setBusy(true);
    await fetch(`/api/threads/${thread.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    setBusy(false);
    onChanged();
  }

  const retired = thread.status === "retired";
  const gap = thread.flags.stale ? staleGap(thread, chapters) : null;
  const hasPayoff = thread.touches.some((t) => t.kind === "payoff");
  const showNudge = thread.status === "open" && hasPayoff;

  return (
    <li
      id={`thread-${thread.id}`}
      data-testid="thread-row"
      data-thread-id={thread.id}
      data-status={thread.status}
      onMouseEnter={onSelect}
      onFocus={onSelect}
      className={`py-3 text-sm ${retired ? "opacity-50" : ""} ${
        selected ? "bg-inset" : ""
      } ${flash ? " rounded ring-2 ring-focus" : ""}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="flex flex-col gap-2">
              <input
                aria-label="Edit thread name"
                data-testid="edit-thread-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="rounded border border-edge px-2 py-1"
              />
              <input
                aria-label="Edit thread note"
                data-testid="edit-thread-note"
                placeholder="Note (intended payoff, etc.)"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                className="rounded border border-edge px-2 py-1"
              />
              <div className="flex gap-2">
                <button
                  data-testid="save-thread-edit"
                  disabled={busy}
                  onClick={async () => {
                    await patch({ name: name.trim() || thread.name, note });
                    setEditing(false);
                  }}
                  className="btn-secondary px-2 py-1 text-xs"
                >
                  Save
                </button>
                <button
                  onClick={() => {
                    setName(thread.name);
                    setNote(thread.note ?? "");
                    setEditing(false);
                  }}
                  className="btn-quiet px-2 py-1 text-xs"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{thread.name}</span>
              <span className="rounded bg-chip px-1.5 py-0.5 text-xs uppercase text-muted">
                {thread.type}
              </span>
              <span data-testid="thread-status" className="text-xs text-faint">
                {thread.status}
              </span>
              {thread.flags.stale && (
                <span
                  data-testid="thread-flag"
                  data-flag={thread.flags.orphan ? "orphan" : "stale"}
                  className="rounded bg-warn-chip px-1.5 py-0.5 text-xs text-warn-ink"
                >
                  {thread.flags.orphan
                    ? "introduced and never developed"
                    : `gone quiet for ${gap ?? "several"} chapters`}
                </span>
              )}
            </div>
          )}
          {thread.note && !editing && (
            <p className="mt-1 text-xs text-faint">{thread.note}</p>
          )}
          {showNudge && (
            <p data-testid="thread-payoff-nudge" className="mt-1 text-xs text-muted">
              Payoff recorded. Resolve?{" "}
              <button
                onClick={() => patch({ status: "resolved" })}
                className="underline"
              >
                Resolve
              </button>
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 text-xs">
          <button
            onClick={() => setExpanded((e) => !e)}
            className="btn-quiet"
          >
            {expanded ? "Collapse" : "Expand"}
          </button>
          {!editing && (
            <button onClick={() => setEditing(true)} className="btn-quiet">
              Edit
            </button>
          )}
          {thread.status === "open" && (
            <button
              data-testid="thread-resolve"
              disabled={busy}
              onClick={() => patch({ status: "resolved" })}
              className="btn-quiet"
            >
              Resolve
            </button>
          )}
          {thread.status !== "retired" && (
            <button
              data-testid="thread-retire"
              disabled={busy}
              onClick={() => patch({ status: "retired" })}
              className="btn-quiet"
            >
              Retire
            </button>
          )}
        </div>
      </div>

      {expanded && (
        <div className="mt-2 space-y-2 rounded border border-edge-soft bg-surface p-2">
          <ul data-testid="thread-touches" className="space-y-1 text-xs">
            {thread.touches.length === 0 && (
              <li className="text-faint">No touches yet.</li>
            )}
            {thread.touches.map((t) => (
              <li key={t.id} className="rounded bg-inset px-2 py-1">
                ch {t.chapter}: <b>{t.kind}</b>
                {t.evidence && <> - &ldquo;{t.evidence}&rdquo;</>}
              </li>
            ))}
          </ul>
          <AddTouchForm threadId={thread.id} projectId={projectId} onAdded={onChanged} />
        </div>
      )}
    </li>
  );
}

function AddTouchForm({
  threadId,
  projectId,
  onAdded,
}: {
  threadId: number;
  projectId: number;
  onAdded: () => void;
}) {
  const [uiChapter, setUiChapter] = useState("1");
  const [kind, setKind] = useState<TouchKind>("advance");
  const [evidence, setEvidence] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const chapterNum = Number(uiChapter);
    if (!Number.isInteger(chapterNum) || chapterNum < 1) return;
    setBusy(true);
    await fetch(`/api/threads/${threadId}/touches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chapter: chapterNum, kind, evidence, projectId }),
    });
    setBusy(false);
    setEvidence("");
    onAdded();
  }

  return (
    <form
      onSubmit={submit}
      data-testid="add-touch-form"
      className="flex flex-wrap items-end gap-2 text-xs"
    >
      <label className="flex flex-col gap-1">
        Chapter
        <input
          aria-label="Touch chapter"
          data-testid="touch-chapter-input"
          type="number"
          min={1}
          value={uiChapter}
          onChange={(e) => setUiChapter(e.target.value)}
          className="w-16 rounded border border-edge px-2 py-1"
        />
      </label>
      <label className="flex flex-col gap-1">
        Kind
        <select
          aria-label="Touch kind"
          data-testid="touch-kind-select"
          value={kind}
          onChange={(e) => setKind(e.target.value as TouchKind)}
          className="rounded border border-edge px-2 py-1"
        >
          {TOUCH_KINDS.map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-1 flex-col gap-1">
        Evidence
        <input
          aria-label="Touch evidence"
          data-testid="touch-evidence-input"
          placeholder="verbatim quote (optional)"
          value={evidence}
          onChange={(e) => setEvidence(e.target.value)}
          className="w-full rounded border border-edge px-2 py-1"
        />
      </label>
      <button
        type="submit"
        data-testid="add-touch-button"
        disabled={busy}
        className="btn-secondary px-2 py-1"
      >
        Add touch
      </button>
    </form>
  );
}
