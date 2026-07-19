import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import { sweepableChapters } from "@/lib/sweep";
import { orderToUiChapter } from "@/lib/chapterNumbering";

// Consistency sweep over a chapter range (SPEC section 6). Amendment A18, revised
// after the same production failure D158 documents for the scan: this endpoint now
// PLANS a sweep (no LLM call). The original design ran every chapter's model call
// inside this one request; on a real book the request outlived the infrastructure's
// patience (chapter-sized prompts run minutes each) and died as a 502 partway
// through, discarding completed work. The client now drives the run one chapter per
// request against POST .../sweep/chapter, so no HTTP request ever spans more than
// one model call. This call validates the order range and returns the ordered
// locked-chapter targets.
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

  const targets = sweepableChapters(db, { projectId, fromOrder, toOrder });
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
