import { diffLines, diffWordsWithSpace } from "diff";
import { findSpan } from "./spans";

// Diff enforcement: the mechanical discipline that a revision may only touch what
// the author flagged. We compute a line-based diff with word-level refinement,
// group it into changed hunks, and classify every hunk as one of:
//   - "authorized": overlaps a flagged span, with a tolerance window on each side
//   - "declared":   corresponds to a [CONSISTENCY FIXES] entry from the model
//   - "unauthorized": neither, so the UI must catch it for accept/reject
// Nothing here is ever softened; unauthorized hunks default to rejected until the
// author resolves them.

// Tolerance window (characters) on each side of a flagged span. A hunk counts as
// authorized if its old-text range overlaps [spanStart - TOLERANCE, spanEnd + TOLERANCE].
export const SPAN_TOLERANCE = 200;

export type Classification = "authorized" | "declared" | "unauthorized";

export interface WordPart {
  value: string;
  added?: boolean;
  removed?: boolean;
}

export interface Hunk {
  index: number;
  // Char offsets of the replaced text within the OLD text.
  oldStart: number;
  oldEnd: number;
  // The old (removed) and new (added) text for this hunk.
  oldText: string;
  newText: string;
  classification: Classification;
  // For declared hunks, the consistency-fix entry it matched.
  declaredBy?: string;
  // Word-level refinement of this hunk, for side-by-side rendering.
  wordDiff: WordPart[];
}

export interface FlaggedSpan {
  quotedText: string;
  spanStart?: number | null;
  spanEnd?: number | null;
  comment?: string;
}

interface Segment {
  type: "common" | "hunk";
  value?: string; // common text
  oldText?: string; // hunk removed text
  newText?: string; // hunk added text
  oldStart?: number;
  oldEnd?: number;
}

// Splits the line-diff into an ordered list of common runs and changed hunks,
// tracking each hunk's offset range within the old text. This single decomposition
// is shared by analysis and reconstruction so hunk indices stay stable.
function computeSegments(oldText: string, newText: string): Segment[] {
  const parts = diffLines(oldText, newText);
  const segments: Segment[] = [];
  let oldOffset = 0;

  let pendingOld = "";
  let pendingNew = "";
  let hunkStart = 0;
  let inHunk = false;

  const flushHunk = () => {
    if (!inHunk) return;
    segments.push({
      type: "hunk",
      oldText: pendingOld,
      newText: pendingNew,
      oldStart: hunkStart,
      oldEnd: hunkStart + pendingOld.length,
    });
    pendingOld = "";
    pendingNew = "";
    inHunk = false;
  };

  for (const part of parts) {
    if (part.added) {
      if (!inHunk) {
        inHunk = true;
        hunkStart = oldOffset;
      }
      pendingNew += part.value;
    } else if (part.removed) {
      if (!inHunk) {
        inHunk = true;
        hunkStart = oldOffset;
      }
      pendingOld += part.value;
      oldOffset += part.value.length;
    } else {
      // Common run: closes any open hunk, then advances the old offset.
      flushHunk();
      segments.push({ type: "common", value: part.value });
      oldOffset += part.value.length;
    }
  }
  flushHunk();
  return segments;
}

// Parses tokens out of a consistency-fix justification for the declared-match
// heuristic: quoted substrings (strongest signal, the model names what it changed)
// plus capitalized proper-noun-ish words of length >= 4.
function fixTokens(entry: string): string[] {
  const tokens: string[] = [];
  const quoted = entry.match(/["'`]([^"'`]+)["'`]/g);
  if (quoted) {
    for (const q of quoted) tokens.push(q.slice(1, -1).trim());
  }
  const proper = entry.match(/\b[A-Z][a-zA-Z]{3,}\b/g);
  if (proper) {
    for (const p of proper) tokens.push(p);
  }
  return tokens.filter((t) => t.length > 0);
}

// A hunk is declared by an entry when one of the entry's tokens appears in the
// hunk's changed text (old or new). Returns the matching entry, if any.
function matchDeclared(hunk: Segment, entries: string[]): string | undefined {
  const hay = `${hunk.oldText ?? ""}\n${hunk.newText ?? ""}`;
  for (const entry of entries) {
    const tokens = fixTokens(entry);
    for (const t of tokens) {
      if (hay.includes(t)) return entry;
    }
  }
  return undefined;
}

// True if [oldStart, oldEnd] overlaps any flagged span's tolerance window. Flagged
// span positions come from string search in the OLD text (cached offset as a hint).
function isAuthorized(
  hunk: Segment,
  windows: Array<{ start: number; end: number }>,
): boolean {
  const s = hunk.oldStart ?? 0;
  const e = hunk.oldEnd ?? 0;
  for (const w of windows) {
    if (s <= w.end && e >= w.start) return true;
  }
  return false;
}

export interface AnalyzeInput {
  flaggedSpans: FlaggedSpan[];
  consistencyFixes: string[];
}

export interface Analysis {
  hunks: Hunk[];
  unauthorizedCount: number;
}

export function analyzeRevision(
  oldText: string,
  newText: string,
  input: AnalyzeInput,
): Analysis {
  const segments = computeSegments(oldText, newText);

  // Flagged-span tolerance windows, located in the OLD text.
  const windows: Array<{ start: number; end: number }> = [];
  for (const span of input.flaggedSpans) {
    const found = findSpan(oldText, span.quotedText, span.spanStart ?? undefined);
    if (found) {
      windows.push({
        start: found.start - SPAN_TOLERANCE,
        end: found.end + SPAN_TOLERANCE,
      });
    }
  }

  const hunks: Hunk[] = [];
  let index = 0;
  let unauthorizedCount = 0;
  for (const seg of segments) {
    if (seg.type !== "hunk") continue;
    let classification: Classification;
    let declaredBy: string | undefined;
    if (isAuthorized(seg, windows)) {
      classification = "authorized";
    } else {
      const match = matchDeclared(seg, input.consistencyFixes);
      if (match) {
        classification = "declared";
        declaredBy = match;
      } else {
        classification = "unauthorized";
        unauthorizedCount += 1;
      }
    }
    hunks.push({
      index,
      oldStart: seg.oldStart ?? 0,
      oldEnd: seg.oldEnd ?? 0,
      oldText: seg.oldText ?? "",
      newText: seg.newText ?? "",
      classification,
      declaredBy,
      wordDiff: diffWordsWithSpace(seg.oldText ?? "", seg.newText ?? ""),
    });
    index += 1;
  }

  return { hunks, unauthorizedCount };
}

export type HunkDecision = "accept" | "reject";

// Reconstructs the final text. Authorized and declared hunks are always accepted.
// Unauthorized hunks consult `decisions`: "reject" restores the original text for
// that hunk, "accept" (or an explicit decision) keeps the revised text. Accepting
// every hunk yields exactly newText; rejecting every unauthorized one restores the
// original for those spans while keeping the authorized and declared changes.
export function applyResolution(
  oldText: string,
  newText: string,
  input: AnalyzeInput,
  decisions: Record<number, HunkDecision>,
): string {
  const { hunks } = analyzeRevision(oldText, newText, input);
  const segments = computeSegments(oldText, newText);
  const out: string[] = [];
  let hunkIndex = 0;
  for (const seg of segments) {
    if (seg.type === "common") {
      out.push(seg.value ?? "");
      continue;
    }
    const hunk = hunks[hunkIndex];
    hunkIndex += 1;
    if (!hunk) {
      out.push(seg.newText ?? "");
      continue;
    }
    if (hunk.classification === "unauthorized") {
      const decision = decisions[hunk.index] ?? "reject";
      out.push(decision === "accept" ? seg.newText ?? "" : seg.oldText ?? "");
    } else {
      // Authorized and declared changes are kept.
      out.push(seg.newText ?? "");
    }
  }
  return out.join("");
}
