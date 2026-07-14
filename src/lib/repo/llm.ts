import { desc } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";

type Db = BetterSQLite3Database<typeof schema>;

// Records one LLM call for cost-drift visibility. cacheReadTokens /
// cacheWriteTokens (A4.1) are logged when the provider reported them. model (A8) is
// the resolved model that served the call, so per-purpose routing is visible here.
export function logLlmCall(
  db: Db,
  args: {
    purpose: string;
    chapterId?: number | null;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number | null;
    cacheWriteTokens?: number | null;
    model?: string | null;
  },
): void {
  db.insert(schema.llmCalls)
    .values({
      purpose: args.purpose,
      chapterId: args.chapterId ?? null,
      inputTokens: Math.round(args.inputTokens),
      outputTokens: Math.round(args.outputTokens),
      cacheReadTokens:
        args.cacheReadTokens == null ? null : Math.round(args.cacheReadTokens),
      cacheWriteTokens:
        args.cacheWriteTokens == null
          ? null
          : Math.round(args.cacheWriteTokens),
      model: args.model ?? null,
    })
    .run();
}

export type LlmCallRow = typeof schema.llmCalls.$inferSelect;

// Recent llm_calls, most recent first, optionally filtered by chapter and/or
// purpose. Used by the dev readback route to inspect logged token counts.
export function recentLlmCalls(
  db: Db,
  args: { chapterId?: number; purpose?: string; limit?: number } = {},
): LlmCallRow[] {
  const rows = db
    .select()
    .from(schema.llmCalls)
    .orderBy(desc(schema.llmCalls.id))
    .all();
  return rows
    .filter((r) => (args.chapterId == null ? true : r.chapterId === args.chapterId))
    .filter((r) => (args.purpose == null ? true : r.purpose === args.purpose))
    .slice(0, args.limit ?? 50);
}
