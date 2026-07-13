import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import {
  parseExtractionResponse,
  parseSweepResponse,
} from "@/lib/llm/extraction";
import {
  approveExtraction,
  unlockChapter,
  extractedFacts,
} from "@/lib/repo/extraction";
import { createChapter, updateChapter, getChapter } from "@/lib/repo/chapters";
import { createCharacter, listStates } from "@/lib/repo/characters";
import { createCanon, getCanon, listCanon } from "@/lib/repo/canon";

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
