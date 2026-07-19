import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { newestPendingRevisionForDraft } from "@/lib/repo/revisions";
import { analyzeRevision } from "@/lib/revision/diff";

// Returns the draft's newest PENDING revision as the same control shape the
// revise stream delivers, with the hunks recomputed deterministically from the
// stored old/new text and spans (exactly what the resolve route does). This is
// the recovery path for a revision whose in-flight response was lost: a long
// call on a phone can outlive the tab (the field report: 103 seconds of
// server work ending in a silent UI), and the pending state was previously
// unreachable afterward. Nothing here softens the gate: resolution still goes
// through POST /api/revisions/[id]/resolve with every unauthorized hunk
// decided.
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const db = getDb();
  const { id } = await ctx.params;
  const draftId = Number(id);
  if (!Number.isFinite(draftId)) {
    return NextResponse.json({ error: "bad draft id" }, { status: 400 });
  }
  const revision = newestPendingRevisionForDraft(db, draftId);
  if (!revision) {
    return NextResponse.json({ revision: null });
  }
  const input = {
    flaggedSpans: revision.flaggedSpans,
    consistencyFixes: revision.consistencyFixes,
  };
  const analysis = analyzeRevision(revision.oldText, revision.newText, input);
  return NextResponse.json({
    revision: {
      revisionId: revision.id,
      // The original call's mode and transient diagnostics (failed patches,
      // retry, em-dash flag) are not persisted; a restored view carries the
      // durable substance (the hunks and declared fixes) plus a restored
      // marker so the UI can say where it came from.
      mode: "patch",
      hunks: analysis.hunks,
      unauthorizedCount: analysis.unauthorizedCount,
      consistencyFixes: revision.consistencyFixes,
      failedPatches: [],
      retried: false,
      emDashUnresolved: false,
      restored: true,
    },
  });
}
