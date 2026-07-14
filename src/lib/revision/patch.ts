// A4.2 patch-mode revision. The model returns a JSON envelope of verbatim-anchored
// patches instead of the whole rewritten chapter, so a revision spends output
// tokens proportional to the change, not the chapter. This module is pure and unit
// tested: it parses the envelope defensively, anchors each patch against the
// original text, and applies the anchored patches offset-safely to produce the
// revised full text. That full text then flows through the UNMODIFIED
// analyzeRevision + revisions-table + resolve enforcement path, exactly as full
// mode does. Nothing here softens the diff-enforcement discipline.

import { parseJson } from "../llm/json";
import { hasEmDash } from "../llm/lint";
import { findSpan } from "./spans";
import type { FlaggedSpan } from "./diff";

// A plain patch: replace a verbatim `original` span with `replacement`.
export interface Patch {
  original: string;
  replacement: string;
}

// A declared out-of-span consistency fix, carrying its justification. The
// justification becomes a declared entry for the existing classifier.
export interface ConsistencyFix {
  original: string;
  replacement: string;
  justification: string;
}

export interface PatchEnvelope {
  patches: Patch[];
  consistencyFixes: ConsistencyFix[];
}

export type ParsePatchResult =
  | { ok: true; envelope: PatchEnvelope }
  | { ok: false; error: string; raw: string };

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

// Parses the patch envelope defensively. A response that is not a JSON object
// with a `patches` array (for example a full-text prose revision) fails to parse,
// which the caller treats as a signal to fall back to full-text mode. Invalid
// individual entries are dropped; the shape as a whole is required.
export function parsePatchEnvelope(text: string): ParsePatchResult {
  const parsed = parseJson<unknown>(text);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error, raw: text };
  }
  const obj = parsed.value;
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    return { ok: false, error: "not a patch object", raw: text };
  }
  const rec = obj as Record<string, unknown>;
  if (!Array.isArray(rec.patches)) {
    return { ok: false, error: "missing patches array", raw: text };
  }
  const patches: Patch[] = [];
  for (const p of rec.patches) {
    if (p && typeof p === "object") {
      const original = asString((p as Record<string, unknown>).original);
      const replacement = asString((p as Record<string, unknown>).replacement);
      if (original.length > 0) patches.push({ original, replacement });
    }
  }
  const consistencyFixes: ConsistencyFix[] = [];
  const rawFixes = Array.isArray(rec.consistency_fixes)
    ? rec.consistency_fixes
    : [];
  for (const f of rawFixes) {
    if (f && typeof f === "object") {
      const r = f as Record<string, unknown>;
      const original = asString(r.original);
      const replacement = asString(r.replacement);
      const justification = asString(r.justification);
      if (original.length > 0) {
        consistencyFixes.push({ original, replacement, justification });
      }
    }
  }
  return { ok: true, envelope: { patches, consistencyFixes } };
}

// A patch that could not be applied, with why, so the UI can surface it.
export interface FailedPatch {
  original: string;
  replacement: string;
  reason: "not found" | "overlap";
  isConsistencyFix: boolean;
}

export interface ApplyPatchesResult {
  newText: string;
  failedPatches: FailedPatch[];
  // Justifications of the consistency fixes that were actually applied. These are
  // the declared entries fed to the unmodified analyzeRevision classifier.
  declaredJustifications: string[];
}

interface Anchored {
  start: number;
  end: number;
  replacement: string;
  original: string;
  justification: string | null;
}

// Applies patches and consistency fixes to `original`, producing the revised full
// text. Each `original` is anchored by findSpan (cached-hint-then-first-occurrence,
// the same helper the classifier uses). Application is offset-safe and
// order-independent: anchors are resolved against the ORIGINAL text, sorted by
// position, and spliced left to right, so the order patches arrive in does not
// matter. A patch whose anchor is absent, or whose anchored range overlaps an
// already-accepted one, is collected as a failed patch while the rest still apply.
export function applyPatches(
  original: string,
  patches: Patch[],
  consistencyFixes: ConsistencyFix[],
): ApplyPatchesResult {
  const failedPatches: FailedPatch[] = [];

  // Anchor everything against the original text first.
  type Candidate = {
    original: string;
    replacement: string;
    justification: string | null;
    isConsistencyFix: boolean;
    start: number;
    end: number;
  };
  const candidates: Candidate[] = [];
  const pushAnchored = (
    original_: string,
    replacement: string,
    justification: string | null,
    isConsistencyFix: boolean,
  ) => {
    const span = findSpan(original, original_);
    if (!span) {
      failedPatches.push({
        original: original_,
        replacement,
        reason: "not found",
        isConsistencyFix,
      });
      return;
    }
    candidates.push({
      original: original_,
      replacement,
      justification,
      isConsistencyFix,
      start: span.start,
      end: span.end,
    });
  };

  for (const p of patches) pushAnchored(p.original, p.replacement, null, false);
  for (const f of consistencyFixes) {
    pushAnchored(f.original, f.replacement, f.justification, true);
  }

  // Sort by position; drop overlaps (later one fails), keeping the earlier anchor.
  candidates.sort((a, b) => a.start - b.start || a.end - b.end);
  const accepted: Anchored[] = [];
  let lastEnd = -1;
  for (const c of candidates) {
    if (c.start < lastEnd) {
      failedPatches.push({
        original: c.original,
        replacement: c.replacement,
        reason: "overlap",
        isConsistencyFix: c.isConsistencyFix,
      });
      continue;
    }
    accepted.push({
      start: c.start,
      end: c.end,
      replacement: c.replacement,
      original: c.original,
      justification: c.justification,
    });
    lastEnd = c.end;
  }

  // Splice left to right.
  const out: string[] = [];
  let cursor = 0;
  const declaredJustifications: string[] = [];
  for (const a of accepted) {
    out.push(original.slice(cursor, a.start));
    out.push(a.replacement);
    cursor = a.end;
    if (a.justification && a.justification.trim().length > 0) {
      declaredJustifications.push(a.justification.trim());
    }
  }
  out.push(original.slice(cursor));

  return { newText: out.join(""), failedPatches, declaredJustifications };
}

// True if any patch or consistency-fix REPLACEMENT contains an em-dash. Patch mode
// only controls the replacement text (originals come from the existing chapter),
// so the em-dash lint targets replacements (SPEC A4.2).
export function replacementsHaveEmDash(
  patches: Patch[],
  consistencyFixes: ConsistencyFix[],
): boolean {
  for (const p of patches) if (hasEmDash(p.replacement)) return true;
  for (const f of consistencyFixes) if (hasEmDash(f.replacement)) return true;
  return false;
}

// Merges overlapping flagged-span ranges and returns the fraction of the chapter's
// characters they cover. Used to decide the >40% full-mode fallback BEFORE calling
// the model (SPEC A4.2): a revision that touches most of the chapter is not a good
// fit for surgical patches.
export function flaggedCoverage(
  text: string,
  flaggedSpans: FlaggedSpan[],
): number {
  if (text.length === 0) return 0;
  const ranges: Array<{ start: number; end: number }> = [];
  for (const span of flaggedSpans) {
    const found = findSpan(text, span.quotedText, span.spanStart ?? undefined);
    if (found && found.end > found.start) {
      ranges.push({ start: found.start, end: found.end });
    }
  }
  ranges.sort((a, b) => a.start - b.start);
  let covered = 0;
  let curStart = -1;
  let curEnd = -1;
  for (const r of ranges) {
    if (r.start > curEnd) {
      if (curEnd > curStart) covered += curEnd - curStart;
      curStart = r.start;
      curEnd = r.end;
    } else if (r.end > curEnd) {
      curEnd = r.end;
    }
  }
  if (curEnd > curStart) covered += curEnd - curStart;
  return covered / text.length;
}

// The >40% threshold from SPEC A4.2.
export const FULL_MODE_COVERAGE_THRESHOLD = 0.4;

export function shouldUseFullMode(
  text: string,
  flaggedSpans: FlaggedSpan[],
): boolean {
  return flaggedCoverage(text, flaggedSpans) > FULL_MODE_COVERAGE_THRESHOLD;
}
