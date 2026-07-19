// The series-bible import flow (Amendment A3). Splits the pasted bible into
// sequential chunks (paragraph boundaries, ~24,000 chars each), runs one call per
// chunk (purpose "bible", model resolved per purpose (A8), logged to llm_calls),
// parses each defensively, and merges the proposals from every chunk into one set.
// A chunk whose response fails to parse is kept as a parse failure with its raw text
// so the UI can surface it (SPEC: never silently drop a model response). Nothing is
// written here; the caller returns proposals for the approval checklist.

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema";
import { getLlmClient } from "./llm/client";
import { bibleExtractionPrompt } from "./llm/prompts";
import {
  parseBibleResponse,
  type BibleFactProposal,
  type BibleCharacterProposal,
  type BibleStateProposal,
} from "./llm/bible";
import { chunkBible } from "./bibleChunks";
import { logLlmCall } from "./repo/llm";
import { listCanon } from "./repo/canon";
import { listCharacters } from "./repo/characters";
import { modelFor } from "./modelFor";

type Db = BetterSQLite3Database<typeof schema>;

export interface BibleChunkParseFailure {
  chunk: number; // 1-based chunk position
  error: string;
  raw: string;
}

export interface BibleImportResult {
  chunks: number;
  facts: BibleFactProposal[];
  characters: BibleCharacterProposal[];
  states: BibleStateProposal[];
  parseFailures: BibleChunkParseFailure[];
}

export async function runBibleImport(
  db: Db,
  args: { text: string; fixtureKey?: string; seriesId?: number },
): Promise<BibleImportResult> {
  const chunks = chunkBible(args.text);
  const client = getLlmClient();
  const model = modelFor(db, "bible");

  // Context shared by every chunk so the model avoids duplicate proposals: the
  // current locked canon and the tracked character names. A16: scoped to the
  // target series when known, so a multi-series database does not seed the model
  // with another series' canon or roster.
  const currentCanon = listCanon(db, {
    status: "locked",
    seriesId: args.seriesId,
  }).map((f) => `[${f.type}] ${f.content}`);
  const knownCharacters = listCharacters(db, args.seriesId).map((c) => c.name);

  const facts: BibleFactProposal[] = [];
  const characters: BibleCharacterProposal[] = [];
  const states: BibleStateProposal[] = [];
  const parseFailures: BibleChunkParseFailure[] = [];

  let position = 0;
  for (const chunk of chunks) {
    position += 1;
    // Per-chunk fixture routing: a single chunk uses the base key so the common
    // short-bible case maps to a plain fixture; multiple chunks suffix the 1-based
    // position. The real client ignores fixtureKey.
    const fixtureKey = args.fixtureKey
      ? chunks.length === 1
        ? args.fixtureKey
        : `${args.fixtureKey}.${position}`
      : undefined;

    const res = await client.complete({
      purpose: "bible",
      model,
      prompt: bibleExtractionPrompt({ text: chunk, currentCanon, knownCharacters }),
      maxTokens: 2048,
      fixtureKey,
    });
    logLlmCall(db, {
      purpose: "bible",
      inputTokens: res.inputTokens,
      outputTokens: res.outputTokens,
      model,
    });

    const parsed = parseBibleResponse(res.text);
    if (!parsed.ok) {
      parseFailures.push({ chunk: position, error: parsed.error, raw: parsed.raw });
      continue;
    }
    facts.push(...parsed.facts);
    characters.push(...parsed.characters);
    states.push(...parsed.states);
  }

  return { chunks: chunks.length, facts, characters, states, parseFailures };
}
