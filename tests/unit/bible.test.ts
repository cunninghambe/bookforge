import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import { parseBibleResponse } from "@/lib/llm/bible";
import { approveBible } from "@/lib/repo/bible";
import {
  createCharacter,
  getCharacter,
  listCharacters,
  listStates,
} from "@/lib/repo/characters";
import { listCanon } from "@/lib/repo/canon";

describe("parseBibleResponse", () => {
  it("parses a valid facts + characters + states envelope", () => {
    const text = JSON.stringify({
      facts: [
        { type: "world_rule", content: "There is one moon." },
        { type: "style_rule", content: "No purple prose." },
      ],
      characters: [
        {
          name: "Mara",
          role: "fire elemental",
          voice_rules: "never says sorry",
          physical: "",
          notes: "",
        },
      ],
      states: [{ character: "Mara", knows: "her true name", feels: "", hiding: "" }],
    });
    const r = parseBibleResponse(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts).toHaveLength(2);
    expect(r.facts[0].type).toBe("world_rule");
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].name).toBe("Mara");
    expect(r.characters[0].voiceRules).toBe("never says sorry");
    expect(r.characters[0].physical).toBeNull(); // empty normalized to null
    expect(r.states).toHaveLength(1);
    expect(r.states[0].knows).toBe("her true name");
    expect(r.states[0].feels).toBeNull();
  });

  it("parses a code-fenced envelope", () => {
    const text =
      "Here is the bible:\n```json\n" +
      JSON.stringify({
        facts: [{ type: "timeline_event", content: "The war ended." }],
        characters: [],
        states: [],
      }) +
      "\n```\nDone.";
    const r = parseBibleResponse(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts).toHaveLength(1);
    expect(r.characters).toHaveLength(0);
    expect(r.states).toHaveLength(0);
  });

  it("drops invalid entries: bad fact type, nameless character, delta-less state", () => {
    const text = JSON.stringify({
      facts: [
        { type: "not_a_type", content: "ignored" },
        { type: "world_rule", content: "kept" },
      ],
      characters: [{ role: "no name" }, { name: "Kai" }],
      states: [
        { character: "Kai", knows: "", feels: "", hiding: "" },
        { character: "Kai", feels: "afraid" },
      ],
    });
    const r = parseBibleResponse(text);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.facts).toHaveLength(1);
    expect(r.facts[0].content).toBe("kept");
    expect(r.characters).toHaveLength(1);
    expect(r.characters[0].name).toBe("Kai");
    expect(r.states).toHaveLength(1);
    expect(r.states[0].feels).toBe("afraid");
  });

  it("surfaces the raw text on garbage input", () => {
    const text = "the model wrote prose only, no JSON here";
    const r = parseBibleResponse(text);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.raw).toBe(text);
  });
});

describe("approveBible", () => {
  it("approved facts become locked canon with source 'bible' and the chosen scope", () => {
    const { db } = testDb();
    // Series-wide scope: project_id is null.
    const seriesResult = approveBible(db, {
      scope: "series",
      facts: [{ type: "world_rule", content: "There is one moon." }],
      characters: [],
      states: [],
    });
    expect(seriesResult.ok).toBe(true);
    if (!seriesResult.ok) return;
    expect(seriesResult.createdFacts).toHaveLength(1);
    const seriesFact = seriesResult.createdFacts[0];
    expect(seriesFact.status).toBe("locked");
    expect(seriesFact.source).toBe("bible");
    expect(seriesFact.projectId).toBeNull();

    // Book scope: project_id is that book.
    const bookResult = approveBible(db, {
      scope: 1,
      facts: [{ type: "timeline_event", content: "The bridge fell in the first age." }],
      characters: [],
      states: [],
    });
    expect(bookResult.ok).toBe(true);
    if (!bookResult.ok) return;
    expect(bookResult.createdFacts[0].projectId).toBe(1);
    expect(bookResult.createdFacts[0].source).toBe("bible");
    expect(bookResult.createdFacts[0].status).toBe("locked");
  });

  it("creates a new character when the name does not match an existing one", () => {
    const { db } = testDb();
    const before = listCharacters(db).length;
    const result = approveBible(db, {
      scope: "series",
      facts: [],
      characters: [
        {
          name: "Julian",
          role: "antagonist",
          voiceRules: "uses Britishisms",
          physical: null,
          notes: null,
        },
      ],
      states: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdCharacters).toHaveLength(1);
    expect(result.updatedCharacters).toHaveLength(0);
    expect(listCharacters(db).length).toBe(before + 1);
    expect(result.createdCharacters[0].voiceRules).toBe("uses Britishisms");
  });

  it("applies an id-carrying character proposal as an update, not a duplicate", () => {
    const { db } = testDb();
    const existing = createCharacter(db, { name: "Mara", role: "POV" });
    const before = listCharacters(db).length;
    const result = approveBible(db, {
      scope: "series",
      facts: [],
      characters: [
        {
          id: existing.id,
          name: "mara", // different case, still the same row
          role: null, // empty field must not wipe the existing role
          voiceRules: "clipped, dry",
          physical: null,
          notes: null,
        },
      ],
      states: [],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdCharacters).toHaveLength(0);
    expect(result.updatedCharacters).toHaveLength(1);
    // No duplicate row was created.
    expect(listCharacters(db).length).toBe(before);
    const after = getCharacter(db, existing.id);
    expect(after?.voiceRules).toBe("clipped, dry");
    expect(after?.role).toBe("POV"); // preserved, not wiped by the empty proposal
  });

  it("lands an approved state at chapter_order 0 with source 'bible'", () => {
    const { db } = testDb();
    const mara = createCharacter(db, { name: "Mara" });
    const result = approveBible(db, {
      scope: 1,
      facts: [],
      characters: [],
      states: [{ characterId: mara.id, character: "Mara", knows: "the smothering trick" }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const states = listStates(db, mara.id);
    expect(states).toHaveLength(1);
    expect(states[0].chapterOrder).toBe(0);
    expect(states[0].projectId).toBe(1);
    expect(states[0].source).toBe("bible");
    expect(states[0].knows).toBe("the smothering trick");
  });

  it("creates the character first, then resolves a same-batch state by name", () => {
    const { db } = testDb();
    const result = approveBible(db, {
      scope: 1,
      facts: [],
      characters: [{ name: "Wrenlow", role: "archivist" }],
      states: [
        {
          characterId: null,
          character: "Wrenlow", // not yet tracked; created in this same batch
          knows: "the ledger was forged",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.createdCharacters).toHaveLength(1);
    const wrenlow = result.createdCharacters[0];
    const states = listStates(db, wrenlow.id);
    expect(states).toHaveLength(1);
    expect(states[0].chapterOrder).toBe(0);
    expect(states[0].knows).toBe("the ledger was forged");
  });

  it("rejects the whole call atomically when a state names an unresolvable character", () => {
    const { db } = testDb();
    createCharacter(db, { name: "Mara" });
    const factsBefore = listCanon(db).length;
    const charsBefore = listCharacters(db).length;
    const result = approveBible(db, {
      scope: 1,
      facts: [{ type: "world_rule", content: "There is one moon." }],
      characters: [{ name: "Julian" }],
      states: [{ character: "Ghost", knows: "everything" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.unmatched).toContain("Ghost");
    // Nothing created: not the valid fact, not the valid character. The gate is atomic.
    expect(listCanon(db).length).toBe(factsBefore);
    expect(listCharacters(db).length).toBe(charsBefore);
  });

  it("rejects states under a series-wide scope (states require a book)", () => {
    const { db } = testDb();
    const mara = createCharacter(db, { name: "Mara" });
    const result = approveBible(db, {
      scope: "series",
      facts: [],
      characters: [],
      states: [{ characterId: mara.id, character: "Mara", knows: "something" }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("book scope");
    expect(listStates(db, mara.id)).toHaveLength(0);
  });
});
