import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import { getLlmClient } from "@/lib/llm/client";
import { modelFor } from "@/lib/modelFor";
import { runScan, scanTargets } from "@/lib/scan";

// Amendment A17: the thread backfill scan over a chapter range. One call per
// locked chapter (purpose "extraction", model resolved per purpose (A8)),
// sequential, merged into ONE grouped-by-thread proposal set. Nothing lands here:
// approval is a separate call (POST .../scan/approve) so the proposals pass the
// human gate. The body carries the order_index range and includeTouched; the
// default range (includeTouched false) skips chapters that already have touches.
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
  const fromOrder = Number(body.fromOrder);
  const toOrder = Number(body.toOrder);
  if (!Number.isFinite(fromOrder) || !Number.isFinite(toOrder)) {
    return NextResponse.json(
      { error: "fromOrder and toOrder required" },
      { status: 400 },
    );
  }
  const includeTouched = body.includeTouched === true;
  const fixtureKey =
    typeof body.fixtureKey === "string" ? body.fixtureKey : undefined;

  const targets = scanTargets(db, {
    projectId,
    fromOrder,
    toOrder,
    includeTouched,
  });
  if (targets.length === 0) {
    return NextResponse.json({
      report: {
        chapters: [],
        attaches: [],
        news: [],
        scannedCount: 0,
        failedCount: 0,
      },
    });
  }

  const client = getLlmClient();
  const model = modelFor(db, "extraction");
  try {
    const report = await runScan(db, client, {
      projectId,
      fromOrder,
      toOrder,
      includeTouched,
      fixtureKey,
      model,
    });
    return NextResponse.json({ report });
  } catch (err) {
    // A2.2: a whole-run failure surfaces the underlying message so the UI never
    // shows a bare "Scan failed." with no reason. Per-chapter LLM failures are
    // already caught inside runScan and reported per chapter; this catches a
    // failure of the run itself (for example loading the thread list).
    const message = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: `Scan failed: ${message}` },
      { status: 500 },
    );
  }
}
