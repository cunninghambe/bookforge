import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import { createChapter } from "@/lib/repo/chapters";
import {
  createDraftVersion,
  latestDraft,
  listDrafts,
} from "@/lib/repo/drafts";
import {
  createComment,
  getComment,
  listUnresolvedPlainComments,
  listUnresolvedSuggestions,
} from "@/lib/repo/comments";
import {
  applyUnresolvedSuggestions,
  validateSuggestedText,
} from "@/lib/repo/suggestions";

// A22.2: a suggestion is a comment row with non-null suggested_text (D175); it
// applies mechanically with no model call (D176). These tests pin the validation
// (em-dash, same-text, empty), the discriminating list helpers, and the apply
// engine (anchoring, not-found and overlap skips, one new version, resolved rows
// stay put, unresolved rows move to the new draft, stale-draft 409, empty 400).

describe("validateSuggestedText", () => {
  it("rejects empty or whitespace-only replacement text", () => {
    expect(validateSuggestedText("old", "").ok).toBe(false);
    expect(validateSuggestedText("old", "   ").ok).toBe(false);
  });

  it("rejects a replacement identical to the quoted original", () => {
    expect(validateSuggestedText("the gate", "the gate").ok).toBe(false);
  });

  it("rejects a replacement containing an em-dash", () => {
    expect(validateSuggestedText("the gate", "the gate—open").ok).toBe(false);
    // A double hyphen used as an em-dash is caught by the same lint.
    expect(validateSuggestedText("the gate", "the gate -- open").ok).toBe(false);
  });

  it("accepts a distinct, clean replacement", () => {
    expect(validateSuggestedText("the gate", "the door").ok).toBe(true);
  });
});

describe("suggestion list discriminators", () => {
  it("splits unresolved rows into plain comments and suggestions by nullability", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "C" });
    const draft = createDraftVersion(db, ch.id, "Mara crossed the bridge.");
    createComment(db, {
      draftId: draft.id,
      quotedText: "the bridge",
      comment: "which bridge?",
    });
    createComment(db, {
      draftId: draft.id,
      quotedText: "Mara",
      comment: "",
      suggestedText: "Kesh",
    });
    const plain = listUnresolvedPlainComments(db, draft.id);
    const suggestions = listUnresolvedSuggestions(db, draft.id);
    expect(plain.map((r) => r.quotedText)).toEqual(["the bridge"]);
    expect(suggestions.map((r) => r.quotedText)).toEqual(["Mara"]);
    expect(suggestions[0].suggestedText).toBe("Kesh");
  });
});

describe("applyUnresolvedSuggestions", () => {
  it("applies one suggestion, mints exactly one new version, and updates the prose", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "C" });
    const draft = createDraftVersion(db, ch.id, "Mara crossed the bridge. Kesh waited.");
    const s = createComment(db, {
      draftId: draft.id,
      quotedText: "the bridge",
      comment: "",
      suggestedText: "the ridge",
    });

    const result = applyUnresolvedSuggestions(db, draft.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(1);
    expect(result.skips).toEqual([]);
    expect(result.draft.content).toBe("Mara crossed the ridge. Kesh waited.");

    // Exactly one new version was inserted.
    expect(listDrafts(db, ch.id)).toHaveLength(2);
    expect(latestDraft(db, ch.id)!.id).toBe(result.draft.id);

    // The applied suggestion is resolved and stays on the version it applied to.
    const applied = getComment(db, s.id)!;
    expect(applied.resolved).toBe(1);
    expect(applied.draftId).toBe(draft.id);
  });

  it("moves unresolved rows to the new draft while resolved-applied rows stay", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "C" });
    const draft = createDraftVersion(db, ch.id, "alpha bravo charlie delta");
    const applied = createComment(db, {
      draftId: draft.id,
      quotedText: "bravo",
      comment: "",
      suggestedText: "BRAVO",
    });
    const plain = createComment(db, {
      draftId: draft.id,
      quotedText: "delta",
      comment: "tighten this",
    });

    const result = applyUnresolvedSuggestions(db, draft.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(1);
    expect(result.draft.content).toBe("alpha BRAVO charlie delta");

    // The applied suggestion resolves and keeps the old draft_id.
    const a = getComment(db, applied.id)!;
    expect(a.resolved).toBe(1);
    expect(a.draftId).toBe(draft.id);
    // The still-unresolved plain comment moves to the new draft.
    const p = getComment(db, plain.id)!;
    expect(p.resolved).toBe(0);
    expect(p.draftId).toBe(result.draft.id);
  });

  it("skips an unanchorable suggestion with reason 'not found' and reports it", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "C" });
    const draft = createDraftVersion(db, ch.id, "alpha bravo charlie");
    createComment(db, {
      draftId: draft.id,
      quotedText: "bravo",
      comment: "",
      suggestedText: "BRAVO",
    });
    const bogus = createComment(db, {
      draftId: draft.id,
      quotedText: "zulu",
      comment: "",
      suggestedText: "ZULU",
    });

    const result = applyUnresolvedSuggestions(db, draft.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(1);
    expect(result.draft.content).toBe("alpha BRAVO charlie");
    expect(result.skips).toEqual([
      { id: bogus.id, quotedText: "zulu", suggestedText: "ZULU", reason: "not found" },
    ]);
    // The skipped suggestion stays unresolved and moves to the new draft.
    const b = getComment(db, bogus.id)!;
    expect(b.resolved).toBe(0);
    expect(b.draftId).toBe(result.draft.id);
  });

  it("skips a later suggestion that overlaps an earlier-applied one", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "C" });
    const draft = createDraftVersion(db, ch.id, "one two three four");
    const first = createComment(db, {
      draftId: draft.id,
      quotedText: "two three",
      comment: "",
      suggestedText: "2 3",
    });
    const overlapping = createComment(db, {
      draftId: draft.id,
      quotedText: "three four",
      comment: "",
      suggestedText: "3 4",
    });

    const result = applyUnresolvedSuggestions(db, draft.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(1);
    expect(result.draft.content).toBe("one 2 3 four");
    expect(result.skips).toEqual([
      {
        id: overlapping.id,
        quotedText: "three four",
        suggestedText: "3 4",
        reason: "overlap",
      },
    ]);
    // The applied one resolved; the overlapped one still pending.
    expect(getComment(db, first.id)!.resolved).toBe(1);
    expect(getComment(db, overlapping.id)!.resolved).toBe(0);
  });

  it("returns 409 when the draft is no longer the chapter's latest version", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "C" });
    const stale = createDraftVersion(db, ch.id, "old text with a gate");
    createComment(db, {
      draftId: stale.id,
      quotedText: "a gate",
      comment: "",
      suggestedText: "a door",
    });
    // A newer version supersedes the one the suggestion sits on.
    createDraftVersion(db, ch.id, "new text with a gate");

    const result = applyUnresolvedSuggestions(db, stale.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(409);
  });

  it("returns 400 when there are no unresolved suggestions", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "C" });
    const draft = createDraftVersion(db, ch.id, "Mara crossed the bridge.");
    // A plain comment is not a suggestion.
    createComment(db, {
      draftId: draft.id,
      quotedText: "the bridge",
      comment: "which bridge?",
    });

    const result = applyUnresolvedSuggestions(db, draft.id);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    // No new version was created.
    expect(listDrafts(db, ch.id)).toHaveLength(1);
  });

  it("does not mint a new version when every suggestion fails to anchor", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "C" });
    const draft = createDraftVersion(db, ch.id, "alpha bravo charlie");
    createComment(db, {
      draftId: draft.id,
      quotedText: "not present here",
      comment: "",
      suggestedText: "replacement",
    });

    const result = applyUnresolvedSuggestions(db, draft.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toBe(0);
    expect(result.skips).toHaveLength(1);
    expect(result.draft.id).toBe(draft.id);
    expect(listDrafts(db, ch.id)).toHaveLength(1);
  });
});
