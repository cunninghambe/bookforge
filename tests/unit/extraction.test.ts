import { describe, it, expect, afterEach } from "vitest";
import { testDb } from "./helpers";
import {
  parseExtractionResponse,
  parseSweepResponse,
  normalizeThreadProposals,
} from "@/lib/llm/extraction";
import {
  approveExtraction,
  unlockChapter,
  extractedFacts,
} from "@/lib/repo/extraction";
import { createChapter, updateChapter, getChapter } from "@/lib/repo/chapters";
import { createCharacter, listStates } from "@/lib/repo/characters";
import { createCanon, getCanon, listCanon } from "@/lib/repo/canon";
import {
  createThread,
  getThread,
  listThreads,
  listTouches,
} from "@/lib/repo/threads";
import { runCanonExtraction } from "@/lib/lockFlow";
import { FixtureClient, __setLlmClient } from "@/lib/llm/client";

describe("parseExtractionResponse", () => {
  it("parses a valid facts + states envelope", () => {
    const text = JSON.stringify({
      facts: [
        {
          type: "character_fact",
          content: "Mara can smother her flame.",
          evidence_quote: "she willed the fire down",
        },
      ],
      states: [
        {
          character: "Mara",
          knows: "the smothering trick",
          feels: "wary of Julian",
          hiding: "",
          evidence_quote: "she said nothing",
        },
      ],
    });
    const r = parseExtractionResponse(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].type).toBe("character_fact");
    expect(r.states).toHaveLength(1);
    expect(r.states[0].character).toBe("Mara");
    expect(r.states[0].hiding).toBeNull(); // empty string normalized to null
  });

  it("parses a code-fenced envelope", () => {
    const text =
      "Here is the extraction:\n```json\n" +
      JSON.stringify({
        facts: [{ type: "world_rule", content: "There is one moon." }],
        states: [],
      }) +
      "\n```\nThat is all.";
    const r = parseExtractionResponse(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].content).toBe("There is one moon.");
    expect(r.states).toHaveLength(0);
  });

  it("drops a state with no delta and a fact with an invalid type", () => {
    const text = JSON.stringify({
      facts: [{ type: "not_a_type", content: "ignored" }],
      states: [{ character: "Mara", knows: "", feels: "", hiding: "" }],
    });
    const r = parseExtractionResponse(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts).toHaveLength(0);
    expect(r.states).toHaveLength(0);
  });

  it("surfaces the raw text on garbage input", () => {
    const text = "the model refused and wrote prose only, no JSON here";
    const r = parseExtractionResponse(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.raw).toBe(text);
  });
});

describe("parseSweepResponse", () => {
  it("parses a contradiction array with severity and quote", () => {
    const text = JSON.stringify([
      {
        chapter: 1,
        quote: "two moons rose",
        conflicting_fact: "There is one moon.",
        severity: "high",
      },
    ]);
    const r = parseSweepResponse(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contradictions).toHaveLength(1);
    expect(r.contradictions[0].severity).toBe("high");
    expect(r.contradictions[0].quote).toBe("two moons rose");
  });

  it("treats an empty array as clean", () => {
    const r = parseSweepResponse("[]");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contradictions).toHaveLength(0);
  });

  it("surfaces the raw text on garbage input", () => {
    const r = parseSweepResponse("no json at all");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.raw).toBe("no json at all");
  });
});

describe("approveExtraction", () => {
  it("approved fact becomes locked canon with the extraction source", () => {
    const { db } = testDb();
    const chapter = createChapter(db, { projectId: 1, title: "Ch" });
    const result = approveExtraction(db, {
      chapterId: chapter.id,
      facts: [{ type: "character_fact", content: "Mara can smother her flame." }],
      states: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdFacts).toHaveLength(1);
    const fact = getCanon(db, result.createdFacts[0].id);
    expect(fact?.status).toBe("locked");
    expect(fact?.source).toBe(`extraction:${chapter.id}`);
    expect(fact?.projectId).toBe(1);
  });

  it("approved state lands at order_index + 1 with the extraction source", () => {
    const { db } = testDb();
    // Chapter at order_index 0, and a second so this one is not index 0 by luck.
    createChapter(db, { projectId: 1, title: "First" });
    const chapter = createChapter(db, { projectId: 1, title: "Second" });
    expect(chapter.orderIndex).toBe(1);
    const mara = createCharacter(db, { name: "Mara" });
    const result = approveExtraction(db, {
      chapterId: chapter.id,
      facts: [],
      states: [
        { character: "Mara", knows: "the smothering trick", feels: "wary" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const states = listStates(db, mara.id);
    expect(states).toHaveLength(1);
    expect(states[0].chapterOrder).toBe(chapter.orderIndex + 1);
    expect(states[0].source).toBe(`extraction:${chapter.id}`);
    expect(states[0].knows).toBe("the smothering trick");
  });

  it("resolves a state by explicit characterId", () => {
    const { db } = testDb();
    const chapter = createChapter(db, { projectId: 1, title: "Ch" });
    const mara = createCharacter(db, { name: "Mara" });
    const result = approveExtraction(db, {
      chapterId: chapter.id,
      facts: [],
      states: [{ characterId: mara.id, character: "someone else typed", feels: "odd" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(listStates(db, mara.id)).toHaveLength(1);
  });

  it("rejects the whole call when a state names an unknown character", () => {
    const { db } = testDb();
    const chapter = createChapter(db, { projectId: 1, title: "Ch" });
    createCharacter(db, { name: "Mara" });
    const before = listCanon(db).length;
    const result = approveExtraction(db, {
      chapterId: chapter.id,
      facts: [{ type: "world_rule", content: "There is one moon." }],
      states: [{ character: "Ghost", knows: "everything" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unmatched).toContain("Ghost");
    // Nothing was created, not even the valid fact: the gate is atomic.
    expect(listCanon(db).length).toBe(before);
  });
});

describe("unlockChapter", () => {
  it("clears the summary and drops extracted facts to provisional", () => {
    const { db } = testDb();
    const chapter = createChapter(db, { projectId: 1, title: "Ch" });
    updateChapter(db, chapter.id, {
      summary: "A stored summary.",
      status: "locked",
    });
    createCanon(db, {
      projectId: 1,
      type: "character_fact",
      content: "Mara can smother her flame.",
      status: "locked",
      source: `extraction:${chapter.id}`,
    });
    // A locked seed style rule must NOT be touched by the unlock.
    const seedLockedBefore = listCanon(db, { status: "locked" }).length;

    const updated = unlockChapter(db, chapter.id);
    expect(updated?.summary).toBeNull();
    expect(updated?.status).toBe("review");

    const facts = extractedFacts(db, chapter.id);
    expect(facts).toHaveLength(1);
    expect(facts[0].status).toBe("provisional");

    // Exactly the one extracted fact left the locked set; seeds are intact.
    const seedLockedAfter = listCanon(db, { status: "locked" }).length;
    expect(seedLockedAfter).toBe(seedLockedBefore - 1);
  });
});

// ---- Amendment A12: thread proposals -------------------------------------

describe("parseExtractionResponse threads section (A12)", () => {
  it("parses a threads array", () => {
    const text = JSON.stringify({
      facts: [],
      states: [],
      threads: [
        {
          thread: "Theo and Mara",
          isNew: false,
          type: "relationship",
          kind: "advance",
          evidence: "he lingered",
        },
        {
          thread: "The stolen ledger",
          isNew: true,
          type: "mystery",
          kind: "mention",
          evidence: "the drawer was empty",
        },
      ],
    });
    const r = parseExtractionResponse(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.threads).toHaveLength(2);
    expect(r.threads[0].thread).toBe("Theo and Mara");
    expect(r.threads[0].kind).toBe("advance");
    expect(r.threads[1].type).toBe("mystery");
  });

  it("a missing threads key parses as empty (old replies stay valid)", () => {
    const r = parseExtractionResponse(
      JSON.stringify({ facts: [], states: [] }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.threads).toEqual([]);
  });

  it("drops malformed thread proposals (missing name or bad kind) and keeps the good one", () => {
    const text = JSON.stringify({
      facts: [],
      states: [],
      threads: [
        { thread: "", kind: "advance" }, // no name
        { thread: "Nameless kind", kind: "not_a_kind" }, // bad kind
        { thread: "Good one", kind: "payoff", type: "arc" },
      ],
    });
    const r = parseExtractionResponse(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.threads).toHaveLength(1);
    expect(r.threads[0].thread).toBe("Good one");
    expect(r.threads[0].kind).toBe("payoff");
  });

  it("a non-array threads key parses as empty, not a throw", () => {
    const r = parseExtractionResponse(
      JSON.stringify({ facts: [], states: [], threads: "nope" }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.threads).toEqual([]);
  });
});

describe("normalizeThreadProposals (A12)", () => {
  const existing = [
    { id: 7, name: "Theo and Mara" },
    { id: 9, name: "The stolen ledger" },
  ];

  it("matches an existing thread case-insensitively into an attach, regardless of the isNew hint", () => {
    const { attaches, news } = normalizeThreadProposals(
      [
        {
          thread: "  theo AND mara ",
          isNew: true, // the model wrongly said new; the name match wins
          type: "arc",
          kind: "advance",
          evidence: "e1",
        },
      ],
      existing,
    );
    expect(news).toHaveLength(0);
    expect(attaches).toHaveLength(1);
    expect(attaches[0].threadId).toBe(7);
    expect(attaches[0].kind).toBe("advance");
  });

  it("renders an unmatched name as a new-thread proposal", () => {
    const { attaches, news } = normalizeThreadProposals(
      [
        {
          thread: "A brand new arc",
          isNew: false,
          type: "arc",
          kind: "mention",
          evidence: "e2",
        },
      ],
      existing,
    );
    expect(attaches).toHaveLength(0);
    expect(news).toHaveLength(1);
    expect(news[0].name).toBe("A brand new arc");
    expect(news[0].type).toBe("arc");
  });

  it("a new-thread proposal with no type defaults to arc", () => {
    const { news } = normalizeThreadProposals(
      [{ thread: "Typeless", isNew: true, type: null, kind: "advance", evidence: null }],
      existing,
    );
    expect(news[0].type).toBe("arc");
  });
});

describe("approveExtraction threads (A12)", () => {
  it("an approved attach inserts a thread_touch sourced to the chapter", () => {
    const { db } = testDb();
    const chapter = createChapter(db, { projectId: 1, title: "Ch" });
    const thread = createThread(db, {
      projectId: 1,
      name: "Theo and Mara",
      type: "relationship",
    });
    const result = approveExtraction(db, {
      chapterId: chapter.id,
      facts: [],
      states: [],
      threadAttaches: [
        { threadId: thread.id, kind: "advance", evidence: "he lingered" },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdTouches).toHaveLength(1);
    const touches = listTouches(db, thread.id);
    expect(touches).toHaveLength(1);
    expect(touches[0].kind).toBe("advance");
    expect(touches[0].source).toBe(`extraction:${chapter.id}`);
    expect(touches[0].chapterId).toBe(chapter.id);
  });

  it("an approved new-thread proposal creates the thread and its first touch atomically", () => {
    const { db } = testDb();
    const chapter = createChapter(db, { projectId: 1, title: "Ch" });
    const before = listThreads(db, { projectId: 1 }).length;
    const result = approveExtraction(db, {
      chapterId: chapter.id,
      facts: [],
      states: [],
      newThreads: [
        {
          name: "The stolen ledger",
          type: "mystery",
          kind: "mention",
          evidence: "the drawer was empty",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdThreads).toHaveLength(1);
    const created = result.createdThreads[0];
    expect(created.name).toBe("The stolen ledger");
    expect(created.projectId).toBe(1);
    expect(created.status).toBe("open");
    // Exactly one thread was added, with exactly one touch on this chapter.
    expect(listThreads(db, { projectId: 1 }).length).toBe(before + 1);
    const touches = listTouches(db, created.id);
    expect(touches).toHaveLength(1);
    expect(touches[0].source).toBe(`extraction:${chapter.id}`);
  });

  it("rejects the whole call when an attach targets a missing thread, leaving no trace", () => {
    const { db } = testDb();
    const chapter = createChapter(db, { projectId: 1, title: "Ch" });
    const threadsBefore = listThreads(db, { projectId: 1 }).length;
    const result = approveExtraction(db, {
      chapterId: chapter.id,
      facts: [{ type: "world_rule", content: "There is one moon." }],
      states: [],
      threadAttaches: [{ threadId: 4242, kind: "advance" }],
      newThreads: [
        { name: "Would be created", type: "arc", kind: "advance", evidence: null },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unmatched.some((u) => /thread 4242/.test(u))).toBe(true);
    // Nothing landed: not the fact, not the new thread.
    expect(listCanon(db, { status: "locked", scope: 1 })).toHaveLength(0);
    expect(listThreads(db, { projectId: 1 }).length).toBe(threadsBefore);
  });

  it("rejection: approving nothing thread-related leaves the ledger empty", () => {
    const { db } = testDb();
    const chapter = createChapter(db, { projectId: 1, title: "Ch" });
    createThread(db, { projectId: 1, name: "Untouched", type: "arc" });
    approveExtraction(db, {
      chapterId: chapter.id,
      facts: [{ type: "world_rule", content: "Only a fact." }],
      states: [],
    });
    // The pre-existing thread got no touch; no new threads were created.
    const threads = listThreads(db, { projectId: 1 });
    expect(threads).toHaveLength(1);
    expect(listTouches(db, threads[0].id)).toHaveLength(0);
  });
});

describe("runCanonExtraction thread normalization via the fixture (A12)", () => {
  afterEach(() => __setLlmClient(null));

  it("normalizes the fixture reply into one attach and one new proposal", async () => {
    __setLlmClient(new FixtureClient());
    const { db } = testDb();
    // Pre-create the thread the fixture names, so it attaches rather than duplicates.
    const theoMara = createThread(db, {
      projectId: 1,
      name: "Theo and Mara",
      type: "relationship",
    });
    const chapter = createChapter(db, { projectId: 1, title: "Ch" });
    const res = await runCanonExtraction(db, chapter, "some text", "a12");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.threadAttaches).toHaveLength(1);
    expect(res.threadAttaches[0].threadId).toBe(theoMara.id);
    expect(res.threadNews).toHaveLength(1);
    expect(res.threadNews[0].name).toBe("The stolen ledger");
    expect(res.threadNews[0].type).toBe("mystery");
  });

  it("with no pre-existing thread, both fixture proposals normalize to new threads", async () => {
    __setLlmClient(new FixtureClient());
    const { db } = testDb();
    const chapter = createChapter(db, { projectId: 1, title: "Ch" });
    const res = await runCanonExtraction(db, chapter, "some text", "a12");
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.threadAttaches).toHaveLength(0);
    expect(res.threadNews).toHaveLength(2);
  });
});
