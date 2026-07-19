import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { createSeries, listSeries } from "@/lib/repo/series";

// Amendment A16: list and create series. Creating a series copies the five seed
// style rules into it and creates its first book with a default title, so the
// author lands ready to write. Validation follows the canon route style.
export async function GET() {
  const db = getDb();
  return NextResponse.json({ series: listSeries(db) });
}

export async function POST(req: Request) {
  const db = getDb();
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "bad request" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  if (!title) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }
  const firstBookTitle =
    typeof body.firstBookTitle === "string" ? body.firstBookTitle : undefined;
  const { series, firstBook } = createSeries(db, { title, firstBookTitle });
  return NextResponse.json({ series, firstBook }, { status: 201 });
}
