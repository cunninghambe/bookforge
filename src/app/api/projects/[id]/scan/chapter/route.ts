import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import { getLlmClient } from "@/lib/llm/client";
import { modelFor } from "@/lib/modelFor";
import {
  scanChapter,
  scanAttachTargets,
  deriveProposedNames,
} from "@/lib/scan";
import {
  accumulateScanProposals,
  type ScanChapterProposals,
} from "@/lib/llm/extraction";

// Amendment A17 (revised): scans exactly ONE locked chapter per request, so a
// request can never outlive a single model call (the 502 fix). The client sends
// the raw per-chapter proposal history of the run so far (prior); the server
// derives the proposed-names feed-forward for the prompt from it, runs the one
// call, and returns this chapter's outcome plus the WHOLE run's merged
// grouped-by-thread checklist (prior plus this chapter), keeping the merge
// logic server-side and unit-tested. Nothing lands here: approval stays a
// separate human step (POST .../scan/approve).
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
  const chapterId = Number(body.chapterId);
  if (!Number.isFinite(chapterId)) {
    return NextResponse.json({ error: "chapterId required" }, { status: 400 });
  }
  const fixtureKey =
    typeof body.fixtureKey === "string" ? body.fixtureKey : undefined;
  const prior = Array.isArray(body.prior)
    ? (body.prior as ScanChapterProposals[])
    : [];

  const existing = scanAttachTargets(db, projectId);
  try {
    const { outcome, proposals } = await scanChapter(db, getLlmClient(), {
      chapterId,
      projectId,
      fixtureKey,
      model: modelFor(db, "extraction"),
      existing,
      proposedThisRun: deriveProposedNames(prior, existing),
    });
    const history = proposals ? [...prior, proposals] : prior;
    const { attaches, news } = accumulateScanProposals(history, existing);
    return NextResponse.json({ outcome, proposals, attaches, news });
  } catch (err) {
    // A2.2: the underlying reason, never a bare failure. This path is a request
    // level error (bad chapter, thread load failure); per-call LLM and parse
    // failures already arrive inside outcome.
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Scan failed: ${message}` },
      { status: 400 },
    );
  }
}
