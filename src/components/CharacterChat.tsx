"use client";

import { useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { validatePinChapter, pinRangeLabel } from "@/lib/chatPin";

const CONTROL_DELIM = "\n<<<BOOKFORGE_CTRL>>>\n";

interface Project {
  id: number;
  title: string;
  chapterCount: number;
}

interface ControlFrame {
  finalText: string;
  retried: boolean;
  emDashUnresolved: boolean;
  missingFacts: string[];
  error?: string;
}

interface Turn {
  role: "user" | "assistant";
  text: string;
  // Assistant-only: surfaced notes and flags for this reply.
  missingFacts?: string[];
  emDashUnresolved?: boolean;
}

interface Pin {
  projectId: number;
  uiChapter: number;
}

// Canon types offered by the propose-as-fact form. character_fact is the default
// (A5), matching the chatbot's subject.
const CANON_TYPES = [
  "character_fact",
  "world_rule",
  "plot_decision",
  "timeline_event",
  "style_rule",
] as const;

export function CharacterChat({
  characterId,
  characterName,
  projects,
}: {
  characterId: number;
  characterName: string;
  projects: Project[];
}) {
  const searchParams = useSearchParams();
  const fixtureKey = searchParams.get("fx") ?? undefined;

  const [pin, setPin] = useState<Pin | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");

  // Draft pin form values (before the moment is set).
  const [formProject, setFormProject] = useState<string>(
    projects[0] ? String(projects[0].id) : "",
  );
  const [formChapter, setFormChapter] = useState("1");

  const pinBusyRef = useRef(false);

  // The chapter count of the currently selected book, for clamping and the range
  // hint (A5.1b). The pin form can never accept a chapter past the last one.
  const selectedChapterCount = useMemo(() => {
    const p = projects.find((x) => String(x.id) === formProject);
    return p ? p.chapterCount : 0;
  }, [projects, formProject]);

  function setMoment(e: React.FormEvent) {
    e.preventDefault();
    const projectId = Number(formProject);
    const rawChapter = Number(formChapter);
    if (!Number.isFinite(projectId) || !Number.isFinite(rawChapter)) {
      return;
    }
    // Clamp the pinned chapter to [1, chapter count of the selected book] (A5.1b):
    // pinning past the last chapter is not supported. A book with no chapters
    // cannot be pinned.
    const check = validatePinChapter(rawChapter, selectedChapterCount);
    if (check.max < 1) return;
    const uiChapter = check.clamped;
    setFormChapter(String(uiChapter));
    // Changing the pin starts a fresh conversation: state boundaries differ, so a
    // transcript from another moment would leak (SPEC A5).
    setTurns([]);
    setStreamText("");
    setPin({ projectId, uiChapter });
  }

  function changeMoment() {
    setPin(null);
    setTurns([]);
    setStreamText("");
  }

  const pinnedProjectTitle = useMemo(() => {
    if (!pin) return "";
    return projects.find((p) => p.id === pin.projectId)?.title ?? `book ${pin.projectId}`;
  }, [pin, projects]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (streaming || !pin) return;
    const message = input.trim();
    if (message.length === 0) return;

    const history = turns.map((t) => ({ role: t.role, text: t.text }));
    setTurns((prev) => [...prev, { role: "user", text: message }]);
    setInput("");
    setStreaming(true);
    setStreamText("");

    const res = await fetch(`/api/characters/${characterId}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: pin.projectId,
        uiChapter: pin.uiChapter,
        history,
        message,
        fixtureKey,
      }),
    });

    if (!res.body) {
      setStreaming(false);
      setTurns((prev) => [
        ...prev,
        { role: "assistant", text: "(no response)" },
      ]);
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const delimIdx = buffer.indexOf(CONTROL_DELIM);
      if (delimIdx === -1) {
        setStreamText(buffer);
      } else {
        setStreamText(buffer.slice(0, delimIdx));
      }
    }

    const delimIdx = buffer.indexOf(CONTROL_DELIM);
    let reply: Turn = { role: "assistant", text: buffer };
    if (delimIdx !== -1) {
      try {
        const control = JSON.parse(
          buffer.slice(delimIdx + CONTROL_DELIM.length),
        ) as ControlFrame;
        if (control.error) {
          reply = { role: "assistant", text: `(error: ${control.error})` };
        } else {
          reply = {
            role: "assistant",
            text: control.finalText,
            missingFacts: control.missingFacts ?? [],
            emDashUnresolved: control.emDashUnresolved,
          };
        }
      } catch {
        reply = { role: "assistant", text: buffer.slice(0, delimIdx) };
      }
    }
    setTurns((prev) => [...prev, reply]);
    setStreamText("");
    setStreaming(false);
  }

  return (
    <div className="mt-4 max-w-2xl">
      {/* The moment: pinned before any chat is possible. */}
      {!pin ? (
        <div
          data-testid="pin-form-wrap"
          className="rounded border border-neutral-200 bg-white p-4"
        >
          <p data-testid="chat-opening" className="mb-3 text-sm text-neutral-700">
            Before we speak, tell me when in the book I am. Pick a book and a
            chapter, and I will answer as I was at that moment, knowing only what I
            knew then.
          </p>
          <form onSubmit={setMoment} className="flex flex-wrap items-end gap-2">
            <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-neutral-400">
              Book
              <select
                aria-label="Pin book"
                data-testid="chat-book"
                value={formProject}
                onChange={(e) => setFormProject(e.target.value)}
                className="rounded border border-neutral-300 px-2 py-1 text-sm normal-case tracking-normal text-neutral-900"
              >
                {projects.map((p) => (
                  <option key={p.id} value={String(p.id)}>
                    {p.title}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs uppercase tracking-wide text-neutral-400">
              Chapter (1 = first)
              <input
                aria-label="Pin chapter"
                data-testid="chat-chapter"
                type="number"
                min={1}
                max={selectedChapterCount > 0 ? selectedChapterCount : undefined}
                value={formChapter}
                onChange={(e) => setFormChapter(e.target.value)}
                className="w-24 rounded border border-neutral-300 px-2 py-1 text-sm normal-case tracking-normal text-neutral-900"
              />
              <span
                data-testid="pin-range"
                className="text-xs normal-case tracking-normal text-neutral-400"
              >
                Valid chapters: {pinRangeLabel(selectedChapterCount)}
              </span>
            </label>
            <button
              type="submit"
              data-testid="set-pin-button"
              className="rounded bg-neutral-900 px-3 py-1.5 text-sm text-white"
            >
              Set the moment
            </button>
          </form>
        </div>
      ) : (
        <div
          data-testid="chat-pin"
          className="mb-4 flex items-center justify-between rounded border border-neutral-200 bg-neutral-50 px-3 py-2 text-sm"
        >
          <span>
            Pinned to <b>{pinnedProjectTitle}</b>, chapter{" "}
            <b>{pin.uiChapter}</b>. {characterName} knows only what they knew then.
          </span>
          <button
            data-testid="change-pin-button"
            onClick={changeMoment}
            className="rounded border border-neutral-300 px-2 py-1 text-xs"
          >
            Change the moment
          </button>
        </div>
      )}

      {pin && (
        <>
          <ul className="space-y-3" data-testid="chat-messages">
            {turns.length === 0 && !streaming && (
              <li className="text-sm text-neutral-400" data-testid="chat-empty">
                Ask {characterName} anything about this moment.
              </li>
            )}
            {turns.map((t, i) =>
              t.role === "user" ? (
                <li
                  key={i}
                  data-testid="user-message"
                  className="ml-auto max-w-[85%] rounded bg-neutral-900 px-3 py-2 text-sm text-white"
                >
                  {t.text}
                </li>
              ) : (
                <BotMessage
                  key={i}
                  index={i}
                  text={t.text}
                  missingFacts={t.missingFacts ?? []}
                  emDashUnresolved={t.emDashUnresolved ?? false}
                  characterId={characterId}
                  pinnedProjectId={pin.projectId}
                  projects={projects}
                />
              ),
            )}
            {streaming && (
              <li
                data-testid="streaming-message"
                className="max-w-[85%] rounded border border-neutral-200 bg-white px-3 py-2 font-serif text-sm text-neutral-800"
              >
                {streamText || <span className="text-neutral-400">...</span>}
              </li>
            )}
          </ul>

          <form onSubmit={send} className="mt-4 flex gap-2">
            <input
              aria-label="Message"
              data-testid="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              disabled={streaming}
              placeholder={`Say something to ${characterName}...`}
              className="flex-1 rounded border border-neutral-300 px-3 py-2 text-sm"
            />
            <button
              type="submit"
              data-testid="send-button"
              disabled={streaming || input.trim().length === 0}
              className="rounded bg-neutral-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {streaming ? "..." : "Send"}
            </button>
          </form>
        </>
      )}
    </div>
  );
}

function BotMessage({
  index,
  text,
  missingFacts,
  emDashUnresolved,
  characterId,
  pinnedProjectId,
  projects,
}: {
  index: number;
  text: string;
  missingFacts: string[];
  emDashUnresolved: boolean;
  characterId: number;
  pinnedProjectId: number;
  projects: Project[];
}) {
  const [proposing, setProposing] = useState(false);

  return (
    <li
      data-testid="bot-message"
      className="max-w-[85%] rounded border border-neutral-200 bg-white px-3 py-2 font-serif text-sm text-neutral-800"
    >
      <p className="whitespace-pre-wrap">{text}</p>

      {emDashUnresolved && (
        <p
          data-testid={`bot-emdash-${index}`}
          className="mt-2 text-xs text-amber-700"
        >
          This reply still contains an em-dash after a retry.
        </p>
      )}

      {missingFacts.map((f, i) => (
        <p
          key={i}
          data-testid={`missing-fact-note-${index}`}
          className="mt-2 rounded bg-neutral-50 px-2 py-1 text-xs text-neutral-500"
        >
          Missing fact: {f}
        </p>
      ))}

      <div className="mt-2">
        {!proposing ? (
          <button
            data-testid={`propose-fact-${index}`}
            onClick={() => setProposing(true)}
            className="text-xs text-neutral-500 hover:underline"
          >
            Propose as canon fact
          </button>
        ) : (
          <ProposeFactForm
            index={index}
            defaultContent={text}
            characterId={characterId}
            pinnedProjectId={pinnedProjectId}
            projects={projects}
            onClose={() => setProposing(false)}
          />
        )}
      </div>
    </li>
  );
}

function ProposeFactForm({
  index,
  defaultContent,
  characterId,
  pinnedProjectId,
  projects,
  onClose,
}: {
  index: number;
  defaultContent: string;
  characterId: number;
  pinnedProjectId: number;
  projects: Project[];
  onClose: () => void;
}) {
  const [type, setType] = useState<string>("character_fact");
  const [content, setContent] = useState(defaultContent);
  // Scope defaults to the pinned book (SPEC A5). "series" is offered too.
  const [scope, setScope] = useState<string>(String(pinnedProjectId));
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (content.trim().length === 0) return;
    setBusy(true);
    await fetch("/api/canon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        type,
        content: content.trim(),
        status: "provisional",
        source: `chat:${characterId}`,
        projectId: scope === "series" ? null : Number(scope),
      }),
    });
    setBusy(false);
    setDone(true);
  }

  if (done) {
    return (
      <p
        data-testid={`propose-success-${index}`}
        className="text-xs text-green-700"
      >
        Proposed as a provisional fact. Review and lock it in the canon manager.
      </p>
    );
  }

  return (
    <form
      onSubmit={submit}
      data-testid={`propose-form-${index}`}
      className="mt-1 space-y-2 rounded border border-neutral-200 bg-neutral-50 p-2 text-xs"
    >
      <div className="flex flex-wrap items-center gap-2">
        <select
          aria-label="Proposed fact type"
          data-testid={`propose-type-${index}`}
          value={type}
          onChange={(e) => setType(e.target.value)}
          className="rounded border border-neutral-300 bg-white px-2 py-1"
        >
          {CANON_TYPES.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select
          aria-label="Proposed fact scope"
          data-testid={`propose-scope-${index}`}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="rounded border border-neutral-300 bg-white px-2 py-1"
        >
          {projects.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.title}
            </option>
          ))}
          <option value="series">Series-wide</option>
        </select>
      </div>
      <textarea
        aria-label="Proposed fact content"
        data-testid={`propose-content-${index}`}
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        className="w-full rounded border border-neutral-300 px-2 py-1 font-sans text-neutral-900"
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          data-testid={`propose-submit-${index}`}
          disabled={busy || content.trim().length === 0}
          className="rounded bg-neutral-900 px-2 py-1 text-white disabled:opacity-50"
        >
          Propose as provisional fact
        </button>
        <button
          type="button"
          onClick={onClose}
          className="rounded border border-neutral-300 px-2 py-1"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
