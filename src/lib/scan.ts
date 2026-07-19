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

// The book's open-thread attach targets (own plus series-wide, per A16), in the
// shape both the prompt and the merge consume.
export function scanAttachTargets(
  db: Db,
  projectId: number,
): Array<{ id: number; name: string }> {
  return listThreads(db, { projectId, status: "open" }).map((t) => ({
    id: t.id,
    name: t.name,
  }));
}

// The names newly proposed by the chapters scanned SO FAR this run (matching
// neither an existing thread nor an earlier proposal), fed into the next
// chapter's prompt so the model reuses them instead of coining variants. Derived
// from the raw per-chapter history so a client-driven run (one HTTP request per
// chapter, the 502 fix) reconstructs it statelessly on every request.
export function deriveProposedNames(
  prior: ScanChapterProposals[],
  existing: Array<{ id: number; name: string }>,
): string[] {
  const existingKeys = new Set(
    existing.map((e) => e.name.trim().toLowerCase()).filter((k) => k.length),
  );
  const seen = new Set<string>();
  const names: string[] = [];
  for (const chapter of prior) {
    for (const p of chapter.proposals) {
      const key = p.thread.trim().toLowerCase();
      if (!key || existingKeys.has(key) || seen.has(key)) continue;
      seen.add(key);
      names.push(p.thread.trim());
    }
  }
  return names;
}

export interface ScanChapterInput {
  chapterId: number;
  projectId: number;
  fixtureKey?: string;
  model: string;
  existing: Array<{ id: number; name: string }>;
  proposedThisRun: string[];
}

export interface ScanChapterResult {
  outcome: ScanChapterOutcome;
  proposals: ScanChapterProposals | null;
}

// Scans ONE locked chapter: builds the prompt, makes the single LLM call, logs
// it, and parses the reply. Exactly one model call per invocation, so an HTTP
// request wrapping this can never outlive one call (the A17 502 fix). A thrown
// LLM error or parse failure becomes the outcome's error fields (A2.2), never a
// throw.
export async function scanChapter(
  db: Db,
  client: LlmClient,
  input: ScanChapterInput,
): Promise<ScanChapterResult> {
  const chapter = listChapters(db, input.projectId).find(
    (c) => c.id === input.chapterId,
  );
  if (!chapter || chapter.status !== "locked") {
    throw new Error(`chapter ${input.chapterId} is not a locked chapter of this book`);
  }
  const draft = latestDraft(db, chapter.id);
  const text = draft?.content ?? "";
  const number = orderToUiChapter(chapter.orderIndex);
  const title = chapter.title ?? `Chapter ${number}`;

  const prompt = scanThreadsPrompt({
    chapterTitle: title,
    chapterNumber: number,
    text,
    summary: chapter.summary,
    openThreads: input.existing.map((e) => e.name),
    proposedThisRun: input.proposedThisRun,
  });

  let res;
  try {
    res = await client.complete({
      purpose: "extraction",
      model: input.model,
      prompt,
      maxTokens: 2048,
      fixtureKey: input.fixtureKey,
    });
  } catch (err) {
    return {
      outcome: {
        chapterId: chapter.id,
        order: number,
        title,
        proposalCount: 0,
        rawText: null,
        parseError: null,
        error: err instanceof Error ? err.message : String(err),
      },
      proposals: null,
    };
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
    return {
      outcome: {
        chapterId: chapter.id,
        order: number,
        title,
        proposalCount: 0,
        rawText: parsed.raw,
        parseError: parsed.error,
        error: null,
      },
      proposals: null,
    };
  }
  return {
    outcome: {
      chapterId: chapter.id,
      order: number,
      title,
      proposalCount: parsed.threads.length,
      rawText: null,
      parseError: null,
      error: null,
    },
    proposals: {
      chapterId: chapter.id,
      order: number,
      proposals: parsed.threads,
    },
  };
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
  const existing = scanAttachTargets(db, input.projectId);

  const outcomes: ScanChapterOutcome[] = [];
  const chapterProposals: ScanChapterProposals[] = [];

  let position = 0;
  for (const chapter of chapters) {
    position += 1;
    // Per-chapter fixture routing, exactly like the sweep loop: base key plus the
    // 1-based position in the scanned set. The real client ignores fixtureKey.
    const fixtureKey = input.fixtureKey
      ? `${input.fixtureKey}.${position}`
      : undefined;
    const { outcome, proposals } = await scanChapter(db, client, {
      chapterId: chapter.id,
      projectId: input.projectId,
      fixtureKey,
      model: input.model,
      existing,
      proposedThisRun: deriveProposedNames(chapterProposals, existing),
    });
    outcomes.push(outcome);
    if (proposals) chapterProposals.push(proposals);
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
