import { describe, it, expect } from "vitest";
import { testDb } from "./helpers";
import { migrate, rebuildSearchIndex } from "@/lib/db/migrate";
import {
  SNIPPET_START,
  SNIPPET_END,
  searchIndex,
  toFtsQuery,
} from "@/lib/search";
import { createCanon, updateCanon } from "@/lib/repo/canon";
import { createCharacter, addState } from "@/lib/repo/characters";
import { createChapter, updateChapter } from "@/lib/repo/chapters";
import { createDraftVersion, saveWorkingDraft } from "@/lib/repo/drafts";

// Amendment A10: the FTS5 index (trigger sync + rebuild) and the query layer.
// Distinctive words are used throughout so the seeded style rules never match.

describe("toFtsQuery sanitizer (D102)", () => {
  it("quotes tokens and prefixes the final one", () => {
    expect(toFtsQuery("silver locket")).toBe('"silver" "locket"*');
  });

  it("does not prefix a single-character final token", () => {
    expect(toFtsQuery("chapter a")).toBe('"chapter" "a"');
  });

  it("returns null for empty and punctuation-only input", () => {
    expect(toFtsQuery("")).toBeNull();
    expect(toFtsQuery("   ")).toBeNull();
    expect(toFtsQuery('" * ( ) ^')).toBeNull();
  });

  it("strips quotes and operator characters so FTS syntax is unreachable", () => {
    expect(toFtsQuery('"twin" OR (moons*)')).toBe('"twin" "OR" "moons"*');
    expect(toFtsQuery("NEAR(a b)")).toBe('"NEARa" "b"');
  });

  it("keeps hyphens and apostrophes (they tokenize like the indexed prose)", () => {
    expect(toFtsQuery("well-worn")).toBe('"well-worn"*');
    expect(toFtsQuery("don't")).toBe(`"don't"*`);
  });

  it("caps the token count", () => {
    const q = toFtsQuery("one two three four five six seven eight nine ten");
    expect(q).not.toBeNull();
    expect((q as string).split(" ").length).toBe(8);
  });
});

describe("search index sync (triggers)", () => {
  it("indexes a chapter's title, synopsis, and beats on insert and update", () => {
    const { db } = testDb();
    const ch = createChapter(db, {
      projectId: 1,
      title: "The Silver Locket",
      synopsis: "She finds the heirloom in the attic.",
      beats: ["She opens the reliquary"],
    });

    expect(searchIndex(db, { query: "heirloom" })[0]?.id).toBe(ch.id);
    expect(searchIndex(db, { query: "reliquary" })[0]?.id).toBe(ch.id);

    updateChapter(db, ch.id, { synopsis: "She loses the pendant." });
    expect(searchIndex(db, { query: "heirloom" })).toHaveLength(0);
    expect(searchIndex(db, { query: "pendant" })[0]?.id).toBe(ch.id);
  });

  it("reports 1-based chapter numbers and falls back to Chapter N titles", () => {
    const { db } = testDb();
    createChapter(db, { projectId: 1, title: "First" });
    const second = createChapter(db, {
      projectId: 1,
      synopsis: "The gargoyle wakes.",
    });
    const hits = searchIndex(db, { query: "gargoyle" });
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(second.id);
    expect(hits[0].chapter).toBe(2);
    expect(hits[0].title).toBe("Chapter 2");
  });

  it("searches only the LATEST draft version of a chapter", () => {
    const { db } = testDb();
    const ch = createChapter(db, { projectId: 1, title: "Ch" });
    createDraftVersion(db, ch.id, "The heron sigil burned on the gate.");
    expect(searchIndex(db, { query: "heron" })).toHaveLength(1);

    // A new version without the word supersedes it.
    createDraftVersion(db, ch.id, "The gate stood bare.");
    expect(searchIndex(db, { query: "heron" })).toHaveLength(0);

    // The in-place working-draft update path (UPDATE, not INSERT) also syncs.
    saveWorkingDraft(db, ch.id, "A kestrel circled the gate.");
    expect(searchIndex(db, { query: "kestrel" })).toHaveLength(1);
    expect(searchIndex(db, { query: "bare" })).toHaveLength(0);
  });

  it("removes a deleted chapter from the index", () => {
    const { db, sqlite } = testDb();
    const ch = createChapter(db, {
      projectId: 1,
      synopsis: "The obsidian stair.",
    });
    expect(searchIndex(db, { query: "obsidian" })).toHaveLength(1);
    sqlite.prepare("DELETE FROM chapters WHERE id = ?").run(ch.id);
    expect(searchIndex(db, { query: "obsidian" })).toHaveLength(0);
  });

  it("indexes canon content and tracks status changes", () => {
    const { db } = testDb();
    const fact = createCanon(db, {
      projectId: null,
      type: "world_rule",
      content: "Vermilion ink is reserved for the crown.",
      status: "provisional",
      source: "manual",
    });
    const hits = searchIndex(db, { query: "vermilion" });
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("canon");
    expect(hits[0].canonType).toBe("world_rule");
    expect(hits[0].status).toBe("provisional");

    updateCanon(db, fact.id, { status: "retired" });
    expect(searchIndex(db, { query: "vermilion" })).toHaveLength(0);
    const withRetired = searchIndex(db, {
      query: "vermilion",
      includeRetired: true,
    });
    expect(withRetired).toHaveLength(1);
    expect(withRetired[0].status).toBe("retired");
  });

  it("indexes characters and states; a rename refreshes state-row titles", () => {
    const { db, sqlite } = testDb();
    const c = createCharacter(db, {
      name: "Mara",
      notes: "Keeps a tally of debts in charcoal.",
    });
    addState(db, {
      characterId: c.id,
      projectId: 1,
      chapterOrder: 3,
      knows: "the aqueduct was sabotaged",
    });

    const charHit = searchIndex(db, { query: "charcoal" });
    expect(charHit).toHaveLength(1);
    expect(charHit[0].kind).toBe("character");
    expect(charHit[0].title).toBe("Mara");

    const stateHit = searchIndex(db, { query: "aqueduct" });
    expect(stateHit).toHaveLength(1);
    expect(stateHit[0].kind).toBe("state");
    expect(stateHit[0].title).toBe("Mara");
    expect(stateHit[0].characterId).toBe(c.id);
    expect(stateHit[0].chapter).toBe(4); // chapterOrder 3 -> 1-based 4 (A2)

    sqlite.prepare("UPDATE characters SET name = ? WHERE id = ?").run("Sefa", c.id);
    expect(searchIndex(db, { query: "aqueduct" })[0].title).toBe("Sefa");
  });
});

describe("query layer semantics", () => {
  it("ranks a title match above a body-only match", () => {
    const { db } = testDb();
    const bodyOnly = createChapter(db, {
      projectId: 1,
      title: "Elsewhere",
      synopsis: "A lighthouse appears once, in passing.",
    });
    const titled = createChapter(db, {
      projectId: 1,
      title: "The Lighthouse",
      synopsis: "Nothing else.",
    });
    const hits = searchIndex(db, { query: "lighthouse" });
    expect(hits.map((h) => h.id)).toEqual([titled.id, bodyOnly.id]);
  });

  it("a projectId scope keeps series-wide rows visible and drops other books", () => {
    const { db } = testDb();
    const mine = createChapter(db, {
      projectId: 1,
      synopsis: "The saltmarsh beacon.",
    });
    createChapter(db, { projectId: 2, synopsis: "The saltmarsh warden." });
    createCanon(db, {
      projectId: null,
      type: "world_rule",
      content: "Saltmarsh water cannot be blessed.",
      status: "locked",
      source: "manual",
    });
    createCharacter(db, { name: "Warden", notes: "Guards the saltmarsh." });

    const hits = searchIndex(db, { query: "saltmarsh", projectId: 1 });
    const kinds = hits.map((h) => `${h.kind}:${h.projectId}`).sort();
    expect(hits.some((h) => h.kind === "chapter" && h.id === mine.id)).toBe(true);
    expect(hits.some((h) => h.kind === "canon" && h.projectId === null)).toBe(true);
    expect(hits.some((h) => h.kind === "character")).toBe(true);
    expect(kinds).not.toContain("chapter:2");
  });

  it("kinds filters the result set", () => {
    const { db } = testDb();
    createChapter(db, { projectId: 1, synopsis: "The tidemill turns." });
    createCanon(db, {
      projectId: 1,
      type: "world_rule",
      content: "The tidemill never stops.",
      status: "locked",
      source: "manual",
    });
    const canonOnly = searchIndex(db, { query: "tidemill", kinds: ["canon"] });
    expect(canonOnly).toHaveLength(1);
    expect(canonOnly[0].kind).toBe("canon");
  });

  it("clamps the limit", () => {
    const { db } = testDb();
    for (let i = 0; i < 3; i += 1) {
      createChapter(db, { projectId: 1, synopsis: `The cormorant sign ${i}.` });
    }
    expect(searchIndex(db, { query: "cormorant", limit: 0 })).toHaveLength(1);
    expect(searchIndex(db, { query: "cormorant", limit: 2 })).toHaveLength(2);
  });

  it("wraps matched ranges in the marker characters", () => {
    const { db } = testDb();
    createChapter(db, { projectId: 1, synopsis: "The basilisk fresco." });
    const [hit] = searchIndex(db, { query: "basilisk" });
    expect(hit.snippet).toContain(`${SNIPPET_START}basilisk${SNIPPET_END}`);
  });

  it("operator soup and quote soup return cleanly, never a throw", () => {
    const { db } = testDb();
    // "and" appears as a literal word: sanitized tokens are all required, so
    // the stripped-to-literal "AND" must actually match the prose.
    createChapter(db, { projectId: 1, synopsis: "The twin moons rise and set." });
    expect(() => searchIndex(db, { query: '"( OR ) AND NEAR( * ^"' })).not.toThrow();
    expect(searchIndex(db, { query: 'twin AND "moons' }).length).toBeGreaterThan(0);
    expect(searchIndex(db, { query: "twin moo" }).length).toBeGreaterThan(0); // prefix
  });
});

describe("rebuild and migration idempotence", () => {
  it("rebuildSearchIndex restores a wiped index", () => {
    const { db, sqlite } = testDb();
    createChapter(db, { projectId: 1, synopsis: "The petrified orchard." });
    sqlite.exec("DELETE FROM search_index");
    expect(searchIndex(db, { query: "petrified" })).toHaveLength(0);
    rebuildSearchIndex(sqlite);
    expect(searchIndex(db, { query: "petrified" })).toHaveLength(1);
  });

  it("running migrate again neither duplicates nor loses index rows", () => {
    const { db, sqlite } = testDb();
    createChapter(db, { projectId: 1, synopsis: "The petrified orchard." });
    const before = sqlite
      .prepare("SELECT COUNT(*) AS n FROM search_index")
      .get() as { n: number };
    migrate(sqlite);
    const after = sqlite
      .prepare("SELECT COUNT(*) AS n FROM search_index")
      .get() as { n: number };
    expect(after.n).toBe(before.n);
    expect(searchIndex(db, { query: "petrified" })).toHaveLength(1);
  });
});
