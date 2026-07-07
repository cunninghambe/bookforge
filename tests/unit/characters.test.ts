import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import {
  addState,
  createCharacter,
  effectiveState,
  listStates,
} from "@/lib/repo/characters";

describe("characters repo", () => {
  it("creates a character with optional fields", () => {
    const { db } = testDb();
    const c = createCharacter(db, {
      name: "Mara",
      role: "fire elemental, POV",
      voiceRules: "no britishisms",
    });
    expect(c.name).toBe("Mara");
    expect(c.role).toBe("fire elemental, POV");
  });

  it("lists states ordered by book then chapter_order", () => {
    const { db } = testDb();
    const c = createCharacter(db, { name: "Julian" });
    addState(db, { characterId: c.id, projectId: 1, chapterOrder: 3, knows: "c" });
    addState(db, { characterId: c.id, projectId: 1, chapterOrder: 1, knows: "a" });
    addState(db, { characterId: c.id, projectId: 2, chapterOrder: 1, knows: "d" });
    addState(db, { characterId: c.id, projectId: 1, chapterOrder: 2, knows: "b" });
    const states = listStates(db, c.id);
    expect(states.map((s) => s.knows)).toEqual(["a", "b", "c", "d"]);
  });

  it("effectiveState returns the most recent row with chapter_order <= N", () => {
    const { db } = testDb();
    const c = createCharacter(db, { name: "Julian" });
    addState(db, { characterId: c.id, projectId: 1, chapterOrder: 1, feels: "calm" });
    addState(db, { characterId: c.id, projectId: 1, chapterOrder: 4, feels: "afraid" });

    // Before any state.
    expect(
      effectiveState(db, { characterId: c.id, projectId: 1, chapterOrder: 0 }),
    ).toBeUndefined();
    // Between the two rows: picks chapter 1.
    expect(
      effectiveState(db, { characterId: c.id, projectId: 1, chapterOrder: 3 })?.feels,
    ).toBe("calm");
    // At and after the second row: picks chapter 4.
    expect(
      effectiveState(db, { characterId: c.id, projectId: 1, chapterOrder: 4 })?.feels,
    ).toBe("afraid");
    expect(
      effectiveState(db, { characterId: c.id, projectId: 1, chapterOrder: 9 })?.feels,
    ).toBe("afraid");
    // Wrong book: no state.
    expect(
      effectiveState(db, { characterId: c.id, projectId: 2, chapterOrder: 9 }),
    ).toBeUndefined();
  });
});
