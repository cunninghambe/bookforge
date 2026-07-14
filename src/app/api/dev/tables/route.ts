import { NextResponse } from "next/server";
import { getRawDb } from "@/lib/db";

// Dev-only readback of the SQLite table names, for asserting that chat leaves no
// persistence behind (Amendment A5: chat history is client-state only). Disabled
// in production, mirroring the other dev inspection routes.
export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const sqlite = getRawDb();
  const rows = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    )
    .all() as Array<{ name: string }>;
  return NextResponse.json({ tables: rows.map((r) => r.name) });
}
