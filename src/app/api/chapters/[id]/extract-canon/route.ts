import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";
import { getChapter } from "@/lib/repo/chapters";
import { latestDraft } from "@/lib/repo/drafts";
import { assemblableCanon } from "@/lib/repo/canon";
import { listCharacters } from "@/lib/repo/characters";
import { logLlmCall } from "@/lib/repo/llm";
import { getLlmClient } from "@/lib/llm/client";
import { extractionPrompt } from "@/lib/llm/prompts";
import { parseExtractionResponse } from "@/lib/llm/extraction";

// Runs canon extraction on a chapter's final text (SPEC section 6 + Amendment A1).
// UTILITY_MODEL (purpose "extraction") reads the text plus the current canon and
// proposes BOTH new-fact and character-state deltas. Proposals are returned to the
// client for the approval checklist; nothing is written here. A parse failure
// surfaces the raw text instead of dropping the response.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const db = getDb();
  const { id } = await ctx.params;
  const chapterId = Number(id);
  const chapter = getChapter(db, chapterId);
  if (!chapter) return NextResponse.json({ error: "not found" }, { status: 404 });

  const draft = latestDraft(db, chapterId);
  if (!draft) {
    return NextResponse.json(
      { error: "chapter has no draft to extract from" },
      { status: 400 },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    // Empty body allowed.
  }
  const fixtureKey =
    typeof body.fixtureKey === "string" ? body.fixtureKey : undefined;

  const currentCanon = assemblableCanon(db, {
    projectId: chapter.projectId,
  }).map((f) => `[${f.type}] ${f.content}`);
  const knownCharacters = listCharacters(db).map((c) => c.name);

  const client = getLlmClient();
  const model = process.env.UTILITY_MODEL ?? "claude-sonnet-4-6";
  const res = await client.complete({
    purpose: "extraction",
    model,
    prompt: extractionPrompt({
      chapterTitle: chapter.title ?? `Chapter ${chapter.orderIndex + 1}`,
      pov: chapter.pov ?? "omniscient",
      text: draft.content,
      currentCanon,
      knownCharacters,
    }),
    maxTokens: 2048,
    fixtureKey,
  });
  logLlmCall(db, {
    purpose: "extraction",
    chapterId,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  });

  const parsed = parseExtractionResponse(res.text);
  if (!parsed.ok) {
    return NextResponse.json(
      { ok: false, error: parsed.error, raw: parsed.raw },
      { status: 200 },
    );
  }
  return NextResponse.json({
    ok: true,
    facts: parsed.facts,
    states: parsed.states,
  });
}
