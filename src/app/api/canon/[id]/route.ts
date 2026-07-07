import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  CANON_STATUSES,
  CANON_TYPES,
  type CanonStatus,
  type CanonType,
  deleteCanon,
  getCanon,
  updateCanon,
} from "@/lib/repo/canon";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const factId = Number(id);
  if (!Number.isFinite(factId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  if (!getCanon(db, factId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const type = body.type as string | undefined;
  const status = body.status as string | undefined;
  if (type !== undefined && !CANON_TYPES.includes(type as CanonType)) {
    return NextResponse.json({ error: "invalid type" }, { status: 400 });
  }
  if (status !== undefined && !CANON_STATUSES.includes(status as CanonStatus)) {
    return NextResponse.json({ error: "invalid status" }, { status: 400 });
  }
  const fact = updateCanon(db, factId, {
    content:
      typeof body.content === "string" ? body.content : undefined,
    type: type as CanonType | undefined,
    status: status as CanonStatus | undefined,
    projectId:
      body.projectId === null
        ? null
        : typeof body.projectId === "number"
          ? body.projectId
          : undefined,
  });
  return NextResponse.json({ fact });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const factId = Number(id);
  if (!Number.isFinite(factId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  deleteCanon(db, factId);
  return NextResponse.json({ ok: true });
}
