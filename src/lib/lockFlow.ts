// The lock-time summary + canon extraction flow (SPEC section 6 + Amendment A1).
// Extracted here so it has exactly one implementation, used by three callers:
// POST /api/chapters/[id]/lock, POST /api/chapters/[id]/extract-canon, and the
// backfill importer (POST /api/projects/[id]/import, SPEC section 7). The
// importer must run this identical flow, not a second copy of it.

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema";
import { getLlmClient } from "./llm/client";
import { summaryPrompt, extractionPrompt } from "./llm/prompts";
import {
  parseExtractionResponse,
  normalizeThreadProposals,
  type FactProposal,
  type StateProposal,
  type ThreadAttachProposal,
  type ThreadNewProposal,
} from "./llm/extraction";
import { logLlmCall } from "./repo/llm";
import { assemblableCanon } from "./repo/canon";
import { listCharacters } from "./repo/characters";
import { updateChapter, type Chapter } from "./repo/chapters";
import { getProject } from "./repo/projects";
import { listThreads } from "./repo/threads";
import { orderToUiChapter } from "./chapterNumbering";
import { modelFor } from "./modelFor";

type Db = BetterSQLite3Database<typeof schema>;

// The lock-time extraction result, with the raw thread proposals already
// normalized (A12) against the book's existing open threads into attach vs
// new-thread proposals for the approval checklist. Facts and states are unchanged
// from parseExtractionResponse. A parse failure surfaces the raw text.
export type CanonExtractionResult =
  | {
      ok: true;
      facts: FactProposal[];
      states: StateProposal[];
      threadAttaches: ThreadAttachProposal[];
      threadNews: ThreadNewProposal[];
    }
  | { ok: false; error: string; raw: string };

// Generates and stores the chapter summary (purpose "summary", ~150 words,
// factual, present tense), then sets the chapter to 'locked'. The model is resolved
// per purpose (A8).
export async function generateAndStoreSummary(
  db: Db,
  chapter: Chapter,
  text: string,
  fixtureKey?: string,
): Promise<{ chapter: Chapter | undefined; summary: string }> {
  const client = getLlmClient();
  const model = modelFor(db, "summary");
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
    model,
  });
  const summary = res.text.trim();
  const updated = updateChapter(db, chapter.id, { summary, status: "locked" });
  return { chapter: updated, summary };
}

// Runs canon extraction on a chapter's final text: purpose "extraction" reads the
// text plus the current canon and proposes BOTH new-fact and character-state deltas
// (Amendment A1) in one JSON object. The model is resolved per purpose (A8).
// Nothing is written here; the caller renders proposals for the approval checklist.
export async function runCanonExtraction(
  db: Db,
  chapter: Chapter,
  text: string,
  fixtureKey?: string,
): Promise<CanonExtractionResult> {
  const currentCanon = assemblableCanon(db, { projectId: chapter.projectId }).map(
    (f) => `[${f.type}] ${f.content}`,
  );
  // A16: the extraction character map is the book's series' characters only.
  const seriesId = getProject(db, chapter.projectId)?.seriesId ?? undefined;
  const knownCharacters = listCharacters(db, seriesId).map((c) => c.name);
  // A12: the book's open threads (its own plus series-wide) named in the prompt so
  // the model attaches over duplicating; the same set drives attach-vs-new
  // normalization below.
  const openThreads = listThreads(db, {
    projectId: chapter.projectId,
    status: "open",
  });

  const client = getLlmClient();
  const model = modelFor(db, "extraction");
  const res = await client.complete({
    purpose: "extraction",
    model,
    prompt: extractionPrompt({
      chapterTitle: chapter.title ?? `Chapter ${orderToUiChapter(chapter.orderIndex)}`,
      pov: chapter.pov ?? "omniscient",
      text,
      currentCanon,
      knownCharacters,
      openThreads: openThreads.map((t) => t.name),
    }),
    maxTokens: 2048,
    fixtureKey,
  });
  logLlmCall(db, {
    purpose: "extraction",
    chapterId: chapter.id,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    model,
  });

  const parsed = parseExtractionResponse(res.text);
  if (!parsed.ok) return parsed;
  const { attaches, news } = normalizeThreadProposals(
    parsed.threads,
    openThreads.map((t) => ({ id: t.id, name: t.name })),
  );
  return {
    ok: true,
    facts: parsed.facts,
    states: parsed.states,
    threadAttaches: attaches,
    threadNews: news,
  };
}
