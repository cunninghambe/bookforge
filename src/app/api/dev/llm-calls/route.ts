import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { recentLlmCalls } from "@/lib/repo/llm";

// Dev-only readback of logged llm_calls rows, for inspecting per-call token counts
// (including A4.1 cache usage and A4.2 patch-mode output tokens). Disabled in
// production, mirroring the dev prompt route.
export async function GET(req: Request) {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const db = getDb();
  const url = new URL(req.url);
  const chapterParam = url.searchParams.get("chapterId");
  const purpose = url.searchParams.get("purpose") ?? undefined;
  const chapterId = chapterParam ? Number(chapterParam) : undefined;
  const calls = recentLlmCalls(db, {
    chapterId: Number.isFinite(chapterId) ? chapterId : undefined,
    purpose,
  });
  return NextResponse.json({ calls });
}
