import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { testDb } from "./helpers";
import * as schema from "@/lib/db/schema";
import { TOOL_DEFS, TOOL_NAMES, type ToolCtx } from "@/mcp/tools";
import type { LlmClient, CompleteOptions, CompleteResult } from "@/lib/llm/client";
import { createCharacter, addState } from "@/lib/repo/characters";
import { createChapter } from "@/lib/repo/chapters";
import { createDraftVersion } from "@/lib/repo/drafts";

// In-process coverage of the MCP tool handlers (A6): the 1-based/0-based boundary
// conversions, output shaping, and the forbidden-tool absence, without spawning a
// process. The stdio acceptance test (mcp-server.test.ts) drives the real server.

function cannedFor(purpose: string): string {
  switch (purpose) {
    case "interrogation":
      return '["Does she already know the fire was set?", "What does using the flame cost her?"]';
    case "draft":
      return "She climbed.\n[MISSING FACT]: the guard's name is not established.";
    case "chat":
      return "I keep to the edges of a room.";
    case "sweep":
      return "[]";
    default:
      return "ok";
  }
}

const stubClient: LlmClient = {
  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    return { text: cannedFor(opts.purpose), inputTokens: 10, outputTokens: 5 };
  },
  async *stream(opts: CompleteOptions): AsyncGenerator<string, CompleteResult, unknown> {
    yield "";
    return { text: cannedFor(opts.purpose), inputTokens: 10, outputTokens: 5 };
  },
};

function ctxFor(): { ctx: ToolCtx; db: ReturnType<typeof testDb>["db"] } {
  const { db } = testDb();
  return {
    db,
    ctx: { db, client: stubClient },
  };
}

function tool(name: string) {
  const def = TOOL_DEFS.find((t) => t.name === name);
  if (!def) throw new Error(`no tool ${name}`);
  return def;
}

describe("MCP tool surface", () => {
  it("registers exactly the SPEC A6 tools plus A11 search", () => {
    expect([...TOOL_NAMES].sort()).toEqual(
      [
        "search",
        "answer_question",
        "assembled_prompt",
        "canon_add",
        "canon_list",
        "canon_lock",
        "canon_retire",
        "chapter_create",
        "chapter_get",
        "chapter_update",
        "chapters_list",
        "character_add_state",
        "character_chat",
        "character_get",
        "characters_list",
        "draft_scene",
        "export_book",
        "interrogate_chapter",
        "sweep_book",
      ].sort(),
    );
  });

  it("exposes no human-only gate tool (approve, resolve, lock/unlock chapter, import)", () => {
    for (const n of TOOL_NAMES) {
      expect(/approve/i.test(n)).toBe(false);
      expect(/resolve/i.test(n)).toBe(false);
      expect(/revise|revision/i.test(n)).toBe(false);
      expect(/import/i.test(n)).toBe(false);
      expect(/(chapter.*lock|lock.*chapter|unlock)/i.test(n)).toBe(false);
    }
    // But locking a canon FACT is allowed by the SPEC.
    expect(TOOL_NAMES).toContain("canon_lock");
  });

  it("chapter_update omits status and summary from its schema (cannot lock a chapter)", () => {
    const schemaKeys = Object.keys(tool("chapter_update").inputSchema);
    expect(schemaKeys).not.toContain("status");
    expect(schemaKeys).not.toContain("summary");
    expect(schemaKeys.sort()).toEqual(
      ["beats", "chapterId", "pov", "synopsis", "title"].sort(),
    );
  });
});

describe("1-based / 0-based boundary conversions", () => {
  it("character_add_state stores a 1-based chapter as 0-based chapter_order", async () => {
    const { ctx, db } = ctxFor();
    const c = createCharacter(db, { name: "Mara" });
    const out = (await tool("character_add_state").handler(ctx, {
      characterId: c.id,
      projectId: 1,
      chapter: 1,
      knows: "the fire was set on purpose",
    })) as { state: { id: number; chapter: number } };
    // Output speaks 1-based.
    expect(out.state.chapter).toBe(1);
    // Storage is 0-based.
    const row = db
      .select()
      .from(schema.characterStates)
      .where(eq(schema.characterStates.id, out.state.id))
      .get();
    expect(row?.chapterOrder).toBe(0);
    expect(row?.source).toBe("mcp");
  });

  it("character_get reads back the stored state as its 1-based chapter", async () => {
    const { ctx, db } = ctxFor();
    const c = createCharacter(db, { name: "Mara" });
    // Stored at order 3 -> reads back as chapter 4.
    addState(db, { characterId: c.id, projectId: 1, chapterOrder: 3, knows: "x" });
    const out = (await tool("character_get").handler(ctx, { id: c.id })) as {
      states: Array<{ chapter: number }>;
    };
    expect(out.states.some((s) => s.chapter === 4)).toBe(true);
  });

  it("chapters_list reports 1-based chapter numbers in order", async () => {
    const { ctx, db } = ctxFor();
    createChapter(db, { projectId: 1, title: "First" });
    createChapter(db, { projectId: 1, title: "Second" });
    const out = (await tool("chapters_list").handler(ctx, { projectId: 1 })) as {
      chapters: Array<{ chapter: number; title: string }>;
    };
    expect(out.chapters.map((c) => c.chapter)).toEqual([1, 2]);
    expect(out.chapters[0].title).toBe("First");
  });

  it("assembled_prompt marks the beat named by its 1-based number", async () => {
    const { ctx, db } = ctxFor();
    const ch = createChapter(db, {
      projectId: 1,
      title: "Ch",
      pov: "Mara",
      beats: ["beat one", "beat two", "beat three"],
    });
    const out = (await tool("assembled_prompt").handler(ctx, {
      chapterId: ch.id,
      beats: [2],
    })) as { prompt: string };
    // Beat number 2 (index 1) is the marked one.
    expect(out.prompt).toContain(">> 2. beat two");
    expect(out.prompt).not.toContain(">> 1. beat one");
  });
});

describe("tool behavior and shaping", () => {
  it("canon_add records source 'mcp' and the given status; canon_lock flips it", async () => {
    const { ctx } = ctxFor();
    const added = (await tool("canon_add").handler(ctx, {
      type: "world_rule",
      content: "Iron burns elementals.",
      status: "provisional",
    })) as { fact: { id: number; status: string; source: string; projectId: number | null } };
    expect(added.fact.status).toBe("provisional");
    expect(added.fact.source).toBe("mcp");
    expect(added.fact.projectId).toBe(null); // omitted projectId => series-wide

    const locked = (await tool("canon_lock").handler(ctx, {
      id: added.fact.id,
    })) as { fact: { status: string } };
    expect(locked.fact.status).toBe("locked");
  });

  it("interrogate_chapter stores and returns questions and logs an llm_calls row", async () => {
    const { ctx, db } = ctxFor();
    const ch = createChapter(db, {
      projectId: 1,
      title: "Ch",
      pov: "Mara",
      synopsis: "s",
      beats: ["b"],
    });
    const out = (await tool("interrogate_chapter").handler(ctx, {
      chapterId: ch.id,
    })) as { questions: Array<{ question: string }> };
    expect(out.questions.length).toBe(2);
    const calls = db.select().from(schema.llmCalls).all();
    expect(calls.some((c) => c.purpose === "interrogation")).toBe(true);
  });

  it("answer_question creates a provisional plot_decision fact like the route", async () => {
    const { ctx, db } = ctxFor();
    const ch = createChapter(db, { projectId: 1, title: "Ch", beats: ["b"] });
    const interrogated = (await tool("interrogate_chapter").handler(ctx, {
      chapterId: ch.id,
    })) as { questions: Array<{ id: number }> };
    const qid = interrogated.questions[0].id;
    const out = (await tool("answer_question").handler(ctx, {
      questionId: qid,
      answer: "Yes, she knows.",
    })) as { fact: { type: string; status: string; source: string } };
    expect(out.fact.type).toBe("plot_decision");
    expect(out.fact.status).toBe("provisional");
    expect(out.fact.source).toBe(`interrogation:${ch.id}`);
  });

  it("draft_scene extracts markers out of the prose", async () => {
    const { ctx, db } = ctxFor();
    const ch = createChapter(db, {
      projectId: 1,
      title: "Ch",
      pov: "Mara",
      beats: ["She climbs"],
    });
    const out = (await tool("draft_scene").handler(ctx, {
      chapterId: ch.id,
      beats: [1],
    })) as { prose: string; missingFacts: string[] };
    expect(out.prose).not.toContain("[MISSING FACT]");
    expect(out.missingFacts.length).toBe(1);
    expect(out.missingFacts[0]).toContain("guard");
  });

  it("character_chat rejects an out-of-range pin (A5.1b)", async () => {
    const { ctx, db } = ctxFor();
    const c = createCharacter(db, { name: "Mara" });
    createChapter(db, { projectId: 1, title: "only one" });
    await expect(
      tool("character_chat").handler(ctx, {
        characterId: c.id,
        projectId: 1,
        chapter: 9,
        message: "hi",
      }),
    ).rejects.toThrow(/out of range/i);
  });

  it("unknown ids throw (surfaced as MCP tool errors)", async () => {
    const { ctx } = ctxFor();
    // Handlers may throw synchronously; the registration wrapper awaits them in a
    // try/catch, so wrap in an async thunk to capture either shape as a rejection.
    await expect(
      (async () => tool("character_get").handler(ctx, { id: 9999 }))(),
    ).rejects.toThrow(/not found/i);
    await expect(
      (async () => tool("chapter_get").handler(ctx, { chapterId: 9999 }))(),
    ).rejects.toThrow(/not found/i);
  });
});

describe("search tool (A11)", () => {
  interface Hit {
    kind: string;
    id: number;
    chapter?: number;
    title: string;
    snippet: string;
    status?: string;
  }

  it("finds a chapter by its latest draft prose with a 1-based number and ** markers", async () => {
    const { ctx, db } = ctxFor();
    const ch = createChapter(db, { projectId: 1, title: "The Climb" });
    createDraftVersion(db, ch.id, "The twin moons hung over the ridge.");
    const out = (await tool("search").handler(ctx, {
      query: "twin moons",
    })) as { hits: Hit[] };
    const hit = out.hits.find((h) => h.kind === "chapter" && h.id === ch.id);
    expect(hit).toBeTruthy();
    expect(hit!.chapter).toBe(1);
    expect(hit!.snippet).toMatch(/\*\*twin/i);
  });

  it("excludes retired canon by default and includes it with includeRetired", async () => {
    const { ctx } = ctxFor();
    const added = (await tool("canon_add").handler(ctx, {
      type: "world_rule",
      content: "Vermilion ink is reserved for the crown.",
      status: "provisional",
    })) as { fact: { id: number } };
    await tool("canon_retire").handler(ctx, { id: added.fact.id });

    const byDefault = (await tool("search").handler(ctx, {
      query: "vermilion",
    })) as { hits: Hit[] };
    expect(byDefault.hits.some((h) => h.id === added.fact.id)).toBe(false);

    const withRetired = (await tool("search").handler(ctx, {
      query: "vermilion",
      includeRetired: true,
    })) as { hits: Hit[] };
    const hit = withRetired.hits.find((h) => h.id === added.fact.id);
    expect(hit).toBeTruthy();
    expect(hit!.status).toBe("retired");
  });

  it("operator soup returns cleanly, never a thrown FTS error", async () => {
    const { ctx } = ctxFor();
    const out = (await tool("search").handler(ctx, {
      query: '"( OR ) AND NEAR( * ^"',
    })) as { hits: Hit[] };
    expect(Array.isArray(out.hits)).toBe(true);
  });
});
