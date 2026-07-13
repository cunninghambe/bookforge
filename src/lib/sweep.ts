import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema";
import { assemblableCanon } from "./repo/canon";
import { listChapters } from "./repo/chapters";
import { latestDraft } from "./repo/drafts";
import { logLlmCall } from "./repo/llm";
import { sweepPrompt } from "./llm/prompts";
import { parseSweepResponse, type Contradiction } from "./llm/extraction";
import type { LlmClient } from "./llm/client";

type Db = BetterSQLite3Database<typeof schema>;

// One chapter's slice of the sweep report. A parse failure surfaces the raw model
// text instead of dropping the chapter (SPEC: parse defensively).
export interface SweepChapterReport {
  chapterId: number;
  order: number; // 1-based chapter number in the book
  title: string;
  contradictions: Contradiction[];
  rawText: string | null; // set only when the response failed to parse
  parseError: string | null;
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
// This is what the estimate (chapter count) is drawn from before running.
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

// Runs the consistency sweep sequentially, one LLM call per locked chapter in the
// range, aggregating contradictions. Every call is logged. Defensive parsing keeps
// an unparseable chapter in the report with its raw text.
export async function runSweep(
  db: Db,
  client: LlmClient,
  input: SweepInput,
): Promise<SweepReport> {
  const chapters = sweepableChapters(db, input);
  const lockedCanon = assemblableCanon(db, { projectId: input.projectId }).map(
    (f) => f.content,
  );

  const reports: SweepChapterReport[] = [];
  let position = 0;
  for (const chapter of chapters) {
    position += 1;
    const draft = latestDraft(db, chapter.id);
    const text = draft?.content ?? "";
    const number = chapter.orderIndex + 1;
    const title = chapter.title ?? `Chapter ${number}`;

    const prompt = sweepPrompt({
      chapterNumber: number,
      chapterTitle: title,
      text,
      lockedCanon,
    });
    // Per-chapter fixture routing: base key plus the 1-based position in the swept
    // set, so each chapter can return a distinct fixture in tests. The real client
    // ignores fixtureKey (D25).
    const fixtureKey = input.fixtureKey
      ? `${input.fixtureKey}.${position}`
      : undefined;

    const res = await client.complete({
      purpose: "sweep",
      model: input.model,
      prompt,
      maxTokens: 2048,
      fixtureKey,
    });
    logLlmCall(db, {
      purpose: "sweep",
      chapterId: chapter.id,
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
    });

    const parsed = parseSweepResponse(res.text);
    if (parsed.ok) {
      reports.push({
        chapterId: chapter.id,
        order: number,
        title,
        contradictions: parsed.contradictions,
        rawText: null,
        parseError: null,
      });
    } else {
      reports.push({
        chapterId: chapter.id,
        order: number,
        title,
        contradictions: [],
        rawText: parsed.raw,
        parseError: parsed.error,
      });
    }
  }

  const totalContradictions = reports.reduce(
    (n, r) => n + r.contradictions.length,
    0,
  );
  return { chapters: reports, totalContradictions };
}
