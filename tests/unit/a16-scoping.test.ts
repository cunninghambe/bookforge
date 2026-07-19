import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import { assemblePrompt } from "@/lib/assembler";
import {
  assemblableCanon,
  createCanon,
  listCanon,
} from "@/lib/repo/canon";
import {
  createCharacter,
  listCharacters,
  findCharacterByName,
} from "@/lib/repo/characters";
import { createChapter, updateChapter } from "@/lib/repo/chapters";
import { createDraftVersion } from "@/lib/repo/drafts";
import { createThread, listThreads } from "@/lib/repo/threads";
import { createSeries, firstSeriesId } from "@/lib/repo/series";
import {
  firstProjectOfSeries,
  createProject,
  updateProjectTitle,
} from "@/lib/repo/projects";
import { buildChatContext } from "@/lib/chat";
import { runSweep } from "@/lib/sweep";
import { searchIndex } from "@/lib/search";
import type { LlmClient, CompleteOptions, CompleteResult } from "@/lib/llm/client";

// Amendment A16: every scoping seam proves cross-series isolation. Two series (A =
// the seeded trilogy, series 1; B = a new series) each own a series-wide canon
// fact, a character, and a series-wide thread. Nothing of one series may leak into
// the other's surfaces.

function twoSeries() {
  const { db } = testDb();
  const seriesAId = firstSeriesId(db)!; // 1, "The Trilogy"
  const bookA = 1; // Book 1 of the trilogy

  // Series A content.
  createCharacter(db, { name: "Aster", seriesId: seriesAId, role: "A-lead" });
  createCanon(db, {
    type: "world_rule",
    content: "ALPHAWORLD rule of series A.",
    status: "locked",
    projectId: null,
    seriesId: seriesAId,
  });
  createThread(db, {
    projectId: null,
    seriesId: seriesAId,
    name: "ALPHA thread",
    type: "arc",
  });

  // Series B content, created through the real creation path.
  const { series: seriesB, firstBook: bookB } = createSeries(db, {
    title: "Series B",
  });
  createCharacter(db, { name: "Bram", seriesId: seriesB.id, role: "B-lead" });
  createCanon(db, {
    type: "world_rule",
    content: "BETAWORLD rule of series B.",
    status: "locked",
    projectId: null,
    seriesId: seriesB.id,
  });
  createThread(db, {
    projectId: null,
    seriesId: seriesB.id,
    name: "BETA thread",
    type: "arc",
  });
  // A chapter in book B that names Bram so he appears.
  const chB = createChapter(db, {
    projectId: bookB.id,
    title: "B one",
    pov: "Bram",
    synopsis: "Bram acts.",
    beats: ["Bram does a thing"],
  });

  return { db, seriesAId, bookA, seriesB, bookB, chB };
}

describe("A16 seam: assemblableCanon (used by assembler, chat, sweep, extraction, interrogation)", () => {
  it("scopes series-wide canon to the book's own series", () => {
    const { db, bookA, bookB } = twoSeries();
    const forB = assemblableCanon(db, { projectId: bookB.id }).map((f) => f.content);
    expect(forB.some((c) => c.includes("BETAWORLD"))).toBe(true);
    expect(forB.some((c) => c.includes("ALPHAWORLD"))).toBe(false);

    const forA = assemblableCanon(db, { projectId: bookA }).map((f) => f.content);
    expect(forA.some((c) => c.includes("ALPHAWORLD"))).toBe(true);
    expect(forA.some((c) => c.includes("BETAWORLD"))).toBe(false);
  });
});

describe("A16 seam: assembler (assemblePrompt)", () => {
  it("a new series' book prompt contains its own canon/characters and none of the other series'", () => {
    const { db, chB } = twoSeries();
    const a = assemblePrompt(db, { chapterId: chB.id, targetBeatIndices: [0] });
    expect(a.prompt).toContain("BETAWORLD");
    expect(a.prompt).not.toContain("ALPHAWORLD");
    // Bram appears (POV); Aster (series A) never appears in a series B chapter.
    expect(a.appearingCharacters).toContain("Bram");
    expect(a.prompt).not.toContain("Aster");
    // The copied style rules still drive the system prompt.
    expect(a.system).toContain("Never use em-dashes");
  });

  it("STORY SO FAR lists only prior books of the same series", () => {
    const { db, seriesB, bookB } = twoSeries();
    // Rename the series' first book to a distinctive title so a prior-book leak is
    // unambiguous (a fresh series' first book defaults to "Book 1", which the
    // trilogy also uses).
    updateProjectTitle(db, bookB.id, "Bravo One");
    const bookB2 = createProject(db, { title: "Bravo Two", seriesId: seriesB.id });
    // Lock a chapter in book B so it is a real prior book.
    const chB1 = createChapter(db, { projectId: bookB.id, title: "B1" });
    updateChapter(db, chB1.id, { status: "locked", summary: "b1 summary" });
    const chB2 = createChapter(db, {
      projectId: bookB2.id,
      title: "B2 ch",
      pov: "Bram",
      beats: ["Bram continues"],
    });
    const a = assemblePrompt(db, { chapterId: chB2.id, targetBeatIndices: [0] });
    // Its own series' earlier book is a prior book.
    expect(a.prompt).toContain('Prior book "Bravo One"');
    // The trilogy's books (series A) must not be named as prior books.
    expect(a.prompt).not.toContain('Prior book "Book 1"');
    expect(a.prompt).not.toContain('Prior book "Book 2"');
    expect(a.prompt).not.toContain('Prior book "Book 3"');
  });
});

describe("A16 seam: characters listing (assembler roster, characters page, extraction map)", () => {
  it("listCharacters scoped to a series returns only that series' roster", () => {
    const { db, seriesAId, seriesB } = twoSeries();
    const a = listCharacters(db, seriesAId).map((c) => c.name);
    const b = listCharacters(db, seriesB.id).map((c) => c.name);
    expect(a).toContain("Aster");
    expect(a).not.toContain("Bram");
    expect(b).toContain("Bram");
    expect(b).not.toContain("Aster");
  });

  it("findCharacterByName resolves within a series only", () => {
    const { db, seriesAId, seriesB } = twoSeries();
    // Same name in both series.
    createCharacter(db, { name: "Echo", seriesId: seriesAId });
    createCharacter(db, { name: "Echo", seriesId: seriesB.id });
    const inA = findCharacterByName(db, "Echo", seriesAId);
    const inB = findCharacterByName(db, "Echo", seriesB.id);
    expect(inA?.seriesId).toBe(seriesAId);
    expect(inB?.seriesId).toBe(seriesB.id);
    expect(inA?.id).not.toBe(inB?.id);
  });
});

describe("A16 seam: threads (braid, threads API, extraction open-thread listing)", () => {
  it("listThreads for a book includes its series' series-wide threads, not another series'", () => {
    const { db, bookA, bookB } = twoSeries();
    const forB = listThreads(db, { projectId: bookB.id }).map((t) => t.name);
    expect(forB).toContain("BETA thread");
    expect(forB).not.toContain("ALPHA thread");

    const forA = listThreads(db, { projectId: bookA }).map((t) => t.name);
    expect(forA).toContain("ALPHA thread");
    expect(forA).not.toContain("BETA thread");
  });
});

describe("A16 seam: chat context (buildChatContext)", () => {
  it("a series B character sees only its series' style rules and character facts", () => {
    const { db, seriesAId, seriesB, bookB } = twoSeries();
    const bram = listCharacters(db, seriesB.id).find((c) => c.name === "Bram")!;
    // A series A character_fact that mentions Bram by name must NOT leak into the
    // series B chat (it is series A series-wide).
    createCanon(db, {
      type: "character_fact",
      content: "Bram once betrayed the crown (ALPHA secret).",
      status: "locked",
      projectId: null,
      seriesId: seriesAId,
    });
    createCanon(db, {
      type: "character_fact",
      content: "Bram keeps a BETA ledger.",
      status: "locked",
      projectId: null,
      seriesId: seriesB.id,
    });
    const ctx = buildChatContext(db, {
      characterId: bram.id,
      projectId: bookB.id,
      uiChapter: 1,
    });
    const facts = ctx.characterFacts.map((f) => f.content).join(" ");
    expect(facts).toContain("BETA ledger");
    expect(facts).not.toContain("ALPHA secret");
    expect(ctx.contextPrefix).not.toContain("ALPHA");
  });
});

describe("A16 seam: sweep (runSweep locked-canon prefix)", () => {
  it("the sweep prefix carries only the book's series canon", async () => {
    const { db, bookB } = twoSeries();
    // A locked chapter in book B so the sweep has something to run over.
    const ch = createChapter(db, { projectId: bookB.id, title: "B locked" });
    updateChapter(db, ch.id, { status: "locked" });
    createDraftVersion(db, ch.id, "Some drafted prose to sweep.");

    let capturedPrefix = "";
    const recordingClient: LlmClient = {
      async complete(opts: CompleteOptions): Promise<CompleteResult> {
        capturedPrefix = opts.promptPrefix ?? "";
        return { text: "[]", inputTokens: 1, outputTokens: 1 };
      },
      async *stream(): AsyncGenerator<string, CompleteResult, unknown> {
        yield "";
        return { text: "[]", inputTokens: 1, outputTokens: 1 };
      },
    };
    await runSweep(db, recordingClient, {
      projectId: bookB.id,
      fromOrder: 0,
      toOrder: 100,
      model: "test-model",
    });
    expect(capturedPrefix).toContain("BETAWORLD");
    expect(capturedPrefix).not.toContain("ALPHAWORLD");
  });
});

describe("A16 seam: search (series_id column, seriesId filter, thread deep-link)", () => {
  it("default search stays global; the seriesId filter narrows to one series", () => {
    const { db, seriesAId, seriesB } = twoSeries();
    // Default (no filter) finds both series' canon.
    const globalA = searchIndex(db, { query: "ALPHAWORLD" });
    const globalB = searchIndex(db, { query: "BETAWORLD" });
    expect(globalA.length).toBeGreaterThan(0);
    expect(globalB.length).toBeGreaterThan(0);
    // The rows carry the right series id.
    expect(globalA[0].seriesId).toBe(seriesAId);
    expect(globalB[0].seriesId).toBe(seriesB.id);

    // Filtering to series B hides series A content and vice versa.
    expect(searchIndex(db, { query: "ALPHAWORLD", seriesId: seriesB.id })).toHaveLength(0);
    expect(searchIndex(db, { query: "BETAWORLD", seriesId: seriesAId })).toHaveLength(0);
    expect(searchIndex(db, { query: "BETAWORLD", seriesId: seriesB.id }).length).toBeGreaterThan(0);
  });

  it("a series-wide thread hit carries its series id for the first-book deep link", () => {
    const { db, seriesB, bookB } = twoSeries();
    const hit = searchIndex(db, { query: "BETA thread", kinds: ["thread"] })[0];
    expect(hit).toBeTruthy();
    expect(hit.projectId).toBeNull(); // series-wide
    expect(hit.seriesId).toBe(seriesB.id);
    // The deep link resolves to the first book of the thread's own series.
    expect(firstProjectOfSeries(db, hit.seriesId!)?.id).toBe(bookB.id);
  });
});

describe("A16 seam: canon listing series filter", () => {
  it("listCanon narrows series-wide facts to one series with seriesId", () => {
    const { db, seriesAId, seriesB } = twoSeries();
    const seriesWideB = listCanon(db, { scope: "series", seriesId: seriesB.id }).map(
      (f) => f.content,
    );
    expect(seriesWideB.some((c) => c.includes("BETAWORLD"))).toBe(true);
    expect(seriesWideB.some((c) => c.includes("ALPHAWORLD"))).toBe(false);

    // Without a seriesId, the browse stays global across series.
    const allSeriesWide = listCanon(db, { scope: "series" }).map((f) => f.content);
    void seriesAId;
    expect(allSeriesWide.some((c) => c.includes("ALPHAWORLD"))).toBe(true);
    expect(allSeriesWide.some((c) => c.includes("BETAWORLD"))).toBe(true);
  });
});
