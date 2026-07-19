import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import { getLlmClient } from "@/lib/llm/client";
import { modelFor } from "@/lib/modelFor";
import { sweepChapter, sweepCanonPrefix } from "@/lib/sweep";

// Amendment A18: sweeps exactly ONE locked chapter per request, so a request can
// never outlive a single model call (the 502 fix D158 documents for the scan). The
// A4.1 locked-canon prefix is rebuilt per request (byte-identical to the prefix
// runSweep builds once, so provider-side prompt caching keeps hitting across the
// run). The single call runs and this chapter's report entry is returned. Per-call
// LLM and parse failures arrive inside that entry's error fields (A2.2); a
// request-level error (bad chapter, canon load failure) surfaces its reason here,
// never a bare failure.
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

  try {
    const report = await sweepChapter(db, getLlmClient(), {
      chapterId,
      projectId,
      prefix: sweepCanonPrefix(db, projectId),
      fixtureKey,
      model: modelFor(db, "sweep"),
    });
    return NextResponse.json({ report });
  } catch (err) {
    // A2.2: the underlying reason, never a bare failure. This path is a request
    // level error (bad chapter, canon load failure); per-call LLM and parse
    // failures already arrive inside report.error / report.parseError.
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Sweep failed: ${message}` },
      { status: 400 },
    );
  }
}
