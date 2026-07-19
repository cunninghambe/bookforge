import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getProject } from "@/lib/repo/projects";
import {
  approveScan,
  type ScanApprovedAttach,
  type ScanApprovedNew,
  type ScanApprovedTouch,
} from "@/lib/repo/extraction";
import { isThreadType, isTouchKind } from "@/lib/repo/threads";

// Amendment A17: the scan approval gate. Only the touches the author checked are
// sent here, grouped by thread. Approved attaches add touches to an existing
// thread; approved new-thread groups create the thread plus its touches. Every
// touch is sourced 'scan:<chapter_id>'. A dangling thread or non-locked chapter
// rejects the whole call, leaving no trace (approveScan is atomic). No auto-resolve
// happens; flags recompute on the next threads-page load.
function parseTouches(raw: unknown): ScanApprovedTouch[] {
  if (!Array.isArray(raw)) return [];
  const out: ScanApprovedTouch[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const t = item as Record<string, unknown>;
    if (typeof t.chapterId !== "number") continue;
    if (!isTouchKind(t.kind)) continue;
    out.push({
      chapterId: t.chapterId,
      kind: t.kind,
      evidence:
        typeof t.evidence === "string" && t.evidence.trim()
          ? t.evidence.trim()
          : null,
    });
  }
  return out;
}

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

  const attaches: ScanApprovedAttach[] = [];
  if (Array.isArray(body.attaches)) {
    for (const raw of body.attaches) {
      if (!raw || typeof raw !== "object") continue;
      const a = raw as Record<string, unknown>;
      if (typeof a.threadId !== "number") continue;
      const touches = parseTouches(a.touches);
      if (touches.length === 0) continue;
      attaches.push({ threadId: a.threadId, touches });
    }
  }

  const newThreads: ScanApprovedNew[] = [];
  if (Array.isArray(body.newThreads)) {
    for (const raw of body.newThreads) {
      if (!raw || typeof raw !== "object") continue;
      const n = raw as Record<string, unknown>;
      const name = typeof n.name === "string" ? n.name.trim() : "";
      if (!name) continue;
      if (!isThreadType(n.type)) continue;
      const touches = parseTouches(n.touches);
      if (touches.length === 0) continue;
      newThreads.push({ name, type: n.type, touches });
    }
  }

  if (attaches.length === 0 && newThreads.length === 0) {
    return NextResponse.json({ error: "nothing approved" }, { status: 400 });
  }

  const result = approveScan(db, { projectId, attaches, newThreads });
  if (!result.ok) {
    return NextResponse.json(
      { error: result.error, unmatched: result.unmatched },
      { status: 400 },
    );
  }
  return NextResponse.json({
    ok: true,
    createdThreads: result.createdThreads,
    createdTouches: result.createdTouches,
  });
}
