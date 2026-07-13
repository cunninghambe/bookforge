import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import { createChapterAtOrder, listChapters } from "@/lib/repo/chapters";
import { createDraftVersion } from "@/lib/repo/drafts";
import { generateAndStoreSummary, runCanonExtraction } from "@/lib/lockFlow";

// Backfill importer (SPEC section 7). Pastes one chapter's text, saves it as a
// LOCKED chapter at the confirmed order with a single draft version, then runs
// the exact same summary + canon extraction flow as locking (Amendment A1: both
// fact and character-state proposals), reusing generateAndStoreSummary and
// runCanonExtraction so the flow is not implemented twice. Proposals are
// returned for the client's approval checklist; approval itself goes through the
// existing POST /api/extractions/approve gate, unchanged.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await ctx.params;
  const projectId = Number(id);
  const project = getProject(db, projectId);
  if (!project) return NextResponse.json({ error: "not found" }, { status: 404 });

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  const title = typeof body.title === "string" ? body.title.trim() : "";
  const content = typeof body.content === "string" ? body.content : "";
  if (!title) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }
  if (!content.trim()) {
    return NextResponse.json({ error: "chapter text required" }, { status: 400 });
  }

  // Confirmed order, clamped to the valid range so an out-of-range value from the
  // client cannot create a gap or a duplicate: 0 (first) through the current
  // chapter count (append at the end).
  const existingCount = listChapters(db, projectId).length;
  const requestedOrder = Number(body.orderIndex);
  const orderIndex = Number.isFinite(requestedOrder)
    ? Math.min(Math.max(Math.round(requestedOrder), 0), existingCount)
    : existingCount;

  const fixtureKey =
    typeof body.fixtureKey === "string" ? body.fixtureKey : undefined;

  const chapter = createChapterAtOrder(db, { projectId, title, orderIndex });
  const draft = createDraftVersion(db, chapter.id, content);

  const { chapter: locked, summary } = await generateAndStoreSummary(
    db,
    chapter,
    content,
    fixtureKey,
  );
  const extraction = await runCanonExtraction(db, chapter, content, fixtureKey);

  if (!extraction.ok) {
    return NextResponse.json({
      ok: false,
      chapter: locked ?? chapter,
      draft,
      summary,
      error: extraction.error,
      raw: extraction.raw,
    });
  }

  return NextResponse.json({
    ok: true,
    chapter: locked ?? chapter,
    draft,
    summary,
    facts: extraction.facts,
    states: extraction.states,
  });
}
