import { eq } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema";
import { listChapters } from "./repo/chapters";
import { latestDraft } from "./repo/drafts";
import { logLlmCall } from "./repo/llm";
import { listThreads } from "./repo/threads";
import { scanThreadsPrompt } from "./llm/prompts";
import {
  parseExtractionResponse,
  accumulateScanProposals,
  type ScanChapterProposals,
  type ScanAttachGroup,
  type ScanNewGroup,
} from "./llm/extraction";
import type { LlmClient } from "./llm/client";
import { orderToUiChapter } from "./chapterNumbering";

// Amendment A17: the thread backfill scan. One extraction-purpose LLM call per
// LOCKED chapter, sequential, proposing thread touches the chapter (written before
// A12) never recorded. Nothing lands here: the whole run is merged into ONE
// approval checklist and the human approves it (POST .../scan/approve). This is
// the sweep loop's shape (per-chapter, sequential, A2.2 error carry-through, every
// call logged) applied to thread recovery instead of consistency checking.

type Db = BetterSQLite3Database<typeof schema>;

// The set of chapter ids in a book that already carry at least one thread touch.
// A default scan skips these (the settled chapters); an explicit rescan may
// include them.
export function touchedChapterIds(db: Db, projectId: number): Set<number> {
  const rows = db
    .select({ chapterId: schema.threadTouches.chapterId })
    .from(schema.threadTouches)
    .innerJoin(
      schema.chapters,
      eq(schema.threadTouches.chapterId, schema.chapters.id),
    )
    .where(eq(schema.chapters.projectId, projectId))
    .all();
  return new Set(rows.map((r) => r.chapterId));
}

export interface ScanTargetArgs {
  projectId: number;
  fromOrder: number; // inclusive order_index range
  toOrder: number;
  // When false (the default), chapters that already have thread touches are
  // skipped: the default range is the book's locked, touchless chapters. When
  // true, every locked chapter in range is scanned, so an explicit range can
  // revisit a chapter that already has touches (SPEC A17).
  includeTouched: boolean;
}

// The locked chapters the scan will run over: locked chapters in the order range,
// minus any that already have touches unless includeTouched is set. Unlocked
// chapters are never scanned (locked text is the settled record). This is what the
// estimate (chapter count) and the sequential loop are both drawn from.
export function scanTargets(db: Db, args: ScanTargetArgs) {
  const touched = args.includeTouched
    ? new Set<number>()
    : touchedChapterIds(db, args.projectId);
  return listChapters(db, args.projectId).filter(
    (c) =>
      c.status === "locked" &&
      c.orderIndex >= args.fromOrder &&
      c.orderIndex <= args.toOrder &&
      !touched.has(c.id),
  );
}

// One scanned chapter's outcome. A per-chapter LLM failure surfaces its message
// and does not abort the run (A2.2); a parse failure surfaces the raw text. A
// clean chapter that simply proposed nothing carries proposalCount 0 with no
// error, which the UI can distinguish.
export interface ScanChapterOutcome {
  chapterId: number;
  order: number; // 1-based chapter number
  title: string;
  proposalCount: number;
  rawText: string | null; // set only when the response failed to parse
  parseError: string | null;
  error: string | null; // set only when the LLM call itself threw (A2.2)
}

export interface ScanReport {
  chapters: ScanChapterOutcome[];
  // The merged, within-run-linked proposal groups for the ONE approval checklist.
  attaches: ScanAttachGroup[];
  news: ScanNewGroup[];
  scannedCount: number;
  failedCount: number;
}

export interface ScanInput {
  projectId: number;
  fromOrder: number;
  toOrder: number;
  includeTouched: boolean;
  fixtureKey?: string;
  model: string;
}

// Runs the backfill scan sequentially, one call per locked chapter in range, and
// merges the whole run into one grouped-by-thread proposal set. Every call is
// logged to llm_calls with the chapter id. The prompt for each chapter carries the
// book's open threads (attach targets) and the names proposed EARLIER IN THIS RUN,
// so a recurring line is linked instead of duplicated.
export async function runScan(
  db: Db,
  client: LlmClient,
  input: ScanInput,
): Promise<ScanReport> {
  const chapters = scanTargets(db, input);

  // The book's open threads (its own plus series-wide, per A16) are the attach
  // targets the prompt advertises and the merge normalizes against.
  const openThreads = listThreads(db, {
    projectId: input.projectId,
    status: "open",
  });
  const existing = openThreads.map((t) => ({ id: t.id, name: t.name }));
  const existingKeys = new Set(
    existing.map((e) => e.name.trim().toLowerCase()).filter((k) => k.length),
  );

  const outcomes: ScanChapterOutcome[] = [];
  const chapterProposals: ScanChapterProposals[] = [];
  // Names newly proposed so far this run, fed forward into later chapters' prompts
  // so the model reuses them (the merge dedupes regardless, but the nudge helps).
  const seenNewNames: string[] = [];
  const seenNewKeys = new Set<string>();

  let position = 0;
  for (const chapter of chapters) {
    position += 1;
    const draft = latestDraft(db, chapter.id);
    const text = draft?.content ?? "";
    const number = orderToUiChapter(chapter.orderIndex);
    const title = chapter.title ?? `Chapter ${number}`;

    const prompt = scanThreadsPrompt({
      chapterTitle: title,
      chapterNumber: number,
      text,
      summary: chapter.summary,
      openThreads: existing.map((e) => e.name),
      proposedThisRun: [...seenNewNames],
    });

    // Per-chapter fixture routing, exactly like the sweep loop: base key plus the
    // 1-based position in the scanned set, so each chapter can return a distinct
    // fixture in tests. The real client ignores fixtureKey.
    const fixtureKey = input.fixtureKey
      ? `${input.fixtureKey}.${position}`
      : undefined;

    // A2.2: a per-chapter LLM call failure becomes an outcome naming the chapter
    // and the error message; the loop continues to the remaining chapters.
    let res;
    try {
      res = await client.complete({
        purpose: "extraction",
        model: input.model,
        prompt,
        maxTokens: 2048,
        fixtureKey,
      });
    } catch (err) {
      outcomes.push({
        chapterId: chapter.id,
        order: number,
        title,
        proposalCount: 0,
        rawText: null,
        parseError: null,
        error: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    logLlmCall(db, {
      purpose: "extraction",
      chapterId: chapter.id,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      cacheReadTokens: res.cacheReadTokens,
      cacheWriteTokens: res.cacheWriteTokens,
      model: input.model,
    });

    const parsed = parseExtractionResponse(res.text);
    if (!parsed.ok) {
      outcomes.push({
        chapterId: chapter.id,
        order: number,
        title,
        proposalCount: 0,
        rawText: parsed.raw,
        parseError: parsed.error,
        error: null,
      });
      continue;
    }

    chapterProposals.push({
      chapterId: chapter.id,
      order: number,
      proposals: parsed.threads,
    });
    // Feed forward the newly proposed names (those matching neither an existing
    // thread nor an already-seen new name) for the next chapter's prompt.
    for (const p of parsed.threads) {
      const key = p.thread.trim().toLowerCase();
      if (!key || existingKeys.has(key) || seenNewKeys.has(key)) continue;
      seenNewKeys.add(key);
      seenNewNames.push(p.thread.trim());
    }
    outcomes.push({
      chapterId: chapter.id,
      order: number,
      title,
      proposalCount: parsed.threads.length,
      rawText: null,
      parseError: null,
      error: null,
    });
  }

  const { attaches, news } = accumulateScanProposals(chapterProposals, existing);
  const failedCount = outcomes.filter(
    (o) => o.error !== null || o.parseError !== null,
  ).length;
  return {
    chapters: outcomes,
    attaches,
    news,
    scannedCount: outcomes.length,
    failedCount,
  };
}
