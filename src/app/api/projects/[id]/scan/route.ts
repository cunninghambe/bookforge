import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import { scanTargets } from "@/lib/scan";
import { orderToUiChapter } from "@/lib/chapterNumbering";

// Amendment A17, revised after the first production run: this endpoint PLANS a
// scan (no LLM call). The original design ran every chapter's model call inside
// this one request; on a real book the request outlived the infrastructure's
// patience (chapter-sized prompts run minutes each) and died as a 502 partway
// through. The client now drives the run one chapter per request against
// POST .../scan/chapter, so no HTTP request ever spans more than one model call.
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

  const targets = scanTargets(db, {
    projectId,
    fromOrder,
    toOrder,
    includeTouched,
  });
  return NextResponse.json({
    plan: {
      targets: targets.map((c) => ({
        chapterId: c.id,
        order: orderToUiChapter(c.orderIndex),
        title: c.title ?? `Chapter ${orderToUiChapter(c.orderIndex)}`,
      })),
    },
  });
}
