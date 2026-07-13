// Parses the lock-time extraction envelope (Amendment A1) and the sweep report,
// defensively. On parse failure the raw text is surfaced so the UI never silently
// drops a model response (SPEC LLM notes).

import { parseJson } from "./json";
import { CANON_TYPES, type CanonType } from "../repo/canon";

export interface FactProposal {
  type: CanonType;
  content: string;
  evidenceQuote: string | null;
}

export interface StateProposal {
  character: string;
  knows: string | null;
  feels: string | null;
  hiding: string | null;
  evidenceQuote: string | null;
}

export type ExtractionResult =
  | { ok: true; facts: FactProposal[]; states: StateProposal[] }
  | { ok: false; error: string; raw: string };

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t.length ? t : null;
}

function isCanonType(v: unknown): v is CanonType {
  return typeof v === "string" && (CANON_TYPES as readonly string[]).includes(v);
}

// Normalizes the extraction envelope: { facts: [...], states: [...] }. A fact
// needs a valid type and non-empty content; a state needs a non-empty character
// name and at least one delta field. Invalid entries are dropped, not fatal, but a
// completely unparseable response surfaces its raw text.
export function parseExtractionResponse(text: string): ExtractionResult {
  const parsed = parseJson<unknown>(text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, raw: parsed.raw };
  }
  const root = parsed.value;
  if (!root || typeof root !== "object" || Array.isArray(root)) {
    return {
      ok: false,
      error: "expected a JSON object with 'facts' and 'states'",
      raw: text,
    };
  }
  const obj = root as { facts?: unknown; states?: unknown };
  const facts: FactProposal[] = [];
  if (Array.isArray(obj.facts)) {
    for (const item of obj.facts) {
      if (!item || typeof item !== "object") continue;
      const f = item as Record<string, unknown>;
      const content = str(f.content);
      if (!content || !isCanonType(f.type)) continue;
      facts.push({
        type: f.type,
        content,
        evidenceQuote: str(f.evidence_quote),
      });
    }
  }
  const states: StateProposal[] = [];
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
      states.push({
        character,
        knows,
        feels,
        hiding,
        evidenceQuote: str(s.evidence_quote),
      });
    }
  }
  return { ok: true, facts, states };
}

export interface Contradiction {
  chapter: number | null;
  quote: string | null;
  conflictingFact: string | null;
  severity: string | null;
}

export type SweepParseResult =
  | { ok: true; contradictions: Contradiction[] }
  | { ok: false; error: string; raw: string };

// Normalizes one chapter's sweep response: a JSON array of contradictions. An
// empty array means clean. A parse failure surfaces the raw text.
export function parseSweepResponse(text: string): SweepParseResult {
  const parsed = parseJson<unknown>(text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, raw: parsed.raw };
  }
  if (!Array.isArray(parsed.value)) {
    return { ok: false, error: "expected a JSON array", raw: text };
  }
  const contradictions: Contradiction[] = [];
  for (const item of parsed.value) {
    if (!item || typeof item !== "object") continue;
    const c = item as Record<string, unknown>;
    contradictions.push({
      chapter: typeof c.chapter === "number" ? c.chapter : null,
      quote: str(c.quote),
      conflictingFact:
        str(c.conflicting_fact) ??
        str(c.conflicting_fact_id) ??
        str(c.description),
      severity: str(c.severity),
    });
  }
  return { ok: true, contradictions };
}
