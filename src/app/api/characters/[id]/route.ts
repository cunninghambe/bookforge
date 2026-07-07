import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  deleteCharacter,
  getCharacter,
  updateCharacter,
} from "@/lib/repo/characters";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
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
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const character = updateCharacter(db, charId, {
    name: str(body.name),
    role: str(body.role),
    voiceRules: str(body.voiceRules),
    physical: str(body.physical),
    notes: str(body.notes),
  });
  return NextResponse.json({ character });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const db = getDb();
  const { id } = await ctx.params;
  const charId = Number(id);
  if (!Number.isFinite(charId)) {
    return NextResponse.json({ error: "bad id" }, { status: 400 });
  }
  deleteCharacter(db, charId);
  return NextResponse.json({ ok: true });
}
