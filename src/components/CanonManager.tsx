"use client";

import { useCallback, useEffect, useState } from "react";

const TYPES = [
  "world_rule",
  "style_rule",
  "timeline_event",
  "character_fact",
  "plot_decision",
] as const;
type CanonType = (typeof TYPES)[number];
const STATUSES = ["locked", "provisional", "retired"] as const;
type CanonStatus = (typeof STATUSES)[number];

interface Fact {
  id: number;
  projectId: number | null;
  type: CanonType;
  content: string;
  status: CanonStatus;
  source: string | null;
}
interface Project {
  id: number;
  title: string;
}

const TYPE_LABEL: Record<CanonType, string> = {
  world_rule: "world rule",
  style_rule: "style rule",
  timeline_event: "timeline",
  character_fact: "character",
  plot_decision: "plot",
};

export function CanonManager({ projects }: { projects: Project[] }) {
  const [facts, setFacts] = useState<Fact[]>([]);
  const [filterType, setFilterType] = useState<string>("all");
  const [filterStatus, setFilterStatus] = useState<string>("all");
  const [filterScope, setFilterScope] = useState<string>("all");
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const params = new URLSearchParams();
    if (filterType !== "all") params.set("type", filterType);
    if (filterStatus !== "all") params.set("status", filterStatus);
    if (filterScope !== "all") params.set("scope", filterScope);
    const res = await fetch(`/api/canon?${params.toString()}`);
    const data = await res.json();
    setFacts(data.facts ?? []);
    setLoading(false);
  }, [filterType, filterStatus, filterScope]);

  useEffect(() => {
    load();
  }, [load]);

  const scopeLabel = (projectId: number | null) =>
    projectId === null
      ? "series"
      : (projects.find((p) => p.id === projectId)?.title ?? `book ${projectId}`);

  return (
    <div>
      <FilterBar
        projects={projects}
        filterType={filterType}
        filterStatus={filterStatus}
        filterScope={filterScope}
        onType={setFilterType}
        onStatus={setFilterStatus}
        onScope={setFilterScope}
      />

      <AddForm projects={projects} onCreated={load} />

      <ul className="mt-4 divide-y divide-neutral-200" data-testid="canon-list">
        {loading && <li className="py-3 text-sm text-neutral-400">Loading...</li>}
        {!loading && facts.length === 0 && (
          <li className="py-3 text-sm text-neutral-400">No facts match.</li>
        )}
        {facts.map((f) => (
          <CanonRow
            key={f.id}
            fact={f}
            scopeLabel={scopeLabel(f.projectId)}
            onChanged={load}
          />
        ))}
      </ul>

      <BulkPaste projects={projects} onCreated={load} />
    </div>
  );
}

function FilterBar(props: {
  projects: Project[];
  filterType: string;
  filterStatus: string;
  filterScope: string;
  onType: (v: string) => void;
  onStatus: (v: string) => void;
  onScope: (v: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded border border-neutral-200 bg-white p-3 text-sm">
      <label className="flex items-center gap-1">
        Type
        <select
          aria-label="Filter by type"
          value={props.filterType}
          onChange={(e) => props.onType(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1"
        >
          <option value="all">all</option>
          {TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        Status
        <select
          aria-label="Filter by status"
          value={props.filterStatus}
          onChange={(e) => props.onStatus(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1"
        >
          <option value="all">all</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>
      <label className="flex items-center gap-1">
        Scope
        <select
          aria-label="Filter by scope"
          value={props.filterScope}
          onChange={(e) => props.onScope(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1"
        >
          <option value="all">all</option>
          <option value="series">series-wide</option>
          {props.projects.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.title}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

function AddForm({
  projects,
  onCreated,
}: {
  projects: Project[];
  onCreated: () => void;
}) {
  const [type, setType] = useState<CanonType>("world_rule");
  const [content, setContent] = useState("");
  const [scope, setScope] = useState<string>("series");
  const [busy, setBusy] = useState(false);

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
        projectId: scope === "series" ? null : Number(scope),
      }),
    });
    setBusy(false);
    setContent("");
    onCreated();
  }

  return (
    <form
      onSubmit={submit}
      className="mt-4 flex flex-wrap items-center gap-2 text-sm"
    >
      <select
        aria-label="New fact type"
        value={type}
        onChange={(e) => setType(e.target.value as CanonType)}
        className="rounded border border-neutral-300 px-2 py-1"
      >
        {TYPES.map((t) => (
          <option key={t} value={t}>
            {TYPE_LABEL[t]}
          </option>
        ))}
      </select>
      <input
        aria-label="New fact content"
        placeholder="Add a fact and press Enter"
        value={content}
        onChange={(e) => setContent(e.target.value)}
        className="min-w-[20rem] flex-1 rounded border border-neutral-300 px-2 py-1"
      />
      <select
        aria-label="New fact scope"
        value={scope}
        onChange={(e) => setScope(e.target.value)}
        className="rounded border border-neutral-300 px-2 py-1"
      >
        <option value="series">series-wide</option>
        {projects.map((p) => (
          <option key={p.id} value={String(p.id)}>
            {p.title}
          </option>
        ))}
      </select>
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-neutral-900 px-3 py-1 text-white disabled:opacity-50"
      >
        Add
      </button>
    </form>
  );
}

function CanonRow({
  fact,
  scopeLabel,
  onChanged,
}: {
  fact: Fact;
  scopeLabel: string;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(fact.content);

  async function patch(body: Record<string, unknown>) {
    await fetch(`/api/canon/${fact.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    onChanged();
  }

  async function remove() {
    await fetch(`/api/canon/${fact.id}`, { method: "DELETE" });
    onChanged();
  }

  const locked = fact.status === "locked";
  const retired = fact.status === "retired";

  return (
    <li
      className={`flex items-start gap-3 py-3 text-sm ${retired ? "opacity-50" : ""}`}
      data-testid="canon-row"
      data-status={fact.status}
      data-type={fact.type}
    >
      <span className="mt-0.5 w-20 shrink-0 text-xs uppercase tracking-wide text-neutral-400">
        {TYPE_LABEL[fact.type]}
      </span>
      <div className="flex-1">
        {editing ? (
          <div className="flex gap-2">
            <input
              aria-label="Edit fact content"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="flex-1 rounded border border-neutral-300 px-2 py-1"
            />
            <button
              onClick={async () => {
                await patch({ content: draft });
                setEditing(false);
              }}
              className="rounded bg-neutral-900 px-2 py-1 text-white"
            >
              Save
            </button>
            <button
              onClick={() => {
                setDraft(fact.content);
                setEditing(false);
              }}
              className="rounded border border-neutral-300 px-2 py-1"
            >
              Cancel
            </button>
          </div>
        ) : (
          <span>
            {locked && (
              <span aria-label="locked" title="locked" className="mr-1">
                &#128274;
              </span>
            )}
            {fact.content}
          </span>
        )}
        <div className="mt-1 flex items-center gap-2 text-xs text-neutral-400">
          <span>{scopeLabel}</span>
          <span>&middot;</span>
          <span data-testid="row-status">{fact.status}</span>
          {fact.source && (
            <>
              <span>&middot;</span>
              <span>{fact.source}</span>
            </>
          )}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {!editing && !locked && !retired && (
          <button
            onClick={() => setEditing(true)}
            className="text-neutral-500 hover:underline"
          >
            Edit
          </button>
        )}
        {locked ? (
          <button
            onClick={() => patch({ status: "provisional" })}
            className="text-neutral-500 hover:underline"
          >
            Unlock
          </button>
        ) : (
          !retired && (
            <button
              onClick={() => patch({ status: "locked" })}
              className="text-neutral-500 hover:underline"
            >
              Lock
            </button>
          )
        )}
        {!retired ? (
          <button
            onClick={() => patch({ status: "retired" })}
            className="text-neutral-500 hover:underline"
          >
            Retire
          </button>
        ) : (
          <button
            onClick={() => patch({ status: "provisional" })}
            className="text-neutral-500 hover:underline"
          >
            Restore
          </button>
        )}
        <button onClick={remove} className="text-red-500 hover:underline">
          Delete
        </button>
      </div>
    </li>
  );
}

function BulkPaste({
  projects,
  onCreated,
}: {
  projects: Project[];
  onCreated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [type, setType] = useState<CanonType>("world_rule");
  const [scope, setScope] = useState<string>("series");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (text.trim().length === 0) return;
    setBusy(true);
    await fetch("/api/canon", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bulk: true,
        lines: text,
        type,
        projectId: scope === "series" ? null : Number(scope),
      }),
    });
    setBusy(false);
    setText("");
    setOpen(false);
    onCreated();
  }

  return (
    <div className="mt-8 border-t border-neutral-200 pt-4">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-sm text-neutral-500 hover:underline"
      >
        {open ? "Hide bulk paste" : "Bulk paste facts"}
      </button>
      {open && (
        <div className="mt-3 space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <select
              aria-label="Bulk type"
              value={type}
              onChange={(e) => setType(e.target.value as CanonType)}
              className="rounded border border-neutral-300 px-2 py-1"
            >
              {TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <select
              aria-label="Bulk scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
              className="rounded border border-neutral-300 px-2 py-1"
            >
              <option value="series">series-wide</option>
              {projects.map((p) => (
                <option key={p.id} value={String(p.id)}>
                  {p.title}
                </option>
              ))}
            </select>
            <span className="text-neutral-400">
              one fact per line, created provisional
            </span>
          </div>
          <textarea
            aria-label="Bulk paste content"
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            className="w-full rounded border border-neutral-300 px-2 py-1 font-mono"
          />
          <button
            onClick={submit}
            disabled={busy}
            className="rounded bg-neutral-900 px-3 py-1 text-white disabled:opacity-50"
          >
            Create all
          </button>
        </div>
      )}
    </div>
  );
}
