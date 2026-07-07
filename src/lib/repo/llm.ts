import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";

type Db = BetterSQLite3Database<typeof schema>;

// Records one LLM call for cost-drift visibility.
export function logLlmCall(
  db: Db,
  args: {
    purpose: string;
    chapterId?: number | null;
    inputTokens: number;
    outputTokens: number;
  },
): void {
  db.insert(schema.llmCalls)
    .values({
      purpose: args.purpose,
      chapterId: args.chapterId ?? null,
      inputTokens: Math.round(args.inputTokens),
      outputTokens: Math.round(args.outputTokens),
    })
    .run();
}
