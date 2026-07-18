// Parses the lock-time extraction envelope (Amendment A1) and the sweep report,
// defensively. On parse failure the raw text is surfaced so the UI never silently
// drops a model response (SPEC LLM notes).

import { parseJson } from "./json";
import { CANON_TYPES, type CanonType } from "../repo/canon";
import {
  isThreadType,
  isTouchKind,
  type ThreadType,
  type TouchKind,
} from "../repo/threads";

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

// Amendment A12: a raw thread proposal as the model returned it. isNew is only the
// model's hint; the real attach-vs-new decision is made by normalizeThreadProposals
// against the book's existing threads (name match wins). type may be null when the
// model omitted it; a new-thread proposal without a type defaults to 'arc'.
export interface ThreadProposal {
  thread: string;
  isNew: boolean;
  type: ThreadType | null;
  kind: TouchKind;
  evidence: string | null;
}

export type ExtractionResult =
  | {
      ok: true;
      facts: FactProposal[];
      states: StateProposal[];
      threads: ThreadProposal[];
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
  const obj = root as { facts?: unknown; states?: unknown; threads?: unknown };
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
  // A12: the threads section is optional. A missing or non-array "threads" key
  // parses as an empty list (old replies and the empty fixtures stay valid). A
  // proposal needs a name and a valid touch kind; an unknown type degrades to
  // null (resolved to 'arc' only if it becomes a new-thread proposal).
  const threads: ThreadProposal[] = [];
  if (Array.isArray(obj.threads)) {
    for (const item of obj.threads) {
      if (!item || typeof item !== "object") continue;
      const t = item as Record<string, unknown>;
      const name = str(t.thread);
      if (!name) continue;
      if (!isTouchKind(t.kind)) continue;
      threads.push({
        thread: name,
        isNew: t.isNew === true,
        type: isThreadType(t.type) ? t.type : null,
        kind: t.kind,
        evidence: str(t.evidence),
      });
    }
  }
  return { ok: true, facts, states, threads };
}

// A12: an attach proposal targets an existing thread by id (a name that matched an
// open thread case-insensitively).
export interface ThreadAttachProposal {
  threadId: number;
  name: string;
  kind: TouchKind;
  evidence: string | null;
}

// A12: a new-thread proposal. type is required to satisfy the CHECK constraint; a
// proposal that omitted a type defaults to 'arc' (recorded, not invented silently).
export interface ThreadNewProposal {
  name: string;
  type: ThreadType;
  kind: TouchKind;
  evidence: string | null;
}

// A12: splits raw thread proposals into attach vs new. A proposal whose name
// matches an existing thread (case-insensitive, trimmed) is an attach against that
// thread's id; anything else is a new-thread proposal. The model's isNew hint is
// ignored: the name match is the source of truth so the model cannot duplicate a
// thread by mislabeling it. existing is the set of threads the prompt advertised
// (the book's open threads plus series-wide).
export function normalizeThreadProposals(
  proposals: ThreadProposal[],
  existing: Array<{ id: number; name: string }>,
): { attaches: ThreadAttachProposal[]; news: ThreadNewProposal[] } {
  const byName = new Map<string, number>();
  for (const e of existing) {
    const key = e.name.trim().toLowerCase();
    if (key && !byName.has(key)) byName.set(key, e.id);
  }
  const attaches: ThreadAttachProposal[] = [];
  const news: ThreadNewProposal[] = [];
  for (const p of proposals) {
    const key = p.thread.trim().toLowerCase();
    const matchId = byName.get(key);
    if (matchId !== undefined) {
      attaches.push({
        threadId: matchId,
        name: p.thread,
        kind: p.kind,
        evidence: p.evidence,
      });
    } else {
      news.push({
        name: p.thread,
        type: p.type ?? "arc",
        kind: p.kind,
        evidence: p.evidence,
      });
    }
  }
  return { attaches, news };
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
