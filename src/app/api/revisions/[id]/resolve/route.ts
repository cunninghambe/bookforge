import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getRevision, markRevisionResolved } from "@/lib/repo/revisions";
import { createDraftVersion } from "@/lib/repo/drafts";
import {
  analyzeRevision,
  applyResolution,
  type HunkDecision,
} from "@/lib/revision/diff";

// Applies per-hunk accept/reject decisions and saves the result as a NEW draft
// version. Every unauthorized hunk must have a decision; authorized and declared
// hunks are always kept. Unresolved comments do not carry forward to the new
// version (a revision creates a new version; comments are per-version anchors).
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await ctx.params;
  const revisionId = Number(id);
  const revision = getRevision(db, revisionId);
  if (!revision) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  if (revision.status === "resolved") {
    return NextResponse.json({ error: "already resolved" }, { status: 409 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const rawDecisions =
    body.decisions && typeof body.decisions === "object"
      ? (body.decisions as Record<string, unknown>)
      : {};
  const decisions: Record<number, HunkDecision> = {};
  for (const [key, val] of Object.entries(rawDecisions)) {
    const idx = Number(key);
    if (!Number.isFinite(idx)) continue;
    if (val === "accept" || val === "reject") decisions[idx] = val;
  }

  const input = {
    flaggedSpans: revision.flaggedSpans,
    consistencyFixes: revision.consistencyFixes,
  };
  const { hunks } = analyzeRevision(revision.oldText, revision.newText, input);

  // Every unauthorized hunk must be resolved before the revision can save.
  const unresolved = hunks.filter(
    (h) => h.classification === "unauthorized" && decisions[h.index] === undefined,
  );
  if (unresolved.length > 0) {
    return NextResponse.json(
      {
        error: "unresolved warnings",
        unresolvedHunks: unresolved.map((h) => h.index),
      },
      { status: 400 },
    );
  }

  const finalText = applyResolution(
    revision.oldText,
    revision.newText,
    input,
    decisions,
  );
  const draft = createDraftVersion(db, revision.chapterId, finalText);
  markRevisionResolved(db, revisionId);
  return NextResponse.json({ draft });
}
