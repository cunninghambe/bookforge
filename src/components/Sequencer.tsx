"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";

interface Chapter {
  id: number;
  projectId: number;
  orderIndex: number;
  title: string | null;
  pov: string | null;
  synopsis: string | null;
  beats: string[];
  status: string;
}
interface Question {
  id: number;
  question: string;
  answer: string | null;
  resultingFactId: number | null;
}

export function Sequencer({ projectId }: { projectId: number }) {
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [newTitle, setNewTitle] = useState("");

  const load = useCallback(async () => {
    const res = await fetch(`/api/chapters?projectId=${projectId}`);
    const data = await res.json();
    setChapters(data.chapters ?? []);
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  async function addChapter(e: React.FormEvent) {
    e.preventDefault();
    if (newTitle.trim().length === 0) return;
    await fetch("/api/chapters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, title: newTitle.trim() }),
    });
    setNewTitle("");
    load();
  }

  async function move(index: number, dir: -1 | 1) {
    const target = index + dir;
    if (target < 0 || target >= chapters.length) return;
    const ids = chapters.map((c) => c.id);
    [ids[index], ids[target]] = [ids[target], ids[index]];
    await fetch("/api/chapters/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectId, orderedIds: ids }),
    });
    load();
  }

  return (
    <div>
      <form onSubmit={addChapter} className="flex flex-wrap items-center gap-2 text-sm">
        <input
          aria-label="New chapter title"
          data-testid="add-chapter-input"
          placeholder="New chapter title"
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          className="min-w-[20rem] flex-1 rounded border border-edge px-2 py-1"
        />
        <button
          type="submit"
          data-testid="add-chapter-button"
          className="rounded bg-accent hover:bg-accent-hover px-3 py-1 text-accent-ink"
        >
          + Add chapter
        </button>
      </form>

      <ol className="mt-4 space-y-2" data-testid="chapter-list">
        {chapters.map((c, i) => (
          <ChapterRow
            key={c.id}
            chapter={c}
            index={i}
            count={chapters.length}
            onMove={move}
            onChanged={load}
          />
        ))}
        {chapters.length === 0 && (
          <li className="py-4 text-sm text-muted">
            No chapters yet. Add the first one above to start sequencing the book.
          </li>
        )}
      </ol>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  return (
    <span
      data-testid="status-pill"
      className="rounded-full bg-chip px-2 py-0.5 text-xs uppercase tracking-wide text-muted"
    >
      {status}
    </span>
  );
}

function ChapterRow({
  chapter,
  index,
  count,
  onMove,
  onChanged,
}: {
  chapter: Chapter;
  index: number;
  count: number;
  onMove: (index: number, dir: -1 | 1) => void;
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <li
      className="rounded border border-edge-soft bg-surface p-3"
      data-testid="chapter-row"
      data-chapter-id={chapter.id}
      data-status={chapter.status}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col">
          <button
            aria-label="Move up"
            data-testid="move-up"
            disabled={index === 0}
            onClick={() => onMove(index, -1)}
            className="text-xs text-faint disabled:opacity-30"
          >
            &#9650;
          </button>
          <button
            aria-label="Move down"
            data-testid="move-down"
            disabled={index === count - 1}
            onClick={() => onMove(index, 1)}
            className="text-xs text-faint disabled:opacity-30"
          >
            &#9660;
          </button>
        </div>
        <span className="w-6 text-sm text-faint">{index + 1}</span>
        <span data-testid="chapter-title" className="flex-1 font-medium">
          {chapter.title || "Untitled"}
        </span>
        <span className="text-sm text-muted">
          {chapter.pov || "no POV"}
        </span>
        <StatusPill status={chapter.status} />
        <button
          onClick={() => setExpanded((e) => !e)}
          className="text-sm text-muted hover:underline"
        >
          {expanded ? "Close" : "Edit"}
        </button>
      </div>
      {expanded && (
        <ChapterEditor chapter={chapter} onChanged={onChanged} />
      )}
    </li>
  );
}

function ChapterEditor({
  chapter,
  onChanged,
}: {
  chapter: Chapter;
  onChanged: () => void;
}) {
  const [pov, setPov] = useState(chapter.pov ?? "");
  const [synopsis, setSynopsis] = useState(chapter.synopsis ?? "");
  const [beats, setBeats] = useState<string[]>(chapter.beats);
  const [newBeat, setNewBeat] = useState("");
  const [saved, setSaved] = useState(false);

  async function save() {
    await fetch(`/api/chapters/${chapter.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pov, synopsis, beats }),
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
    onChanged();
  }

  function moveBeat(i: number, dir: -1 | 1) {
    const t = i + dir;
    if (t < 0 || t >= beats.length) return;
    const next = [...beats];
    [next[i], next[t]] = [next[t], next[i]];
    setBeats(next);
  }

  return (
    <div className="mt-3 space-y-3 border-t border-edge-soft pt-3 text-sm">
      <label className="block">
        <span className="text-xs uppercase text-faint">POV</span>
        <input
          aria-label="POV"
          data-testid="pov-input"
          value={pov}
          onChange={(e) => setPov(e.target.value)}
          className="mt-1 w-full rounded border border-edge px-2 py-1"
        />
      </label>
      <label className="block">
        <span className="text-xs uppercase text-faint">Synopsis</span>
        <textarea
          aria-label="Synopsis"
          data-testid="synopsis-input"
          value={synopsis}
          onChange={(e) => setSynopsis(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded border border-edge px-2 py-1"
        />
      </label>
      <div>
        <span className="text-xs uppercase text-faint">Beats</span>
        <ol className="mt-1 space-y-1" data-testid="beat-list">
          {beats.map((b, i) => (
            <li key={i} className="flex items-center gap-2" data-testid="beat-item">
              <span className="w-5 text-faint">{i + 1}</span>
              <span className="flex-1">{b}</span>
              <button
                aria-label="Beat up"
                onClick={() => moveBeat(i, -1)}
                className="text-faint"
              >
                &#9650;
              </button>
              <button
                aria-label="Beat down"
                onClick={() => moveBeat(i, 1)}
                className="text-faint"
              >
                &#9660;
              </button>
              <button
                aria-label="Remove beat"
                onClick={() => setBeats(beats.filter((_, j) => j !== i))}
                className="text-danger-ink"
              >
                &times;
              </button>
            </li>
          ))}
        </ol>
        <div className="mt-2 flex items-center gap-2">
          <input
            aria-label="New beat"
            data-testid="beat-input"
            value={newBeat}
            onChange={(e) => setNewBeat(e.target.value)}
            placeholder="Add a beat"
            className="flex-1 rounded border border-edge px-2 py-1"
            onKeyDown={(e) => {
              if (e.key === "Enter" && newBeat.trim()) {
                e.preventDefault();
                setBeats([...beats, newBeat.trim()]);
                setNewBeat("");
              }
            }}
          />
          <button
            data-testid="add-beat"
            onClick={() => {
              if (newBeat.trim()) {
                setBeats([...beats, newBeat.trim()]);
                setNewBeat("");
              }
            }}
            className="rounded border border-edge px-3 py-1"
          >
            Add beat
          </button>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <button
          data-testid="save-chapter"
          onClick={save}
          className="rounded bg-accent hover:bg-accent-hover px-3 py-1 text-accent-ink"
        >
          Save chapter
        </button>
        {saved && <span className="text-ok-ink">Saved</span>}
      </div>

      <InterrogationPanel chapter={chapter} onChanged={onChanged} />
    </div>
  );
}

function InterrogationPanel({
  chapter,
  onChanged,
}: {
  chapter: Chapter;
  onChanged: () => void;
}) {
  const [questions, setQuestions] = useState<Question[]>([]);
  const [busy, setBusy] = useState(false);
  const [lockedFacts, setLockedFacts] = useState<Record<number, string>>({});

  const loadQuestions = useCallback(async () => {
    const res = await fetch(`/api/chapters/${chapter.id}/questions`);
    if (res.ok) {
      const data = await res.json();
      setQuestions(data.questions ?? []);
    }
  }, [chapter.id]);

  useEffect(() => {
    loadQuestions();
  }, [loadQuestions]);

  async function interrogate() {
    setBusy(true);
    const res = await fetch(`/api/chapters/${chapter.id}/interrogate`, {
      method: "POST",
    });
    setBusy(false);
    if (res.ok) {
      const data = await res.json();
      setQuestions(data.questions ?? []);
      onChanged();
    }
  }

  const unanswered = questions.filter((q) => !q.answer).length;

  return (
    <div className="mt-4 rounded border border-edge-soft bg-inset p-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs uppercase tracking-wide text-muted">
          Interrogation
        </h3>
        <button
          data-testid="interrogate-button"
          onClick={interrogate}
          disabled={busy}
          className="rounded border border-edge bg-surface px-3 py-1 text-sm disabled:opacity-50"
        >
          {busy ? "Asking..." : questions.length ? "Re-interrogate" : "Interrogate"}
        </button>
      </div>

      <ul className="mt-3 space-y-3" data-testid="question-list">
        {questions.map((q) => (
          <QuestionItem
            key={q.id}
            question={q}
            lockedContent={lockedFacts[q.id]}
            onAnswered={(factId, content) => {
              setLockedFacts((m) => ({ ...m, [q.id]: content }));
              loadQuestions();
              void factId;
            }}
            onLocked={(content) =>
              setLockedFacts((m) => ({ ...m, [q.id]: content }))
            }
          />
        ))}
      </ul>

      {questions.length > 0 && (
        <DraftGate chapter={chapter} unanswered={unanswered} onChanged={onChanged} />
      )}
    </div>
  );
}

function QuestionItem({
  question,
  onAnswered,
  onLocked,
}: {
  question: Question;
  lockedContent?: string;
  onAnswered: (factId: number, content: string) => void;
  onLocked: (content: string) => void;
}) {
  const [answer, setAnswer] = useState(question.answer ?? "");
  const [factId, setFactId] = useState<number | null>(question.resultingFactId);
  const [factStatus, setFactStatus] = useState<string>("provisional");
  const [content, setContent] = useState<string>("");

  async function save() {
    if (answer.trim().length === 0) return;
    const res = await fetch(`/api/questions/${question.id}/answer`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answer }),
    });
    if (res.ok) {
      const data = await res.json();
      setFactId(data.fact.id);
      setContent(data.fact.content);
      setFactStatus(data.fact.status);
      onAnswered(data.fact.id, data.fact.content);
    }
  }

  async function lock() {
    if (!factId) return;
    await fetch(`/api/canon/${factId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "locked" }),
    });
    setFactStatus("locked");
    onLocked(content);
  }

  return (
    <li className="rounded bg-surface p-2" data-testid="question-item">
      <p className="mb-1">{question.question}</p>
      <div className="flex items-center gap-2">
        <input
          aria-label="Answer"
          data-testid="answer-input"
          value={answer}
          onChange={(e) => setAnswer(e.target.value)}
          className="flex-1 rounded border border-edge px-2 py-1 text-sm"
        />
        <button
          data-testid="save-answer"
          onClick={save}
          className="rounded bg-accent hover:bg-accent-hover px-3 py-1 text-sm text-accent-ink"
        >
          Save answer
        </button>
      </div>
      {factId && (
        <div
          data-testid="resulting-fact"
          className="mt-2 flex items-center gap-2 text-xs"
        >
          <span className="rounded bg-chip px-2 py-0.5 uppercase text-muted">
            plot decision
          </span>
          <span data-testid="fact-status">{factStatus}</span>
          {factStatus !== "locked" && (
            <button
              data-testid="lock-fact-button"
              onClick={lock}
              className="text-muted hover:underline"
            >
              Lock fact
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function DraftGate({
  chapter,
  unanswered,
  onChanged,
}: {
  chapter: Chapter;
  unanswered: number;
  onChanged: () => void;
}) {
  const [override, setOverride] = useState(false);
  const blocked = unanswered > 0 && !override;

  async function startDrafting() {
    await fetch(`/api/chapters/${chapter.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "drafting" }),
    });
    onChanged();
  }

  return (
    <div className="mt-3 border-t border-edge-soft pt-3 text-sm">
      {unanswered > 0 && (
        <p data-testid="draft-block" className="mb-2 text-warn-ink">
          {unanswered} unanswered question(s). Answer them, or override to draft
          anyway.
        </p>
      )}
      {blocked ? (
        <button
          data-testid="override-draft"
          onClick={() => setOverride(true)}
          className="rounded border border-warn-edge px-3 py-1 text-warn-ink"
        >
          Override and draft anyway
        </button>
      ) : (
        <Link
          href={`/book/${chapter.projectId}/chapter/${chapter.id}/draft`}
          onClick={() => startDrafting()}
          data-testid="start-drafting"
          className="inline-block rounded bg-accent hover:bg-accent-hover px-3 py-1 text-accent-ink"
        >
          Start drafting
        </Link>
      )}
    </div>
  );
}
