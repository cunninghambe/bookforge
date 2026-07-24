import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getDraft } from "@/lib/repo/drafts";
import { applyUnresolvedSuggestions } from "@/lib/repo/suggestions";

// A22.2: mechanically applies the draft's unresolved suggestions (the author's own
// replacement text) with NO model call. 404 when the draft is missing, 409 when it
// is no longer the chapter's latest version, 400 when there are no unresolved
// suggestions to apply. On success returns the new draft (id + content), the applied
// count, and the skipped suggestions with their reasons. See D176/D177.
export async function POST(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  const { id } = await ctx.params;
  const draftId = Number(id);
  if (!Number.isFinite(draftId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  if (!getDraft(db, draftId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }

  const result = applyUnresolvedSuggestions(db, draftId);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: result.status });
  }
  return NextResponse.json({
    draft: result.draft,
    applied: result.applied,
    skips: result.skips,
  });
}
