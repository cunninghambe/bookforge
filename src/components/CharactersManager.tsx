"use client";

import { useCallback, useEffect, useState } from "react";

interface Project {
  id: number;
  title: string;
}
interface Character {
  id: number;
  name: string;
  role: string | null;
  voiceRules: string | null;
  physical: string | null;
  notes: string | null;
}
interface CharacterState {
  id: number;
  characterId: number;
  projectId: number;
  chapterOrder: number;
  knows: string | null;
  feels: string | null;
  hiding: string | null;
}

export function CharactersManager({ projects }: { projects: Project[] }) {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [adding, setAdding] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch("/api/characters");
    const data = await res.json();
    setCharacters(data.characters ?? []);
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <button
        onClick={() => setAdding((a) => !a)}
        className="rounded bg-neutral-900 px-3 py-1 text-sm text-white"
      >
        {adding ? "Close" : "+ New character"}
      </button>

      {adding && (
        <NewCharacterForm
          onCreated={() => {
            setAdding(false);
            load();
          }}
        />
      )}

      <div className="mt-4 space-y-3" data-testid="character-list">
        {characters.length === 0 && (
          <p className="text-sm text-neutral-400">No characters yet.</p>
        )}
        {characters.map((c) => (
          <CharacterCard
            key={c.id}
            character={c}
            projects={projects}
            onChanged={load}
          />
        ))}
      </div>
    </div>
  );
}

function Field({
  label,
  value,
  onChange,
  textarea,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  textarea?: boolean;
}) {
  return (
    <label className="block text-sm">
      <span className="text-xs uppercase tracking-wide text-neutral-400">
        {label}
      </span>
      {textarea ? (
        <textarea
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          rows={2}
          className="mt-1 w-full rounded border border-neutral-300 px-2 py-1"
        />
      ) : (
        <input
          aria-label={label}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="mt-1 w-full rounded border border-neutral-300 px-2 py-1"
        />
      )}
    </label>
  );
}

function NewCharacterForm({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [voiceRules, setVoiceRules] = useState("");
  const [physical, setPhysical] = useState("");
  const [notes, setNotes] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (name.trim().length === 0) return;
    setBusy(true);
    await fetch("/api/characters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, role, voiceRules, physical, notes }),
    });
    setBusy(false);
    onCreated();
  }

  return (
    <form
      onSubmit={submit}
      className="mt-4 space-y-3 rounded border border-neutral-200 bg-white p-4"
    >
      <Field label="name" value={name} onChange={setName} />
      <Field label="role" value={role} onChange={setRole} />
      <Field
        label="voice_rules"
        value={voiceRules}
        onChange={setVoiceRules}
        textarea
      />
      <Field label="physical" value={physical} onChange={setPhysical} textarea />
      <Field label="notes" value={notes} onChange={setNotes} textarea />
      <button
        type="submit"
        disabled={busy}
        className="rounded bg-neutral-900 px-3 py-1 text-sm text-white disabled:opacity-50"
      >
        Create
      </button>
    </form>
  );
}

function CharacterCard({
  character,
  projects,
  onChanged,
}: {
  character: Character;
  projects: Project[];
  onChanged: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [states, setStates] = useState<CharacterState[]>([]);

  const loadStates = useCallback(async () => {
    const res = await fetch(`/api/characters/${character.id}/states`);
    const data = await res.json();
    setStates(data.states ?? []);
  }, [character.id]);

  useEffect(() => {
    if (expanded) loadStates();
  }, [expanded, loadStates]);

  const projTitle = (id: number) =>
    projects.find((p) => p.id === id)?.title ?? `book ${id}`;

  return (
    <div
      className="rounded border border-neutral-200 bg-white p-4"
      data-testid="character-card"
    >
      <div className="flex items-start justify-between">
        <div>
          <h2 className="font-serif text-lg">{character.name}</h2>
          {character.role && (
            <p className="text-sm text-neutral-500">{character.role}</p>
          )}
        </div>
        <button
          onClick={() => setExpanded((e) => !e)}
          className="text-sm text-neutral-500 hover:underline"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>

      {expanded && (
        <div className="mt-3 space-y-3 text-sm">
          {character.voiceRules && (
            <p>
              <span className="text-xs uppercase text-neutral-400">voice </span>
              {character.voiceRules}
            </p>
          )}
          {character.physical && (
            <p>
              <span className="text-xs uppercase text-neutral-400">physical </span>
              {character.physical}
            </p>
          )}
          {character.notes && (
            <p>
              <span className="text-xs uppercase text-neutral-400">notes </span>
              {character.notes}
            </p>
          )}

          <div className="mt-2 border-t border-neutral-100 pt-2">
            <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-400">
              State timeline
            </h3>
            <ul className="space-y-1" data-testid="state-timeline">
              {states.length === 0 && (
                <li className="text-neutral-400">No states yet.</li>
              )}
              {states.map((s) => (
                <li key={s.id} className="rounded bg-neutral-50 px-2 py-1">
                  <span className="text-neutral-400">
                    {projTitle(s.projectId)} ch {s.chapterOrder}:{" "}
                  </span>
                  {s.knows && (
                    <span>
                      <b>knows</b> {s.knows}.{" "}
                    </span>
                  )}
                  {s.feels && (
                    <span>
                      <b>feels</b> {s.feels}.{" "}
                    </span>
                  )}
                  {s.hiding && (
                    <span>
                      <b>hiding</b> {s.hiding}.
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <AddStateForm
              characterId={character.id}
              projects={projects}
              onAdded={loadStates}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function AddStateForm({
  characterId,
  projects,
  onAdded,
}: {
  characterId: number;
  projects: Project[];
  onAdded: () => void;
}) {
  const [projectId, setProjectId] = useState<string>(
    projects[0] ? String(projects[0].id) : "",
  );
  const [chapterOrder, setChapterOrder] = useState("1");
  const [knows, setKnows] = useState("");
  const [feels, setFeels] = useState("");
  const [hiding, setHiding] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    await fetch(`/api/characters/${characterId}/states`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: Number(projectId),
        chapterOrder: Number(chapterOrder),
        knows,
        feels,
        hiding,
      }),
    });
    setBusy(false);
    setKnows("");
    setFeels("");
    setHiding("");
    onAdded();
  }

  return (
    <form onSubmit={submit} className="mt-3 space-y-2">
      <div className="flex items-center gap-2">
        <select
          aria-label="State book"
          value={projectId}
          onChange={(e) => setProjectId(e.target.value)}
          className="rounded border border-neutral-300 px-2 py-1"
        >
          {projects.map((p) => (
            <option key={p.id} value={String(p.id)}>
              {p.title}
            </option>
          ))}
        </select>
        <input
          aria-label="State chapter order"
          type="number"
          min={1}
          value={chapterOrder}
          onChange={(e) => setChapterOrder(e.target.value)}
          className="w-20 rounded border border-neutral-300 px-2 py-1"
        />
      </div>
      <input
        aria-label="knows"
        placeholder="knows"
        value={knows}
        onChange={(e) => setKnows(e.target.value)}
        className="w-full rounded border border-neutral-300 px-2 py-1"
      />
      <input
        aria-label="feels"
        placeholder="feels"
        value={feels}
        onChange={(e) => setFeels(e.target.value)}
        className="w-full rounded border border-neutral-300 px-2 py-1"
      />
      <input
        aria-label="hiding"
        placeholder="hiding"
        value={hiding}
        onChange={(e) => setHiding(e.target.value)}
        className="w-full rounded border border-neutral-300 px-2 py-1"
      />
      <button
        type="submit"
        disabled={busy}
        className="rounded border border-neutral-300 px-3 py-1 text-sm disabled:opacity-50"
      >
        Add state
      </button>
    </form>
  );
}
