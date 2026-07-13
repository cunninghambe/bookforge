import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import { getLlmClient } from "@/lib/llm/client";
import { runSweep, sweepableChapters } from "@/lib/sweep";

// Consistency sweep over a chapter range (SPEC section 6). One UTILITY_MODEL call
// per locked chapter (purpose "sweep"), sequential, aggregated into a report. The
// body carries the order_index range; a GET-style estimate is done client-side
// from the locked-chapter list before running.
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
  const fixtureKey =
    typeof body.fixtureKey === "string" ? body.fixtureKey : undefined;

  const chapters = sweepableChapters(db, { projectId, fromOrder, toOrder });
  if (chapters.length === 0) {
    return NextResponse.json({ report: { chapters: [], totalContradictions: 0 } });
  }

  const client = getLlmClient();
  const model = process.env.UTILITY_MODEL ?? "claude-sonnet-4-6";
  const report = await runSweep(db, client, {
    projectId,
    fromOrder,
    toOrder,
    fixtureKey,
    model,
  });
  return NextResponse.json({ report });
}
