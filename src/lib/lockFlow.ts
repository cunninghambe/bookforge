// The lock-time summary + canon extraction flow (SPEC section 6 + Amendment A1).
// Extracted here so it has exactly one implementation, used by three callers:
// POST /api/chapters/[id]/lock, POST /api/chapters/[id]/extract-canon, and the
// backfill importer (POST /api/projects/[id]/import, SPEC section 7). The
// importer must run this identical flow, not a second copy of it.

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema";
import { getLlmClient } from "./llm/client";
import { summaryPrompt, extractionPrompt } from "./llm/prompts";
import { parseExtractionResponse, type ExtractionResult } from "./llm/extraction";
import { logLlmCall } from "./repo/llm";
import { assemblableCanon } from "./repo/canon";
import { listCharacters } from "./repo/characters";
import { updateChapter, type Chapter } from "./repo/chapters";
import { orderToUiChapter } from "./chapterNumbering";

type Db = BetterSQLite3Database<typeof schema>;

// Generates and stores the chapter summary (UTILITY_MODEL, purpose "summary",
// ~150 words, factual, present tense), then sets the chapter to 'locked'.
export async function generateAndStoreSummary(
  db: Db,
  chapter: Chapter,
  text: string,
  fixtureKey?: string,
): Promise<{ chapter: Chapter | undefined; summary: string }> {
  const client = getLlmClient();
  const model = process.env.UTILITY_MODEL ?? "claude-sonnet-4-6";
  const res = await client.complete({
    purpose: "summary",
    model,
    prompt: summaryPrompt({
      chapterTitle: chapter.title ?? `Chapter ${orderToUiChapter(chapter.orderIndex)}`,
      pov: chapter.pov ?? "omniscient",
      text,
    }),
    maxTokens: 512,
    fixtureKey,
  });
  logLlmCall(db, {
    purpose: "summary",
    chapterId: chapter.id,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  });
  const summary = res.text.trim();
  const updated = updateChapter(db, chapter.id, { summary, status: "locked" });
  return { chapter: updated, summary };
}

// Runs canon extraction on a chapter's final text: UTILITY_MODEL (purpose
// "extraction") reads the text plus the current canon and proposes BOTH new-fact
// and character-state deltas (Amendment A1) in one JSON object. Nothing is
// written here; the caller renders proposals for the approval checklist.
export async function runCanonExtraction(
  db: Db,
  chapter: Chapter,
  text: string,
  fixtureKey?: string,
): Promise<ExtractionResult> {
  const currentCanon = assemblableCanon(db, { projectId: chapter.projectId }).map(
    (f) => `[${f.type}] ${f.content}`,
  );
  const knownCharacters = listCharacters(db).map((c) => c.name);

  const client = getLlmClient();
  const model = process.env.UTILITY_MODEL ?? "claude-sonnet-4-6";
  const res = await client.complete({
    purpose: "extraction",
    model,
    prompt: extractionPrompt({
      chapterTitle: chapter.title ?? `Chapter ${orderToUiChapter(chapter.orderIndex)}`,
      pov: chapter.pov ?? "omniscient",
      text,
      currentCanon,
      knownCharacters,
    }),
    maxTokens: 2048,
    fixtureKey,
  });
  logLlmCall(db, {
    purpose: "extraction",
    chapterId: chapter.id,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
  });

  return parseExtractionResponse(res.text);
}
