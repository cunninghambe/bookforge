import { and, eq, sql } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";
import { findSpan } from "../revision/spans";
import { hasEmDash } from "../llm/lint";
import { getDraft, latestDraft } from "./drafts";
import { listUnresolvedSuggestions } from "./comments";

type Db = BetterSQLite3Database<typeof schema>;

export type SuggestionValidation = { ok: true } | { ok: false; error: string };

// A22: validates an author-typed suggestion replacement. The replacement lands
// verbatim in the draft (no model call), so the em-dash house law applies to it
// exactly as it does to generated prose. It must be non-empty and must differ from
// the quoted original. The optional note (the comment column) is never linted here.
export function validateSuggestedText(
  quotedText: string,
  suggestedText: string,
): SuggestionValidation {
  if (suggestedText.trim().length === 0) {
    return { ok: false, error: "a suggestion needs replacement text" };
  }
  if (suggestedText === quotedText) {
    return { ok: false, error: "the suggestion matches the original text" };
  }
  if (hasEmDash(suggestedText)) {
    return { ok: false, error: "a suggestion may not contain an em-dash" };
  }
  return { ok: true };
}

export interface SuggestionSkip {
  id: number;
  quotedText: string;
  suggestedText: string;
  reason: "not found" | "overlap";
}

export type ApplySuggestionsResult =
  | { ok: false; status: 400 | 409; error: string }
  | {
      ok: true;
      draft: { id: number; content: string };
      applied: number;
      skips: SuggestionSkip[];
    };

interface Anchored {
  id: number;
  start: number;
  end: number;
  suggestedText: string;
  quotedText: string;
}

// A22 (D176/D177): mechanically apply every unresolved suggestion on the draft,
// with NO model call. quoted_text is the anchor source of truth, as everywhere:
// each suggestion is located by findSpan; an unanchorable one is skipped ("not
// found"), and among the anchored ones sorted by start any that overlaps an
// earlier-applied one is skipped ("overlap"). The applicable replacements are
// spliced in ONE transaction that inserts exactly one new draft version. Applied
// rows are marked resolved and keep their draft_id (they record what was applied to
// which version); every still-unresolved row (plain comments and skipped
// suggestions) has its draft_id moved to the new draft so review continuity
// survives. Returns 409 when the draft is no longer the chapter's latest version
// and 400 when there are no unresolved suggestions to apply.
export function applyUnresolvedSuggestions(
  db: Db,
  draftId: number,
): ApplySuggestionsResult {
  const draft = getDraft(db, draftId);
  if (!draft) return { ok: false, status: 400, error: "draft not found" };

  const latest = latestDraft(db, draft.chapterId);
  if (!latest || latest.id !== draftId) {
    return {
      ok: false,
      status: 409,
      error: "this draft is no longer the chapter's latest version",
    };
  }

  const suggestions = listUnresolvedSuggestions(db, draftId);
  if (suggestions.length === 0) {
    return {
      ok: false,
      status: 400,
      error: "no unresolved suggestions to apply",
    };
  }

  const content = draft.content;
  const anchored: Anchored[] = [];
  const skips: SuggestionSkip[] = [];

  for (const s of suggestions) {
    const replacement = s.suggestedText ?? "";
    const span = findSpan(content, s.quotedText, s.spanStart);
    if (!span) {
      skips.push({
        id: s.id,
        quotedText: s.quotedText,
        suggestedText: replacement,
        reason: "not found",
      });
      continue;
    }
    anchored.push({
      id: s.id,
      start: span.start,
      end: span.end,
      suggestedText: replacement,
      quotedText: s.quotedText,
    });
  }

  anchored.sort((a, b) => a.start - b.start || a.end - b.end);

  const applied: Anchored[] = [];
  let lastEnd = -1;
  for (const a of anchored) {
    if (a.start < lastEnd) {
      skips.push({
        id: a.id,
        quotedText: a.quotedText,
        suggestedText: a.suggestedText,
        reason: "overlap",
      });
      continue;
    }
    applied.push(a);
    lastEnd = a.end;
  }

  // Nothing anchored cleanly: report the skips without minting an identical new
  // version. The still-unresolved rows stay on this draft (which is still latest).
  if (applied.length === 0) {
    return {
      ok: true,
      draft: { id: draftId, content },
      applied: 0,
      skips,
    };
  }

  // Splice the applied replacements left to right (sorted, non-overlapping).
  let newContent = "";
  let cursor = 0;
  for (const a of applied) {
    newContent += content.slice(cursor, a.start);
    newContent += a.suggestedText;
    cursor = a.end;
  }
  newContent += content.slice(cursor);

  let newDraftId = draftId;
  db.transaction((tx) => {
    const row = tx
      .select({ max: sql<number>`COALESCE(MAX(${schema.drafts.version}), 0)` })
      .from(schema.drafts)
      .where(eq(schema.drafts.chapterId, draft.chapterId))
      .get();
    const version = (row?.max ?? 0) + 1;
    const created = tx
      .insert(schema.drafts)
      .values({ chapterId: draft.chapterId, version, content: newContent })
      .returning()
      .get();
    newDraftId = created.id;

    // Applied suggestions resolve and STAY on the version they applied to.
    for (const a of applied) {
      tx.update(schema.comments)
        .set({ resolved: 1 })
        .where(eq(schema.comments.id, a.id))
        .run();
    }

    // Every row still unresolved (plain comments and skipped suggestions) moves to
    // the new draft; already-resolved rows stay put.
    tx.update(schema.comments)
      .set({ draftId: newDraftId })
      .where(
        and(
          eq(schema.comments.draftId, draftId),
          eq(schema.comments.resolved, 0),
        ),
      )
      .run();
  });

  return {
    ok: true,
    draft: { id: newDraftId, content: newContent },
    applied: applied.length,
    skips,
  };
}
