import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { addState, getCharacter, listStates } from "@/lib/repo/characters";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const charId = Number(id);
  if (!Number.isFinite(charId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  return NextResponse.json({ states: listStates(db, charId) });
}

export async function POST(req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const charId = Number(id);
  if (!Number.isFinite(charId) || !getCharacter(db, charId)) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const projectId = Number(body.projectId);
  const chapterOrder = Number(body.chapterOrder);
  if (!Number.isFinite(projectId) || !Number.isFinite(chapterOrder)) {
    return NextResponse.json(
      { error: "projectId and chapterOrder required" },
      { status: 400 },
    );
  }
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const state = addState(db, {
    characterId: charId,
    projectId,
    chapterOrder,
    knows: str(body.knows),
    feels: str(body.feels),
    hiding: str(body.hiding),
  });
  return NextResponse.json({ state }, { status: 201 });
}
