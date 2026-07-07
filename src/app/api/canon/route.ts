import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import {
  CANON_STATUSES,
  CANON_TYPES,
  type CanonStatus,
  type CanonType,
  bulkCreateCanon,
  createCanon,
  listCanon,
} from "@/lib/repo/canon";

function parseScope(v: string | null): "series" | number | undefined {
  if (v === null || v === "all") return undefined;
  if (v === "series") return "series";
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(req: Request) {
  const db = getDb();
  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const status = url.searchParams.get("status");
  const scope = url.searchParams.get("scope");
  const facts = listCanon(db, {
    type: CANON_TYPES.includes(type as CanonType) ? (type as CanonType) : undefined,
    status: CANON_STATUSES.includes(status as CanonStatus)
      ? (status as CanonStatus)
      : undefined,
    scope: parseScope(scope),
  });
  return NextResponse.json({ facts });
}

export async function POST(req: Request) {
  const db = getDb();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }

  // Bulk paste path.
  if (body.bulk === true) {
    const type = body.type as string;
    if (!CANON_TYPES.includes(type as CanonType)) {
      return NextResponse.json({ error: "invalid type" }, { status: 400 });
    }
    const facts = bulkCreateCanon(db, {
      lines: String(body.lines ?? ""),
      type: type as CanonType,
      projectId:
        typeof body.projectId === "number" ? body.projectId : null,
    });
    return NextResponse.json({ facts }, { status: 201 });
  }

  const type = body.type as string;
  const content = body.content as string;
  if (!CANON_TYPES.includes(type as CanonType)) {
    return NextResponse.json({ error: "invalid type" }, { status: 400 });
  }
  if (typeof content !== "string" || content.trim().length === 0) {
    return NextResponse.json({ error: "content required" }, { status: 400 });
  }
  const status = body.status as string | undefined;
  const fact = createCanon(db, {
    type: type as CanonType,
    content: content.trim(),
    projectId: typeof body.projectId === "number" ? body.projectId : null,
    status: CANON_STATUSES.includes(status as CanonStatus)
      ? (status as CanonStatus)
      : "provisional",
    source: typeof body.source === "string" ? body.source : "manual",
  });
  return NextResponse.json({ fact }, { status: 201 });
}
