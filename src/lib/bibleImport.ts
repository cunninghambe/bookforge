// The series-bible import flow (Amendment A3). Splits the pasted bible into
// sequential chunks (paragraph boundaries), runs one call per chunk (purpose
// "bible", model resolved per purpose (A8), logged to llm_calls), parses each
// defensively, and merges the proposals from every chunk into one set. A chunk whose
// response fails to parse is kept as a parse failure with its raw text so the UI can
// surface it (SPEC: never silently drop a model response). Nothing is written here;
// the caller returns proposals for the approval checklist.
//
// Amendment A20: the single-chunk step is extracted as importBibleChunk, exactly as
// runScan delegates to scanChapter and runSweep to sweepChapter. runBibleImport
// keeps looping over it (so its behavior and the fixture path are unchanged), while
// the per-chunk HTTP endpoint calls the same step once per request, so no HTTP
// request ever spans more than one model call. The original all-in-one request died
// as a 500 after minutes on a real bible (D166).

import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema";
import { getLlmClient, type LlmClient } from "./llm/client";
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

// The context shared by every chunk so the model avoids duplicate proposals: the
// current locked canon and the tracked character names.
export interface BibleChunkContext {
  currentCanon: string[];
  knownCharacters: string[];
}

// One chunk's outcome. Proposals are empty on a failure. parseFailure is set only
// when this chunk's response failed to parse OR the model call itself failed (A2.2),
// surfacing its raw text (or error message) for the raw-text area; it is null on a
// clean chunk.
export interface BibleChunkOutcome {
  facts: BibleFactProposal[];
  characters: BibleCharacterProposal[];
  states: BibleStateProposal[];
  parseFailure: BibleChunkParseFailure | null;
}

export interface ImportBibleChunkInput {
  chunk: string;
  position: number; // 1-based chunk position (display + fixture routing)
  totalChunks: number; // for the single-chunk fixture-routing special case
  context: BibleChunkContext;
  model: string;
  fixtureKey?: string; // BASE key; the per-position key is derived here
}

// The shared dedup context every chunk's prompt carries. A16: scoped to the target
// series when known, so a multi-series database does not seed the model with another
// series' canon or roster. Rebuilt per request by the per-chunk endpoint (A20) and
// once per run by runBibleImport; both read the same series canon, so the prompt
// bytes match and provider-side prompt caching keeps working across a run.
export function bibleDedupContext(
  db: Db,
  seriesId?: number,
): BibleChunkContext {
  const currentCanon = listCanon(db, { status: "locked", seriesId }).map(
    (f) => `[${f.type}] ${f.content}`,
  );
  const knownCharacters = listCharacters(db, seriesId).map((c) => c.name);
  return { currentCanon, knownCharacters };
}

// The per-chunk fixture key: a single chunk uses the base key so the common
// short-bible case maps to a plain fixture; multiple chunks suffix the 1-based
// position. The real client ignores fixtureKey. Kept here so the rule lives in ONE
// place, shared by runBibleImport's loop and the per-chunk endpoint's client.
export function bibleChunkFixtureKey(
  base: string | undefined,
  position: number,
  totalChunks: number,
): string | undefined {
  if (!base) return undefined;
  return totalChunks === 1 ? base : `${base}.${position}`;
}

// Imports ONE chunk of the bible: builds the extraction prompt against the shared
// dedup context, makes the single model call (purpose "bible", logged), and parses
// the reply defensively. Exactly one model call per invocation, so an HTTP request
// wrapping this can never outlive one call (the A20 fix, mirroring scanChapter and
// sweepChapter). A thrown model-call error or a parse failure becomes this chunk's
// parseFailure (A2.2), never a throw, so a client-driven run carries it into the
// raw-text surface and continues to the remaining chunks.
export async function importBibleChunk(
  db: Db,
  client: LlmClient,
  input: ImportBibleChunkInput,
): Promise<BibleChunkOutcome> {
  const fixtureKey = bibleChunkFixtureKey(
    input.fixtureKey,
    input.position,
    input.totalChunks,
  );

  let res;
  try {
    res = await client.complete({
      purpose: "bible",
      model: input.model,
      prompt: bibleExtractionPrompt({
        text: input.chunk,
        currentCanon: input.context.currentCanon,
        knownCharacters: input.context.knownCharacters,
      }),
      maxTokens: 2048,
      fixtureKey,
    });
  } catch (err) {
    // A2.2: a per-chunk model-call failure surfaces its reason in the raw-text area
    // and does not abort the run (the client loop carries it and continues to the
    // remaining chunks).
    const message = err instanceof Error ? err.message : String(err);
    return {
      facts: [],
      characters: [],
      states: [],
      parseFailure: { chunk: input.position, error: message, raw: message },
    };
  }
  logLlmCall(db, {
    purpose: "bible",
    inputTokens: res.inputTokens,
    outputTokens: res.outputTokens,
    model: input.model,
  });

  const parsed = parseBibleResponse(res.text);
  if (!parsed.ok) {
    return {
      facts: [],
      characters: [],
      states: [],
      parseFailure: { chunk: input.position, error: parsed.error, raw: parsed.raw },
    };
  }
  return {
    facts: parsed.facts,
    characters: parsed.characters,
    states: parsed.states,
    parseFailure: null,
  };
}

// Runs the whole bible import sequentially, one call per chunk, merging every
// chunk's proposals into one set. Delegates each chunk to importBibleChunk, the
// shared engine the per-chunk endpoint also calls (A20), so this path and the
// client-driven flow exercise the same single-chunk step. The dedup context is built
// once here (identical to the context the per-chunk endpoint rebuilds per request).
export async function runBibleImport(
  db: Db,
  args: { text: string; fixtureKey?: string; seriesId?: number },
): Promise<BibleImportResult> {
  const chunks = chunkBible(args.text);
  const client = getLlmClient();
  const model = modelFor(db, "bible");
  const context = bibleDedupContext(db, args.seriesId);

  const facts: BibleFactProposal[] = [];
  const characters: BibleCharacterProposal[] = [];
  const states: BibleStateProposal[] = [];
  const parseFailures: BibleChunkParseFailure[] = [];

  let position = 0;
  for (const chunk of chunks) {
    position += 1;
    const outcome = await importBibleChunk(db, client, {
      chunk,
      position,
      totalChunks: chunks.length,
      context,
      model,
      fixtureKey: args.fixtureKey,
    });
    facts.push(...outcome.facts);
    characters.push(...outcome.characters);
    states.push(...outcome.states);
    if (outcome.parseFailure) parseFailures.push(outcome.parseFailure);
  }

  return { chunks: chunks.length, facts, characters, states, parseFailures };
}
