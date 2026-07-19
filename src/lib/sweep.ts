import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema";
import { assemblableCanon } from "./repo/canon";
import { listChapters } from "./repo/chapters";
import { latestDraft } from "./repo/drafts";
import { logLlmCall } from "./repo/llm";
import { sweepPrefix, sweepChapterPrompt } from "./llm/prompts";
import { parseSweepResponse, type Contradiction } from "./llm/extraction";
import type { LlmClient } from "./llm/client";
import { orderToUiChapter } from "./chapterNumbering";

type Db = BetterSQLite3Database<typeof schema>;

// One chapter's slice of the sweep report. A parse failure surfaces the raw model
// text instead of dropping the chapter (SPEC: parse defensively). A per-chapter LLM
// call failure surfaces its error message and does not abort the remaining chapters
// (Amendment A2.2).
export interface SweepChapterReport {
  chapterId: number;
  order: number; // 1-based chapter number in the book
  title: string;
  contradictions: Contradiction[];
  rawText: string | null; // set only when the response failed to parse
  parseError: string | null;
  error: string | null; // set only when the LLM call itself threw (A2.2)
}

export interface SweepReport {
  chapters: SweepChapterReport[];
  totalContradictions: number;
}

export interface SweepInput {
  projectId: number;
  fromOrder: number; // inclusive order_index range
  toOrder: number;
  fixtureKey?: string;
  model: string;
}

// Locked chapters in the book whose order_index falls in the range, in order.
// This is what the estimate (chapter count) is drawn from before running, and what
// the plan endpoint returns for the client-driven loop (A18).
export function sweepableChapters(
  db: Db,
  args: { projectId: number; fromOrder: number; toOrder: number },
) {
  return listChapters(db, args.projectId).filter(
    (c) =>
      c.status === "locked" &&
      c.orderIndex >= args.fromOrder &&
      c.orderIndex <= args.toOrder,
  );
}

// The A4.1 cacheable locked-canon prefix: identical for every chapter in a run, so
// it is the shared prompt prefix chapters 2..N read from the cache. Rebuilt per
// request by the per-chapter endpoint (A18) and once per run by runSweep; both
// produce byte-identical bytes because they call this same builder over the same
// series canon, so provider-side prompt caching keeps working across the run.
export function sweepCanonPrefix(db: Db, projectId: number): string {
  const lockedCanon = assemblableCanon(db, { projectId }).map((f) => f.content);
  return sweepPrefix(lockedCanon);
}

export interface SweepChapterInput {
  chapterId: number;
  projectId: number;
  // The A4.1 locked-canon prefix (from sweepCanonPrefix), passed in so both callers
  // send the identical shared prefix and the provider cache hits across a run.
  prefix: string;
  fixtureKey?: string;
  model: string;
}

// Sweeps ONE locked chapter: builds the remainder prompt, makes the single LLM
// call against the shared canon prefix, logs it, and parses the reply. Exactly one
// model call per invocation, so an HTTP request wrapping this can never outlive one
// call (the A18 502 fix, mirroring scanChapter). A thrown LLM error or a parse
// failure becomes the report's error fields (A2.2), never a throw; a missing or
// non-locked chapter is a request-level error and throws (the caller surfaces the
// reason).
export async function sweepChapter(
  db: Db,
  client: LlmClient,
  input: SweepChapterInput,
): Promise<SweepChapterReport> {
  const chapter = listChapters(db, input.projectId).find(
    (c) => c.id === input.chapterId,
  );
  if (!chapter || chapter.status !== "locked") {
    throw new Error(
      `chapter ${input.chapterId} is not a locked chapter of this book`,
    );
  }
  const draft = latestDraft(db, chapter.id);
  const text = draft?.content ?? "";
  const number = orderToUiChapter(chapter.orderIndex);
  const title = chapter.title ?? `Chapter ${number}`;

  const prompt = sweepChapterPrompt({
    chapterNumber: number,
    chapterTitle: title,
    text,
  });

  // A2.2: a per-chapter LLM call failure becomes a report entry naming the chapter
  // and the error message, so a client-driven run can carry it as this chapter's
  // slice and continue to the remaining chapters rather than aborting the run.
  let res;
  try {
    res = await client.complete({
      purpose: "sweep",
      model: input.model,
      promptPrefix: input.prefix,
      prompt,
      maxTokens: 2048,
      fixtureKey: input.fixtureKey,
    });
  } catch (err) {
    return {
      chapterId: chapter.id,
      order: number,
      title,
      contradictions: [],
      rawText: null,
      parseError: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  logLlmCall(db, {
    purpose: "sweep",
    chapterId: chapter.id,
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    cacheReadTokens: res.cacheReadTokens,
    cacheWriteTokens: res.cacheWriteTokens,
    model: input.model,
  });

  const parsed = parseSweepResponse(res.text);
  if (parsed.ok) {
    return {
      chapterId: chapter.id,
      order: number,
      title,
      contradictions: parsed.contradictions,
      rawText: null,
      parseError: null,
      error: null,
    };
  }
  return {
    chapterId: chapter.id,
    order: number,
    title,
    contradictions: [],
    rawText: parsed.raw,
    parseError: parsed.error,
    error: null,
  };
}

// Runs the consistency sweep sequentially, one LLM call per locked chapter in the
// range, aggregating contradictions. Delegates each chapter to sweepChapter, the
// shared engine the per-chapter endpoint also calls (A18), so every existing sweep
// test exercises the same single-chapter step. Every call is logged. Defensive
// parsing keeps an unparseable chapter in the report with its raw text. The
// in-process MCP sweep_book tool calls this over stdio (no HTTP hop), so the 502
// failure mode does not apply there and it is unchanged.
export async function runSweep(
  db: Db,
  client: LlmClient,
  input: SweepInput,
): Promise<SweepReport> {
  const chapters = sweepableChapters(db, input);
  // A4.1: the locked-canon block is identical for every chapter, so it is the
  // shared cacheable prefix; chapters 2..N of a run read it from the cache. Built
  // once here and passed to each sweepChapter call, byte-identical to the prefix
  // the per-chapter endpoint rebuilds per request.
  const prefix = sweepCanonPrefix(db, input.projectId);

  const reports: SweepChapterReport[] = [];
  let position = 0;
  for (const chapter of chapters) {
    position += 1;
    // Per-chapter fixture routing: base key plus the 1-based position in the swept
    // set, so each chapter can return a distinct fixture in tests. The real client
    // ignores fixtureKey (D25). The client-driven loop rebuilds this same suffix.
    const fixtureKey = input.fixtureKey
      ? `${input.fixtureKey}.${position}`
      : undefined;
    const report = await sweepChapter(db, client, {
      chapterId: chapter.id,
      projectId: input.projectId,
      prefix,
      fixtureKey,
      model: input.model,
    });
    reports.push(report);
  }

  const totalContradictions = reports.reduce(
    (n, r) => n + r.contradictions.length,
    0,
  );
  return { chapters: reports, totalContradictions };
}
