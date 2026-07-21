import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import {
  importBibleChunk,
  runBibleImport,
  bibleChunkFixtureKey,
  bibleDedupContext,
} from "@/lib/bibleImport";
import { __setLlmClient } from "@/lib/llm/client";
import type {
  LlmClient,
  CompleteOptions,
  CompleteResult,
} from "@/lib/llm/client";
import { createCanon } from "@/lib/repo/canon";
import { createCharacter } from "@/lib/repo/characters";
import { POST as biblePlanPOST } from "@/app/api/bible/import/route";

// A20: the bible importer is restructured to one model call per HTTP request. These
// pin the extracted single-chunk step (importBibleChunk, the engine the per-chunk
// endpoint and runBibleImport both call, exactly as scanChapter / sweepChapter), the
// fixture-routing rule, the rebuilt dedup context, and the plan endpoint's split.

// A stub client whose complete() returns a scripted response per call, so the
// single-chunk step can be tested without the network.
function scriptedClient(responses: string[]): LlmClient {
  let i = 0;
  return {
    async complete(_opts: CompleteOptions): Promise<CompleteResult> {
      const text = responses[i] ?? "{}";
      i += 1;
      return { text, inputTokens: 10, outputTokens: 5 };
    },
    async *stream() {
      return { text: "", inputTokens: 0, outputTokens: 0 };
    },
  };
}

const emptyContext = { currentCanon: [], knownCharacters: [] };

const oneOfEach = JSON.stringify({
  facts: [{ type: "world_rule", content: "Tideglass rings near a lie." }],
  characters: [
    {
      name: "Wrenlow",
      role: "ledger-keeper",
      voice_rules: "clips every sentence",
      physical: "",
      notes: "",
    },
  ],
  states: [
    { character: "Wrenlow", knows: "", feels: "", hiding: "forged the ledger" },
  ],
});

describe("importBibleChunk: the extracted single-chunk step (A20)", () => {
  it("returns one chunk's parsed proposals", async () => {
    const { db } = testDb();
    const outcome = await importBibleChunk(db, scriptedClient([oneOfEach]), {
      chunk: "some bible text",
      position: 1,
      totalChunks: 1,
      context: emptyContext,
      model: "test-model",
    });
    expect(outcome.parseFailure).toBeNull();
    expect(outcome.facts).toHaveLength(1);
    expect(outcome.facts[0].type).toBe("world_rule");
    expect(outcome.characters[0].name).toBe("Wrenlow");
    expect(outcome.characters[0].voiceRules).toBe("clips every sentence");
    expect(outcome.states[0].hiding).toBe("forged the ledger");
  });

  it("surfaces a parse failure as raw text without throwing, stamping the position", async () => {
    const { db } = testDb();
    const outcome = await importBibleChunk(
      db,
      scriptedClient(["the model wrote prose instead of JSON"]),
      {
        chunk: "text",
        position: 2,
        totalChunks: 3,
        context: emptyContext,
        model: "test-model",
      },
    );
    expect(outcome.parseFailure).not.toBeNull();
    expect(outcome.parseFailure?.chunk).toBe(2);
    expect(outcome.parseFailure?.raw).toBe(
      "the model wrote prose instead of JSON",
    );
    expect(outcome.facts).toHaveLength(0);
    expect(outcome.characters).toHaveLength(0);
    expect(outcome.states).toHaveLength(0);
  });

  it("turns a thrown model call into a chunk parseFailure, never a throw (A2.2)", async () => {
    const { db } = testDb();
    const client: LlmClient = {
      async complete(): Promise<CompleteResult> {
        throw new Error("boom: model unavailable");
      },
      async *stream() {
        return { text: "", inputTokens: 0, outputTokens: 0 };
      },
    };
    const outcome = await importBibleChunk(db, client, {
      chunk: "text",
      position: 5,
      totalChunks: 9,
      context: emptyContext,
      model: "test-model",
    });
    expect(outcome.parseFailure?.chunk).toBe(5);
    expect(outcome.parseFailure?.error).toBe("boom: model unavailable");
    expect(outcome.facts).toHaveLength(0);
  });

  it("derives the per-position fixture key and passes it to the client", async () => {
    const { db } = testDb();
    let seen: string | undefined = "UNSET";
    const client: LlmClient = {
      async complete(opts: CompleteOptions): Promise<CompleteResult> {
        seen = opts.fixtureKey;
        return { text: "{}", inputTokens: 1, outputTokens: 1 };
      },
      async *stream() {
        return { text: "", inputTokens: 0, outputTokens: 0 };
      },
    };
    // Multiple chunks suffix the 1-based position.
    await importBibleChunk(db, client, {
      chunk: "t",
      position: 2,
      totalChunks: 4,
      context: emptyContext,
      model: "m",
      fixtureKey: "bibleX",
    });
    expect(seen).toBe("bibleX.2");
    // A single chunk uses the base key so the common short-bible case maps to a
    // plain fixture (this is what keeps the a3 e2e's bible.bible1.json in play).
    await importBibleChunk(db, client, {
      chunk: "t",
      position: 1,
      totalChunks: 1,
      context: emptyContext,
      model: "m",
      fixtureKey: "bibleX",
    });
    expect(seen).toBe("bibleX");
  });
});

describe("bibleChunkFixtureKey (A20)", () => {
  it("is undefined with no base key (the real client ignores fixtureKey)", () => {
    expect(bibleChunkFixtureKey(undefined, 1, 1)).toBeUndefined();
  });
  it("uses the base key for a single chunk, and suffixes the position otherwise", () => {
    expect(bibleChunkFixtureKey("bible1", 1, 1)).toBe("bible1");
    expect(bibleChunkFixtureKey("bible1", 3, 6)).toBe("bible1.3");
  });
});

describe("bibleDedupContext: rebuilt per request, series-scoped (A16/A20)", () => {
  it("formats locked canon as [type] content and lists tracked characters", () => {
    const { db } = testDb();
    createCanon(db, {
      projectId: 1,
      type: "world_rule",
      content: "Magic is borrowed and must be repaid.",
      status: "locked",
    });
    createCharacter(db, { seriesId: 1, name: "Sethra" });
    const ctx = bibleDedupContext(db, 1);
    expect(
      ctx.currentCanon.some(
        (c) => c === "[world_rule] Magic is borrowed and must be repaid.",
      ),
    ).toBe(true);
    expect(ctx.knownCharacters).toContain("Sethra");
  });
});

describe("runBibleImport aggregation, delegating to importBibleChunk (A20)", () => {
  it("aggregates proposals across chunks and surfaces a per-chunk parse failure", async () => {
    const { db } = testDb();
    const good = JSON.stringify({
      facts: [{ type: "world_rule", content: "Fact one." }],
      characters: [],
      states: [],
    });
    __setLlmClient(scriptedClient([good, "not json at all"]));
    try {
      // Two ~1,500-char paragraphs exceed the 2,000-char cap together, so this is a
      // two-chunk import (one good, one unparseable).
      const p1 = "A".repeat(1500);
      const p2 = "B".repeat(1500);
      const result = await runBibleImport(db, { text: `${p1}\n\n${p2}` });
      expect(result.chunks).toBe(2);
      expect(result.facts).toHaveLength(1);
      expect(result.facts[0].content).toBe("Fact one.");
      expect(result.parseFailures).toHaveLength(1);
      expect(result.parseFailures[0].chunk).toBe(2);
      expect(result.parseFailures[0].raw).toBe("not json at all");
    } finally {
      __setLlmClient(null);
    }
  });
});

describe("bible import PLAN endpoint (A20)", () => {
  it("splits the text into chunks and returns their texts and count (no model call)", async () => {
    const p1 = "A".repeat(1500);
    const p2 = "B".repeat(1500);
    const res = await biblePlanPOST(
      new Request("http://t/api/bible/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: `${p1}\n\n${p2}`, scope: "series" }),
      }),
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as { count: number; chunks: string[] };
    expect(data.count).toBe(2);
    expect(data.chunks).toHaveLength(2);
    expect(data.chunks[0]).toBe(p1);
    expect(data.chunks[1]).toBe(p2);
  });

  it("rejects empty text with 400", async () => {
    const res = await biblePlanPOST(
      new Request("http://t/api/bible/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "   " }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("400s on a malformed body", async () => {
    const res = await biblePlanPOST(
      new Request("http://t/api/bible/import", { method: "POST", body: "nope" }),
    );
    expect(res.status).toBe(400);
  });
});
