// Parses the series-bible extraction envelope (Amendment A3), defensively. The
// model returns one JSON object per chunk: { facts, characters, states }. On parse
// failure the raw text is surfaced so the UI never silently drops a chunk's output
// (SPEC LLM notes). Invalid individual entries are dropped, not fatal.

import { parseJson } from "./json";
import { CANON_TYPES, type CanonType } from "../repo/canon";

export interface BibleFactProposal {
  type: CanonType;
  content: string;
}

export interface BibleCharacterProposal {
  name: string;
  role: string | null;
  voiceRules: string | null;
  physical: string | null;
  notes: string | null;
}

export interface BibleStateProposal {
  character: string;
  knows: string | null;
  feels: string | null;
  hiding: string | null;
}

export type BibleParseResult =
  | {
      ok: true;
      facts: BibleFactProposal[];
      characters: BibleCharacterProposal[];
      states: BibleStateProposal[];
    }
  | { ok: false; error: string; raw: string };

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function isCanonType(v: unknown): v is CanonType {
  return typeof v === "string" && (CANON_TYPES as readonly string[]).includes(v);
}

// Normalizes the bible envelope: { facts, characters, states }. A fact needs a
// valid type and non-empty content; a character needs a non-empty name; a state
// needs a non-empty character name and at least one non-empty delta field. A
// completely unparseable response surfaces its raw text.
export function parseBibleResponse(text: string): BibleParseResult {
  const parsed = parseJson<unknown>(text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, raw: parsed.raw };
  }
  const root = parsed.value;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return {
      ok: false,
      error: "expected a JSON object with 'facts', 'characters', and 'states'",
      raw: text,
    };
  }
  const obj = root as {
    facts?: unknown;
    characters?: unknown;
    states?: unknown;
  };

  const facts: BibleFactProposal[] = [];
  if (Array.isArray(obj.facts)) {
    for (const item of obj.facts) {
      if (!item || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      const content = str(f.content);
      if (!content || !isCanonType(f.type)) continue;
      facts.push({ type: f.type, content });
    }
  }

  const characters: BibleCharacterProposal[] = [];
  if (Array.isArray(obj.characters)) {
    for (const item of obj.characters) {
      if (!item || typeof item !== "object") continue;
      const c = item as Record<string, unknown>;
      const name = str(c.name);
      if (!name) continue;
      characters.push({
        name,
        role: str(c.role),
        voiceRules: str(c.voice_rules),
        physical: str(c.physical),
        notes: str(c.notes),
      });
    }
  }

  const states: BibleStateProposal[] = [];
  if (Array.isArray(obj.states)) {
    for (const item of obj.states) {
      if (!item || typeof item !== "object") continue;
      const s = item as Record<string, unknown>;
      const character = str(s.character);
      if (!character) continue;
      const knows = str(s.knows);
      const feels = str(s.feels);
      const hiding = str(s.hiding);
      if (!knows && !feels && !hiding) continue; // deltas only, must carry one
      states.push({ character, knows, feels, hiding });
    }
  }

  return { ok: true, facts, characters, states };
}
