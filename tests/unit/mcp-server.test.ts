import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { migrateAndSeed } from "@/lib/db/migrate";
import * as schema from "@/lib/db/schema";
import { createCharacter, addState } from "@/lib/repo/characters";
import { createChapter, updateChapter } from "@/lib/repo/chapters";
import { createDraftVersion } from "@/lib/repo/drafts";
import { TOOL_NAMES } from "@/mcp/tools";

// Acceptance test for the BookForge MCP server (Amendment A6). It SPAWNS the real
// server over stdio (node --import tsx src/mcp/server.ts) with USE_FIXTURE_LLM=1
// and a scratch DATABASE_PATH under ./data, connects with the MCP SDK client, and
// drives the tools. Generous timeouts: spawning tsx on a cold sandbox is slow.
// node --import tsx (spawning node.exe directly) avoids the Windows .cmd shim
// issues the app documented in A7 (D64).

const ROOT = process.cwd();
const DATA_DIR = resolve(ROOT, "data");
const DB_PATH = resolve(DATA_DIR, `mcp-test-${process.pid}-${Date.now()}.db`);
const SERVER = resolve(ROOT, "src", "mcp", "server.ts");

// Every tool the SPEC A6 list registers, plus the A11 search tool.
const EXPECTED_TOOLS = [
  "search",
  "canon_list",
  "canon_add",
  "canon_lock",
  "canon_retire",
  "characters_list",
  "character_get",
  "character_add_state",
  "chapters_list",
  "chapter_get",
  "chapter_create",
  "chapter_update",
  "interrogate_chapter",
  "answer_question",
  "draft_scene",
  "assembled_prompt",
  "character_chat",
  "export_book",
  "sweep_book",
];

let client: Client;
let transport: StdioClientTransport;
let serverClosed = false;
let seeded: { characterId: number; chapterA: number; chapterB: number };

// Seeds the scratch DB directly (before the server opens it). The lock-time and
// import flows are human-only and absent from the MCP surface, so the one locked
// chapter export_book and sweep_book need is created here, not via a tool.
function seed(): { characterId: number; chapterA: number; chapterB: number } {
  const sqlite = new Database(DB_PATH);
  migrateAndSeed(sqlite);
  const db = drizzle(sqlite, { schema });
  const mara = createCharacter(db, {
    name: "Mara",
    role: "fire elemental, POV",
    voiceRules: "dry, understated, never says the thing directly",
  });
  addState(db, {
    characterId: mara.id,
    projectId: 1,
    chapterOrder: 0,
    knows: "the fire was set on purpose",
    hiding: "that she is an elemental, from everyone",
  });
  // A locked chapter (order 0) with a draft: for export_book and sweep_book.
  const chA = createChapter(db, {
    projectId: 1,
    title: "The Climb",
    pov: "Mara",
    synopsis: "Mara climbs the tower.",
    beats: ["She climbs"],
  });
  createDraftVersion(
    db,
    chA.id,
    "The stairs turned back on themselves. The twin moons hung over the ridge as she climbed.",
  );
  updateChapter(db, chA.id, {
    status: "locked",
    summary: "Mara climbs the tower and reaches the landing.",
  });
  // A planned chapter (order 1) with beats: for draft_scene and assembled_prompt.
  const chB = createChapter(db, {
    projectId: 1,
    title: "The Descent",
    pov: "Mara",
    synopsis: "Mara descends the tower.",
    beats: ["She descends the stairs", "She meets the guard"],
  });
  sqlite.close();
  return { characterId: mara.id, chapterA: chA.id, chapterB: chB.id };
}

async function call(
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text: string }>;
  };
  const text = res.content?.[0]?.text ?? "";
  if (res.isError) throw new Error(`tool ${name} errored: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

beforeAll(async () => {
  mkdirSync(DATA_DIR, { recursive: true });
  seeded = seed();

  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === "string") env[k] = v;
  }
  env.USE_FIXTURE_LLM = "1";
  env.DATABASE_PATH = DB_PATH;

  transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", SERVER],
    cwd: ROOT,
    env,
    stderr: "pipe",
  });
  client = new Client({ name: "mcp-acceptance-test", version: "0.0.0" });
  await client.connect(transport);
}, 120000);

afterAll(async () => {
  if (!serverClosed) {
    try {
      await client?.close();
    } catch {
      // ignore
    }
  }
  for (const suffix of ["", "-wal", "-shm"]) {
    const p = DB_PATH + suffix;
    if (existsSync(p)) {
      try {
        rmSync(p);
      } catch {
        // ignore: a lingering handle on Windows; the temp file is harmless.
      }
    }
  }
});

describe("MCP server (A6) over stdio", () => {
  it("lists exactly the expected tools and none of the human-only gate tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();

    for (const expected of EXPECTED_TOOLS) {
      expect(names).toContain(expected);
    }
    // The registered set is exactly the SPEC A6 list (no extras).
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
    // The in-process registry agrees with what the server advertised.
    expect([...TOOL_NAMES].sort()).toEqual([...EXPECTED_TOOLS].sort());

    // THE HARD BOUNDARY: the human-only approval gates must be absent by name.
    // No tool approves extraction/bible proposals, resolves revision hunks, locks
    // or unlocks a chapter, or imports a chapter.
    expect(names.some((n) => /approve/i.test(n))).toBe(false);
    expect(names.some((n) => /resolve/i.test(n))).toBe(false);
    expect(names.some((n) => /revise|revision/i.test(n))).toBe(false);
    expect(names.some((n) => /import/i.test(n))).toBe(false);
    expect(
      names.some((n) => /(chapter.*lock|lock.*chapter|unlock)/i.test(n)),
    ).toBe(false);
    for (const forbidden of [
      "extractions_approve",
      "extraction_approve",
      "bible_approve",
      "approve_extraction",
      "resolve_revision",
      "revisions_resolve",
      "lock_chapter",
      "chapter_lock",
      "unlock_chapter",
      "import_chapter",
      "chapter_import",
      "revise",
    ]) {
      expect(names).not.toContain(forbidden);
    }
    // canon_lock and canon_retire ARE present (locking a canon fact is allowed).
    expect(names).toContain("canon_lock");
    expect(names).toContain("canon_retire");
  }, 30000);

  it("canon_add then canon_lock round-trips and canon_list shows it locked", async () => {
    const added = await call("canon_add", {
      type: "world_rule",
      content: "Cold iron burns fire elementals.",
      status: "provisional",
      projectId: 1,
    });
    const fact = added.fact as { id: number; status: string };
    expect(fact.status).toBe("provisional");

    const locked = await call("canon_lock", { id: fact.id });
    expect((locked.fact as { status: string }).status).toBe("locked");

    const listed = await call("canon_list", { status: "locked", scope: 1 });
    const facts = listed.facts as Array<{ id: number; status: string }>;
    const found = facts.find((f) => f.id === fact.id);
    expect(found).toBeTruthy();
    expect(found!.status).toBe("locked");
  }, 30000);

  it("character_add_state with a 1-based chapter lands at the correct internal order", async () => {
    // chapter 1 (1-based) must store chapter_order 0 and read back as chapter 1.
    await call("character_add_state", {
      characterId: seeded.characterId,
      projectId: 1,
      chapter: 1,
      knows: "cold iron is close",
    });
    const got = await call("character_get", { id: seeded.characterId });
    const states = got.states as Array<{ chapter: number; knows: string | null }>;
    const landed = states.find((s) => s.knows === "cold iron is close");
    expect(landed).toBeTruthy();
    expect(landed!.chapter).toBe(1); // orderToUiChapter(0) === 1
  }, 30000);

  it("draft_scene returns the fixture prose with markers extracted", async () => {
    const draft = await call("draft_scene", {
      chapterId: seeded.chapterB,
      beats: [1],
    });
    expect(draft.prose as string).toContain("The tower stairs turned");
    expect(draft.prose as string).not.toContain("[MISSING FACT]");
    const missing = draft.missingFacts as string[];
    expect(missing.length).toBeGreaterThan(0);
    expect(missing[0]).toContain("guard posted at the tower landing");
  }, 30000);

  it("character_chat returns the fixture reply", async () => {
    const chat = await call("character_chat", {
      characterId: seeded.characterId,
      projectId: 1,
      chapter: 1,
      message: "How do you carry yourself at court?",
    });
    expect(chat.reply as string).toContain("I keep to the edges");
  }, 30000);

  it("rejects an out-of-range chat pin with a clear error (A5.1b)", async () => {
    await expect(
      call("character_chat", {
        characterId: seeded.characterId,
        projectId: 1,
        chapter: 99,
        message: "anything",
      }),
    ).rejects.toThrow(/out of range/i);
  }, 30000);

  it("export_book returns Markdown with the locked chapter heading", async () => {
    const exp = await call("export_book", { projectId: 1 });
    expect(exp.content as string).toContain("## The Climb");
    expect(exp.filename as string).toMatch(/\.md$/);
  }, 30000);

  it("sweep_book returns the fixture report", async () => {
    const sweep = await call("sweep_book", {
      projectId: 1,
      fromChapter: 1,
      toChapter: 1,
    });
    expect(sweep.totalContradictions as number).toBeGreaterThan(0);
    const chapters = sweep.chapters as Array<{
      contradictions: Array<{ conflictingFact: string | null }>;
    }>;
    expect(chapters.length).toBe(1);
    expect(chapters[0].contradictions[0].conflictingFact).toContain("single moon");
  }, 30000);

  it("search finds the locked chapter by its draft prose with ** markers (A11)", async () => {
    const res = await call("search", { query: "twin moons" });
    const hits = res.hits as Array<{
      kind: string;
      id: number;
      chapter?: number;
      title: string;
      snippet: string;
    }>;
    const hit = hits.find((h) => h.kind === "chapter" && h.id === seeded.chapterA);
    expect(hit).toBeTruthy();
    expect(hit!.chapter).toBe(1); // 1-based per A2
    expect(hit!.title).toBe("The Climb");
    // Matched ranges are wrapped in ** (FTS5 may mark tokens separately or
    // coalesce adjacent ones; both carry the markers around "twin").
    expect(hit!.snippet).toMatch(/\*\*twin/i);
  }, 30000);

  it("an LLM-calling tool wrote a row to llm_calls", async () => {
    // Close the server (releasing the DB) before reading the file directly.
    await client.close();
    serverClosed = true;
    // Give the OS a moment to release the file handle on Windows.
    await new Promise((r) => setTimeout(r, 300));

    let rows: Array<{ purpose: string }> = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        const sqlite = new Database(DB_PATH);
        rows = sqlite
          .prepare("SELECT purpose FROM llm_calls")
          .all() as Array<{ purpose: string }>;
        sqlite.close();
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    expect(rows.length).toBeGreaterThan(0);
    // draft_scene, character_chat, and sweep_book all logged their purpose.
    const purposes = new Set(rows.map((r) => r.purpose));
    expect(
      purposes.has("draft") || purposes.has("chat") || purposes.has("sweep"),
    ).toBe(true);
  }, 30000);
});
