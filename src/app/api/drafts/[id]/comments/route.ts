import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getDraft } from "@/lib/repo/drafts";
import { createComment, listComments } from "@/lib/repo/comments";
import { validateSuggestedText } from "@/lib/repo/suggestions";

type Ctx = { params: Promise<{ id: string }> };

// Lists a draft's comments with offsets recomputed against the current draft text.
export async function GET(_req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const draftId = Number(id);
  const draft = getDraft(db, draftId);
  if (!draft) return NextResponse.json({ error: "not found" }, { status: 404 });
  const comments = listComments(db, draftId, draft.content);
  return NextResponse.json({ comments });
}

// Creates a comment anchored to a selected span. quoted_text is the source of
// truth; span_start / span_end are cached best-effort.
export async function POST(req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const draftId = Number(id);
  const draft = getDraft(db, draftId);
  if (!draft) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const quotedText = typeof body.quotedText === "string" ? body.quotedText : "";
  const comment = typeof body.comment === "string" ? body.comment : "";
  // A22: an optional suggestedText makes this a suggestion (the discriminator is
  // nullability, D175). When present it is linted: non-empty, different from the
  // quoted original, and em-dash free (it lands verbatim in the draft). The note
  // (the comment column) is optional for a suggestion and never linted.
  const hasSuggestion =
    body.suggestedText !== undefined && body.suggestedText !== null;
  const suggestedText =
    typeof body.suggestedText === "string" ? body.suggestedText : "";
  if (!quotedText.trim()) {
    return NextResponse.json({ error: "quotedText required" }, { status: 400 });
  }
  if (hasSuggestion) {
    const validation = validateSuggestedText(quotedText, suggestedText);
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
  } else if (!comment.trim()) {
    return NextResponse.json({ error: "comment required" }, { status: 400 });
  }
  const created = createComment(db, {
    draftId,
    quotedText,
    comment,
    spanStart: typeof body.spanStart === "number" ? body.spanStart : null,
    spanEnd: typeof body.spanEnd === "number" ? body.spanEnd : null,
    suggestedText: hasSuggestion ? suggestedText : null,
  });
  return NextResponse.json({ comment: created });
}
