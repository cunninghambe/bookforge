import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import { assemblePrompt } from "@/lib/assembler";
import { createCanon } from "@/lib/repo/canon";
import { createChapter, updateChapter } from "@/lib/repo/chapters";
import { createDraftVersion } from "@/lib/repo/drafts";
import { addState, createCharacter } from "@/lib/repo/characters";

function scenario() {
  const { db } = testDb();
  // Two characters. Mara is POV.
  const mara = createCharacter(db, {
    name: "Mara",
    role: "fire elemental, POV",
    voiceRules: "no britishisms",
  });
  const julian = createCharacter(db, { name: "Julian", role: "antagonist" });
  addState(db, {
    characterId: mara.id,
    projectId: 1,
    chapterOrder: 1,
    knows: "Julian set the fire",
    feels: "distrusts Julian",
  });

  // Locked canon of several types in scope.
  createCanon(db, {
    type: "world_rule",
    content: "Iron burns elementals on contact.",
    status: "locked",
    projectId: 1,
  });
  createCanon(db, {
    type: "plot_decision",
    content: "Mara hides that she is an elemental until Book 1 chapter 10.",
    status: "locked",
    projectId: null,
  });
  createCanon(db, {
    type: "character_fact",
    content: "Julian has a scar from the first fire.",
    status: "locked",
    projectId: 1,
  });

  // Prior locked chapter with draft text.
  const prior = createChapter(db, {
    projectId: 1,
    title: "The Fire",
    pov: "Mara",
    synopsis: "The fire starts.",
    beats: ["fire"],
  });
  updateChapter(db, prior.id, {
    status: "locked",
    summary: "Mara survives a fire that Julian secretly set.",
  });
  createDraftVersion(db, prior.id, "The first chapter prose about the fire.");

  // Current chapter, mentions Julian in a beat so he appears.
  const current = createChapter(db, {
    projectId: 1,
    title: "The Hall",
    pov: "Mara",
    synopsis: "Mara enters the hall and meets Julian.",
    beats: ["She hides her flame", "Julian confronts her"],
  });
  return { db, mara, julian, prior, current };
}

describe("assemblePrompt", () => {
  it("emits the seven blocks in the specified order", () => {
    const { db, current } = scenario();
    const a = assemblePrompt(db, {
      chapterId: current.id,
      targetBeatIndices: [0],
    });
    expect(a.blocks.map((b) => b.name)).toEqual([
      "CANON",
      "CHARACTERS",
      "STORY SO FAR",
      "PREVIOUS CHAPTER",
      "CURRENT CHAPTER",
      "TASK",
    ]);
    // The system prompt is separate and carries the locked style rules.
    expect(a.system).toContain("Never use em-dashes");
    expect(a.system).toContain("Mara");
  });

  it("includes locked canon grouped, and only appearing characters", () => {
    const { db, current } = scenario();
    const a = assemblePrompt(db, {
      chapterId: current.id,
      targetBeatIndices: [0, 1],
    });
    const canon = a.blocks.find((b) => b.name === "CANON")!.content;
    expect(canon).toContain("Iron burns elementals on contact.");
    expect(canon).toContain("Mara hides that she is an elemental");
    // Julian appears via the beat, so his character_fact is included.
    expect(canon).toContain("Julian has a scar");

    const chars = a.blocks.find((b) => b.name === "CHARACTERS")!.content;
    expect(chars).toContain("Mara");
    expect(chars).toContain("Julian");
    // Effective state of Mara is present.
    expect(chars).toContain("Julian set the fire");
    expect(a.appearingCharacters.sort()).toEqual(["Julian", "Mara"]);
  });

  it("marks the target beats and pulls the previous chapter text", () => {
    const { db, current } = scenario();
    const a = assemblePrompt(db, {
      chapterId: current.id,
      targetBeatIndices: [1],
    });
    const cur = a.blocks.find((b) => b.name === "CURRENT CHAPTER")!.content;
    expect(cur).toContain(">> 2. Julian confronts her");
    expect(cur).toContain("   1. She hides her flame");

    const prev = a.blocks.find((b) => b.name === "PREVIOUS CHAPTER")!.content;
    expect(prev).toContain("The first chapter prose about the fire.");

    const story = a.blocks.find((b) => b.name === "STORY SO FAR")!.content;
    expect(story).toContain("Mara survives a fire");
  });

  it("front-truncates an oversized previous chapter", () => {
    const { db, prior, current } = scenario();
    const huge =
      "START_MARKER " + "word ".repeat(20000) + " END_MARKER_KEEP_THIS";
    createDraftVersion(db, prior.id, huge);
    const a = assemblePrompt(db, {
      chapterId: current.id,
      targetBeatIndices: [0],
    });
    const prev = a.blocks.find((b) => b.name === "PREVIOUS CHAPTER")!.content;
    expect(prev).toContain("END_MARKER_KEEP_THIS");
    expect(prev).toContain("earlier text truncated");
    expect(prev).not.toContain("START_MARKER");
  });

  it("keeps only the tail of an oversized drafted-so-far", () => {
    const { db, current } = scenario();
    const drafted =
      "OLDEST_SCENE " + "w ".repeat(20000) + " NEWEST_TAIL_KEEP";
    const a = assemblePrompt(db, {
      chapterId: current.id,
      targetBeatIndices: [0],
      draftedSoFar: drafted,
    });
    const cur = a.blocks.find((b) => b.name === "CURRENT CHAPTER")!.content;
    expect(cur).toContain("NEWEST_TAIL_KEEP");
    expect(cur).toContain("earlier drafted scenes");
    expect(cur).not.toContain("OLDEST_SCENE");
  });

  it("warns when the canon block exceeds the token cap", () => {
    const { db, current } = scenario();
    for (let i = 0; i < 200; i++) {
      createCanon(db, {
        type: "world_rule",
        content: `Rule ${i}: ` + "x".repeat(120),
        status: "locked",
        projectId: 1,
      });
    }
    const a = assemblePrompt(db, {
      chapterId: current.id,
      targetBeatIndices: [0],
    });
    expect(a.warnings.some((w) => /over the ~4000 token cap/.test(w))).toBe(true);
  });
});
