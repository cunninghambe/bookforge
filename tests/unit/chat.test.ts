import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import { buildChatContext, buildChatRemainder } from "@/lib/chat";
import { createCharacter, addState } from "@/lib/repo/characters";
import { createCanon } from "@/lib/repo/canon";
import { createChapter, updateChapter } from "@/lib/repo/chapters";
import { hasEmDash } from "@/lib/llm/lint";

// Scenario: Mara in Book 1 (projectId 1). Two states, effective from UI chapters
// 1 and 4 (internal orders 0 and 3). Locked chapters 1..4 (orders 0..3), each with
// a summary. Character facts across scopes, some mentioning Mara and some not.
function scenario() {
  const { db } = testDb();
  const mara = createCharacter(db, {
    name: "Mara",
    role: "fire elemental, POV",
    voiceRules: "dry, understated, never says the thing directly",
  });

  // State effective from UI chapter 1 (order 0): the chapter-1 state.
  addState(db, {
    characterId: mara.id,
    projectId: 1,
    chapterOrder: 0,
    knows: "the fire was set on purpose",
    feels: "watchful",
    hiding: "that she is an elemental, from everyone",
  });
  // State effective from UI chapter 4 (order 3): must NOT appear at pin 3.
  addState(db, {
    characterId: mara.id,
    projectId: 1,
    chapterOrder: 3,
    knows: "Julian set the fire",
    feels: "furious at Julian",
  });

  // Four locked chapters in Book 1 with distinct summaries.
  for (let i = 1; i <= 4; i += 1) {
    const ch = createChapter(db, {
      projectId: 1,
      title: `Chapter ${i}`,
      pov: "Mara",
      synopsis: `Synopsis ${i}`,
      beats: ["beat"],
    });
    updateChapter(db, ch.id, {
      status: "locked",
      summary: `Summary of chapter ${i}, marker CH${i}MARK.`,
    });
  }

  // Character facts. Series-wide and Book-1 facts mentioning Mara are included;
  // the Book-2 fact and the non-Mara fact are excluded.
  createCanon(db, {
    type: "character_fact",
    content: "Mara can smother her own flame at will.",
    status: "locked",
    projectId: null,
  });
  createCanon(db, {
    type: "character_fact",
    content: "Mara fears iron above all things.",
    status: "locked",
    projectId: 1,
  });
  createCanon(db, {
    type: "character_fact",
    content: "Mara returns to the coast in Book 2.",
    status: "locked",
    projectId: 2,
  });
  createCanon(db, {
    type: "character_fact",
    content: "Julian carries a blade of cold iron.",
    status: "locked",
    projectId: 1,
  });

  return { db, mara };
}

describe("buildChatContext", () => {
  it("includes the chapter-1 state and NOT the chapter-4 state when pinned at chapter 3", () => {
    const { db, mara } = scenario();
    const ctx = buildChatContext(db, {
      characterId: mara.id,
      projectId: 1,
      uiChapter: 3,
    });
    expect(ctx.effectiveState?.knows).toBe("the fire was set on purpose");
    expect(ctx.effectiveState?.knows).not.toContain("Julian set the fire");
    // The prefix carries the chapter-1 state, not the chapter-4 state.
    expect(ctx.contextPrefix).toContain("the fire was set on purpose");
    expect(ctx.contextPrefix).not.toContain("Julian set the fire");
    expect(ctx.contextPrefix).not.toContain("furious at Julian");
  });

  it("includes summaries of locked chapters up to the pin only", () => {
    const { db, mara } = scenario();
    const ctx = buildChatContext(db, {
      characterId: mara.id,
      projectId: 1,
      uiChapter: 3,
    });
    const markers = ctx.chapterSummaries.map((s) => s.summary).join("\n");
    expect(markers).toContain("CH1MARK");
    expect(markers).toContain("CH2MARK");
    expect(markers).toContain("CH3MARK");
    // Chapter 4 is past the pin and must be excluded.
    expect(markers).not.toContain("CH4MARK");
    expect(ctx.chapterSummaries).toHaveLength(3);
    expect(ctx.contextPrefix).toContain("CH3MARK");
    expect(ctx.contextPrefix).not.toContain("CH4MARK");
  });

  it("selects character_fact canon mentioning the character, series-wide plus pinned book, and excludes others", () => {
    const { db, mara } = scenario();
    const ctx = buildChatContext(db, {
      characterId: mara.id,
      projectId: 1,
      uiChapter: 3,
    });
    const contents = ctx.characterFacts.map((f) => f.content);
    expect(contents).toContain("Mara can smother her own flame at will.");
    expect(contents).toContain("Mara fears iron above all things.");
    // Book-2 scoped fact is out of scope; non-Mara fact does not mention her.
    expect(contents).not.toContain("Mara returns to the coast in Book 2.");
    expect(contents).not.toContain("Julian carries a blade of cold iron.");
  });

  it("puts the knowledge-hygiene rules and the [MISSING FACT] instruction in the prompt", () => {
    const { db, mara } = scenario();
    const ctx = buildChatContext(db, {
      characterId: mara.id,
      projectId: 1,
      uiChapter: 3,
    });
    expect(ctx.system).toContain("[MISSING FACT]");
    // Knows only what the context establishes.
    expect(ctx.system).toContain("know ONLY what the context");
    // Deflects about what is hidden.
    expect(ctx.system.toLowerCase()).toContain("deflect");
    // Refuses post-pin events.
    expect(ctx.system.toLowerCase()).toContain("refuse");
    // Does not invent.
    expect(ctx.system.toLowerCase()).toContain("do not invent");
    // Voice discipline and subtext.
    expect(ctx.system.toLowerCase()).toContain("subtext");
    // The character's voice rules are carried in the context.
    expect(ctx.contextPrefix).toContain("never says the thing directly");
  });

  it("forbids narration, third-person stage directions, and outside references (A5.1a)", () => {
    const { db, mara } = scenario();
    const ctx = buildChatContext(db, {
      characterId: mara.id,
      projectId: 1,
      uiChapter: 3,
    });
    const sys = ctx.system;
    // First person only.
    expect(sys).toContain("first person");
    expect(sys.toLowerCase()).toContain("only in the first person");
    // No third-person stage directions / narration about oneself.
    expect(sys.toLowerCase()).toContain("third-person stage directions");
    expect(sys.toLowerCase()).toContain("narrated");
    // No reference to the author or anyone outside the conversation, except via
    // the [MISSING FACT] marker line.
    expect(sys.toLowerCase()).toContain("do not address");
    expect(sys).toContain("author");
    expect(sys).toContain("[MISSING FACT]");
  });

  it("assembles a prompt free of em-dashes", () => {
    const { db, mara } = scenario();
    const ctx = buildChatContext(db, {
      characterId: mara.id,
      projectId: 1,
      uiChapter: 3,
    });
    expect(hasEmDash(ctx.system)).toBe(false);
    expect(hasEmDash(ctx.contextPrefix)).toBe(false);
  });

  it("throws for an unknown character", () => {
    const { db } = scenario();
    expect(() =>
      buildChatContext(db, { characterId: 9999, projectId: 1, uiChapter: 1 }),
    ).toThrow();
  });
});

describe("buildChatRemainder", () => {
  it("serializes the transcript with the author and character speakers, ending on the new message", () => {
    const remainder = buildChatRemainder({
      characterName: "Mara",
      history: [
        { role: "user", text: "Who set the fire?" },
        { role: "assistant", text: "Someone who wanted me gone." },
      ],
      message: "Do you trust Julian?",
    });
    expect(remainder).toContain("Author: Who set the fire?");
    expect(remainder).toContain("Mara: Someone who wanted me gone.");
    expect(remainder).toContain("Author: Do you trust Julian?");
    // The prompt ends primed for the character to answer.
    expect(remainder.trimEnd().endsWith("Mara:")).toBe(true);
    expect(hasEmDash(remainder)).toBe(false);
  });
});

// ---- A10: resumed-turn remainder -------------------------------------------

import { buildChatResumeRemainder } from "@/lib/chat";

describe("buildChatResumeRemainder", () => {
  it("sends only the new author message in the transcript speaker format", () => {
    const r = buildChatResumeRemainder({
      characterName: "Mara",
      message: "What do you fear?",
    });
    expect(r).toBe("Author: What do you fear?\n\nMara:");
  });

  it("falls back to You when the character name is blank", () => {
    const r = buildChatResumeRemainder({ characterName: "  ", message: "hi" });
    expect(r).toBe("Author: hi\n\nYou:");
  });
});
