import { z, type ZodRawShape } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type * as schema from "../lib/db/schema";
import type { LlmClient } from "../lib/llm/client";

import {
  CANON_TYPES,
  listCanon,
  createCanon,
  updateCanon,
  getCanon,
  type CanonFact,
  type CanonType,
  type CanonFilter,
} from "../lib/repo/canon";
import {
  listCharacters,
  getCharacter,
  addState,
  listStates,
  type Character,
  type CharacterState,
} from "../lib/repo/characters";
import {
  listChapters,
  getChapter,
  chapterAtOrder,
  createChapter,
  updateChapter,
  createQuestions,
  listQuestions,
  getQuestion,
  answerQuestion,
  type Chapter,
} from "../lib/repo/chapters";
import {
  THREAD_TYPES,
  THREAD_STATUSES,
  TOUCH_KINDS,
  createThread,
  getThread,
  updateThread,
  addTouch,
  listTouches,
  type Thread,
  type ThreadType,
  type TouchKind,
  type TouchWithChapter,
} from "../lib/repo/threads";
import {
  threadsWithFlagsForBook,
  flagsForThread,
  type ThreadFlags,
} from "../lib/threadFlags";
import { latestDraft } from "../lib/repo/drafts";
import {
  getProject,
  createProject,
  updateProjectTitle,
  type Project,
} from "../lib/repo/projects";
import {
  listSeries,
  getSeries,
  createSeries,
  type Series,
} from "../lib/repo/series";
import { logLlmCall } from "../lib/repo/llm";
import { assemblePrompt } from "../lib/assembler";
import { buildExport } from "../lib/export";
import { runSweep } from "../lib/sweep";
import { buildChatContext, buildChatRemainder, type ChatTurn } from "../lib/chat";
import { validatePinChapter, pinRangeLabel } from "../lib/chatPin";
import { interrogationPrompt, normalizeQuestions } from "../lib/llm/prompts";
import { parseJson } from "../lib/llm/json";
import { hasEmDash } from "../lib/llm/lint";
import { extractMarkers } from "../lib/llm/markers";
import { assemblableCanon } from "../lib/repo/canon";
import { orderToUiChapter, uiChapterToOrder } from "../lib/chapterNumbering";
import { modelFor } from "../lib/modelFor";
import {
  SEARCH_KINDS,
  SNIPPET_END,
  SNIPPET_START,
  searchIndex,
  type SearchKind,
} from "../lib/search";
import { addBreadcrumb, captureException } from "../lib/uh-oh-client";

type Db = BetterSQLite3Database<typeof schema>;

// A8: the per-call model is resolved from the settings/env resolver (modelFor),
// keyed on the call's purpose, so the MCP tools honor the same per-purpose routing
// the web routes do. No fixed model strings are carried on the context.
export interface ToolCtx {
  db: Db;
  client: LlmClient;
}

// A tool: its name, one-line description (every chapter number in inputs/outputs
// is 1-based per A2, stated where relevant), its Zod input shape, and a handler
// that returns a plain JSON-serializable value. The handler may throw; the
// registration wrapper turns a thrown error into an MCP tool error carrying the
// message (never a silent failure).
export interface ToolDef {
  name: string;
  description: string;
  inputSchema: ZodRawShape;
  handler: (ctx: ToolCtx, args: Record<string, unknown>) => Promise<unknown> | unknown;
}

// ---- Output shaping (compact JSON) ----------------------------------------

function shapeFact(f: CanonFact) {
  return {
    id: f.id,
    projectId: f.projectId,
    type: f.type,
    content: f.content,
    status: f.status,
    source: f.source,
  };
}

function shapeCharacter(c: Character) {
  return {
    id: c.id,
    name: c.name,
    role: c.role,
    voiceRules: c.voiceRules,
    physical: c.physical,
    notes: c.notes,
  };
}

// State timeline row with the 1-based chapter it is effective from (A2).
function shapeState(s: CharacterState) {
  return {
    id: s.id,
    projectId: s.projectId,
    chapter: orderToUiChapter(s.chapterOrder),
    knows: s.knows,
    feels: s.feels,
    hiding: s.hiding,
    source: s.source,
  };
}

function shapeChapter(c: Chapter) {
  return {
    id: c.id,
    projectId: c.projectId,
    chapter: orderToUiChapter(c.orderIndex),
    title: c.title,
    pov: c.pov,
    status: c.status,
    synopsis: c.synopsis,
  };
}

// A12: a thread card (no touches) with its computed flags when known.
function shapeThread(t: Thread, flags?: ThreadFlags) {
  return {
    id: t.id,
    projectId: t.projectId,
    name: t.name,
    type: t.type,
    status: t.status,
    characterAId: t.characterAId,
    characterBId: t.characterBId,
    note: t.note,
    ...(flags ? { flags } : {}),
  };
}

// A12: one touch with its 1-based chapter (A2).
function shapeThreadTouch(t: TouchWithChapter) {
  return {
    id: t.id,
    threadId: t.threadId,
    chapterId: t.chapterId,
    chapter: orderToUiChapter(t.chapterOrder),
    kind: t.kind,
    evidence: t.evidence,
    source: t.source,
  };
}

// A16: a series card and a book card.
function shapeSeries(s: Series) {
  return { id: s.id, title: s.title, orderIndex: s.orderIndex };
}

function shapeProject(p: Project) {
  return {
    id: p.id,
    title: p.title,
    orderIndex: p.orderIndex,
    seriesId: p.seriesId,
  };
}

// ---- LLM helpers (non-streaming, em-dash lint mirrors the routes) ---------

interface LintedCompletion {
  text: string;
  retried: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

// One complete() call with the same em-dash discipline the streaming routes use:
// a hard reject and one retry with an explicit instruction, then the caller flags
// any residual violation (never silently accepted). Non-streaming, per SPEC A6.
async function completeWithEmDashRetry(
  client: LlmClient,
  base: {
    purpose: "draft" | "chat";
    model: string;
    system?: string;
    promptPrefix?: string;
    prompt: string;
    maxTokens: number;
  },
): Promise<LintedCompletion> {
  const r1 = await client.complete(base);
  let text = r1.text;
  let inputTokens = r1.inputTokens;
  let outputTokens = r1.outputTokens;
  let cacheReadTokens = r1.cacheReadTokens ?? 0;
  let cacheWriteTokens = r1.cacheWriteTokens ?? 0;
  let retried = false;

  if (hasEmDash(text)) {
    retried = true;
    const r2 = await client.complete({
      ...base,
      prompt:
        base.prompt +
        "\n\nIMPORTANT: your previous reply used an em-dash, which is forbidden. Reply again using commas, colons, full stops, or restructured sentences. No em-dashes.",
    });
    text = r2.text;
    inputTokens += r2.inputTokens;
    outputTokens += r2.outputTokens;
    cacheReadTokens += r2.cacheReadTokens ?? 0;
    cacheWriteTokens += r2.cacheWriteTokens ?? 0;
  }

  return { text, retried, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

// ---- Tool definitions ------------------------------------------------------

const canonTypeSchema = z.enum(CANON_TYPES);

export const TOOL_DEFS: ToolDef[] = [
  {
    name: "canon_list",
    description:
      "List canon facts, optionally filtered by type, status, and scope. scope is \"series\" for series-wide facts or a book's project id for that book. Returns compact JSON.",
    inputSchema: {
      type: canonTypeSchema.optional(),
      status: z.enum(["locked", "provisional", "retired"]).optional(),
      scope: z.union([z.literal("series"), z.number().int()]).optional(),
    },
    handler: (ctx, args) => {
      const filter: CanonFilter = {};
      if (args.type) filter.type = args.type as CanonFilter["type"];
      if (args.status) filter.status = args.status as CanonFilter["status"];
      if (args.scope !== undefined) filter.scope = args.scope as CanonFilter["scope"];
      return { facts: listCanon(ctx.db, filter).map(shapeFact) };
    },
  },
  {
    name: "canon_add",
    description:
      "Add a canon fact. status must be explicitly \"provisional\" or \"locked\" (there is no default and \"retired\" is not allowed here). Pass a book's projectId for a book fact (its series is inferred). For a series-wide fact omit projectId and pass seriesId. Omitting both projectId and seriesId is an error: a series-wide fact must name its series. Source is recorded as \"mcp\".",
    inputSchema: {
      type: canonTypeSchema,
      content: z.string().min(1),
      status: z.enum(["provisional", "locked"]),
      projectId: z.number().int().nullable().optional(),
      seriesId: z.number().int().optional(),
    },
    handler: (ctx, args) => {
      const projectId =
        typeof args.projectId === "number" ? (args.projectId as number) : null;
      const seriesId =
        typeof args.seriesId === "number" ? (args.seriesId as number) : null;
      // A16: a series-wide item (no projectId) must name its series.
      if (projectId === null && seriesId === null) {
        throw new Error(
          "a series-wide canon fact must name its series: pass seriesId (or pass a book's projectId instead)",
        );
      }
      const fact = createCanon(ctx.db, {
        projectId,
        seriesId,
        type: args.type as CanonType,
        content: (args.content as string).trim(),
        status: args.status as "provisional" | "locked",
        source: "mcp",
      });
      return { fact: shapeFact(fact) };
    },
  },
  {
    name: "canon_lock",
    description: "Lock a provisional canon fact by id so it enters prompt assembly.",
    inputSchema: { id: z.number().int() },
    handler: (ctx, args) => {
      const id = args.id as number;
      if (!getCanon(ctx.db, id)) throw new Error(`canon fact ${id} not found`);
      const fact = updateCanon(ctx.db, id, { status: "locked" });
      return { fact: fact ? shapeFact(fact) : null };
    },
  },
  {
    name: "canon_retire",
    description:
      "Retire a canon fact by id. Retired facts are kept but excluded from all prompt assembly.",
    inputSchema: { id: z.number().int() },
    handler: (ctx, args) => {
      const id = args.id as number;
      if (!getCanon(ctx.db, id)) throw new Error(`canon fact ${id} not found`);
      const fact = updateCanon(ctx.db, id, { status: "retired" });
      return { fact: fact ? shapeFact(fact) : null };
    },
  },
  {
    name: "characters_list",
    description:
      "List tracked characters (card fields only). Pass seriesId to list one series' roster; omit it to list every character across all series. Returns compact JSON.",
    inputSchema: {
      seriesId: z.number().int().optional(),
    },
    handler: (ctx, args) => {
      const seriesId =
        typeof args.seriesId === "number" ? (args.seriesId as number) : undefined;
      return { characters: listCharacters(ctx.db, seriesId).map(shapeCharacter) };
    },
  },
  {
    name: "character_get",
    description:
      "Get one character's card plus its state timeline. Each state's \"chapter\" is the 1-based chapter it is effective from.",
    inputSchema: { id: z.number().int() },
    handler: (ctx, args) => {
      const id = args.id as number;
      const character = getCharacter(ctx.db, id);
      if (!character) throw new Error(`character ${id} not found`);
      return {
        character: shapeCharacter(character),
        states: listStates(ctx.db, id).map(shapeState),
      };
    },
  },
  {
    name: "character_add_state",
    description:
      "Add a character state effective from a 1-based chapter number (chapter 1 = the book's first chapter). Source is recorded as \"mcp\".",
    inputSchema: {
      characterId: z.number().int(),
      projectId: z.number().int(),
      chapter: z.number().int().min(1),
      knows: z.string().optional(),
      feels: z.string().optional(),
      hiding: z.string().optional(),
    },
    handler: (ctx, args) => {
      const characterId = args.characterId as number;
      if (!getCharacter(ctx.db, characterId)) {
        throw new Error(`character ${characterId} not found`);
      }
      // 1-based chapter in, 0-based chapter_order stored (A2 boundary).
      const chapterOrder = uiChapterToOrder(args.chapter as number);
      const state = addState(ctx.db, {
        characterId,
        projectId: args.projectId as number,
        chapterOrder,
        knows: (args.knows as string | undefined) ?? null,
        feels: (args.feels as string | undefined) ?? null,
        hiding: (args.hiding as string | undefined) ?? null,
        source: "mcp",
      });
      return { state: shapeState(state) };
    },
  },
  {
    name: "chapters_list",
    description:
      "List a book's chapters in order. Each chapter's \"chapter\" field is its 1-based number.",
    inputSchema: { projectId: z.number().int() },
    handler: (ctx, args) => {
      return {
        chapters: listChapters(ctx.db, args.projectId as number).map(shapeChapter),
      };
    },
  },
  {
    name: "chapter_get",
    description:
      "Get one chapter: 1-based number, title, pov, synopsis, beats, status, summary, and the latest draft text (or null).",
    inputSchema: { chapterId: z.number().int() },
    handler: (ctx, args) => {
      const chapterId = args.chapterId as number;
      const chapter = getChapter(ctx.db, chapterId);
      if (!chapter) throw new Error(`chapter ${chapterId} not found`);
      const draft = latestDraft(ctx.db, chapterId);
      return {
        chapter: {
          ...shapeChapter(chapter),
          beats: chapter.beats,
          summary: chapter.summary,
          draftText: draft?.content ?? null,
        },
      };
    },
  },
  {
    name: "chapter_create",
    description:
      "Create a new planned chapter appended at the end of a book. Returns the created chapter with its 1-based number.",
    inputSchema: {
      projectId: z.number().int(),
      title: z.string().optional(),
      pov: z.string().optional(),
      synopsis: z.string().optional(),
      beats: z.array(z.string()).optional(),
    },
    handler: (ctx, args) => {
      const chapter = createChapter(ctx.db, {
        projectId: args.projectId as number,
        title: args.title as string | undefined,
        pov: args.pov as string | undefined,
        synopsis: args.synopsis as string | undefined,
        beats: args.beats as string[] | undefined,
      });
      return { chapter: { ...shapeChapter(chapter), beats: chapter.beats } };
    },
  },
  {
    name: "chapter_update",
    description:
      "Update a chapter's title, pov, synopsis, or beats. Does NOT change status: locking is a human-only action and is not available here.",
    inputSchema: {
      chapterId: z.number().int(),
      title: z.string().nullable().optional(),
      pov: z.string().nullable().optional(),
      synopsis: z.string().nullable().optional(),
      beats: z.array(z.string()).optional(),
    },
    handler: (ctx, args) => {
      const chapterId = args.chapterId as number;
      if (!getChapter(ctx.db, chapterId)) {
        throw new Error(`chapter ${chapterId} not found`);
      }
      // Only the four editable fields; status/summary are intentionally not
      // patchable here so an agent cannot lock or unlock a chapter.
      const chapter = updateChapter(ctx.db, chapterId, {
        title: args.title as string | null | undefined,
        pov: args.pov as string | null | undefined,
        synopsis: args.synopsis as string | null | undefined,
        beats: args.beats as string[] | undefined,
      });
      return {
        chapter: chapter
          ? { ...shapeChapter(chapter), beats: chapter.beats }
          : null,
      };
    },
  },
  {
    name: "interrogate_chapter",
    description:
      "Run interrogation on a chapter: generate and store the decision questions, then return them. Costs tokens (one LLM call).",
    inputSchema: { chapterId: z.number().int() },
    handler: async (ctx, args) => {
      const chapterId = args.chapterId as number;
      const chapter = getChapter(ctx.db, chapterId);
      if (!chapter) throw new Error(`chapter ${chapterId} not found`);
      const canon = assemblableCanon(ctx.db, {
        projectId: chapter.projectId,
      }).map((f) => f.content);
      const prompt = interrogationPrompt({
        chapterTitle: chapter.title ?? `Chapter ${orderToUiChapter(chapter.orderIndex)}`,
        pov: chapter.pov ?? "omniscient",
        synopsis: chapter.synopsis ?? "",
        beats: chapter.beats,
        lockedCanon: canon,
      });
      const model = modelFor(ctx.db, "interrogation");
      const res = await ctx.client.complete({
        purpose: "interrogation",
        model,
        prompt,
        maxTokens: 1024,
      });
      logLlmCall(ctx.db, {
        purpose: "interrogation",
        chapterId,
        inputTokens: res.inputTokens,
        outputTokens: res.outputTokens,
        model,
      });
      const parsed = parseJson<unknown>(res.text);
      if (!parsed.ok) {
        throw new Error(`could not parse interrogation questions: ${parsed.error}`);
      }
      const questions = normalizeQuestions(parsed.value);
      if (questions.length === 0) throw new Error("no questions returned");
      createQuestions(ctx.db, chapterId, questions);
      updateChapter(ctx.db, chapterId, { status: "interrogating" });
      return {
        questions: listQuestions(ctx.db, chapterId).map((q) => ({
          id: q.id,
          question: q.question,
          answer: q.answer,
        })),
      };
    },
  },
  {
    name: "answer_question",
    description:
      "Answer a stored interrogation question. Creates a PROVISIONAL plot_decision canon fact from the answer, like the route. The fact must still be locked through the normal canon flow.",
    inputSchema: { questionId: z.number().int(), answer: z.string().min(1) },
    handler: (ctx, args) => {
      const questionId = args.questionId as number;
      const question = getQuestion(ctx.db, questionId);
      if (!question) throw new Error(`question ${questionId} not found`);
      const answer = (args.answer as string).trim();
      if (answer.length === 0) throw new Error("answer required");
      const chapter = getChapter(ctx.db, question.chapterId);
      const projectId = chapter?.projectId ?? null;
      const fact = createCanon(ctx.db, {
        type: "plot_decision",
        content: `${question.question} ${answer}`,
        status: "provisional",
        projectId,
        source: `interrogation:${question.chapterId}`,
      });
      const updated = answerQuestion(ctx.db, questionId, answer, fact.id);
      return {
        question: updated
          ? { id: updated.id, question: updated.question, answer: updated.answer }
          : null,
        fact: shapeFact(fact),
      };
    },
  },
  {
    name: "draft_scene",
    description:
      "Draft the given beats of a chapter (non-streaming). beats are 1-based beat numbers. Returns the clean prose plus any [MISSING FACT] and [CANON TENSION] notes extracted from it. Costs tokens.",
    inputSchema: {
      chapterId: z.number().int(),
      beats: z.array(z.number().int().min(1)),
      draftedSoFar: z.string().optional(),
    },
    handler: async (ctx, args) => {
      const chapterId = args.chapterId as number;
      if (!getChapter(ctx.db, chapterId)) {
        throw new Error(`chapter ${chapterId} not found`);
      }
      // 1-based beat numbers in, 0-based beat indices for the assembler.
      const beatIndices = (args.beats as number[]).map((n) => n - 1);
      const assembled = assemblePrompt(ctx.db, {
        chapterId,
        targetBeatIndices: beatIndices,
        draftedSoFar: (args.draftedSoFar as string | undefined) ?? "",
      });
      const model = modelFor(ctx.db, "draft");
      const r = await completeWithEmDashRetry(ctx.client, {
        purpose: "draft",
        model,
        system: assembled.system,
        promptPrefix: assembled.stablePrefix,
        prompt: assembled.variableRemainder,
        maxTokens: 4096,
      });
      logLlmCall(ctx.db, {
        purpose: "draft",
        chapterId,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens,
        model,
      });
      const markers = extractMarkers(r.text);
      return {
        prose: markers.clean,
        missingFacts: markers.missingFacts,
        canonTensions: markers.canonTensions,
        retried: r.retried,
        emDashUnresolved: hasEmDash(markers.clean),
        warnings: assembled.warnings,
      };
    },
  },
  {
    name: "assembled_prompt",
    description:
      "Return the fully assembled drafting prompt for a chapter (the dev inspection dump): system, prompt, per-block breakdown, warnings, and appearing characters. beats are optional 1-based beat numbers to mark. No LLM call.",
    inputSchema: {
      chapterId: z.number().int(),
      beats: z.array(z.number().int().min(1)).optional(),
    },
    handler: (ctx, args) => {
      const chapterId = args.chapterId as number;
      if (!getChapter(ctx.db, chapterId)) {
        throw new Error(`chapter ${chapterId} not found`);
      }
      const beatIndices = ((args.beats as number[] | undefined) ?? []).map(
        (n) => n - 1,
      );
      const assembled = assemblePrompt(ctx.db, {
        chapterId,
        targetBeatIndices: beatIndices,
      });
      return {
        system: assembled.system,
        prompt: assembled.prompt,
        blocks: assembled.blocks,
        warnings: assembled.warnings,
        appearingCharacters: assembled.appearingCharacters,
      };
    },
  },
  {
    name: "character_chat",
    description:
      "One character-chat turn (non-streaming, A5 semantics). Pin the moment with a book projectId and a 1-based chapter (1..chapter count of the book); an out-of-range pin is rejected. Pass the prior transcript in \"history\" and the new \"message\". Returns the in-character reply and any [MISSING FACT] notes. Nothing is persisted. Costs tokens.",
    inputSchema: {
      characterId: z.number().int(),
      projectId: z.number().int(),
      chapter: z.number().int().min(1),
      message: z.string().min(1),
      history: z
        .array(
          z.object({
            role: z.enum(["user", "assistant"]),
            text: z.string(),
          }),
        )
        .optional(),
    },
    handler: async (ctx, args) => {
      const characterId = args.characterId as number;
      const character = getCharacter(ctx.db, characterId);
      if (!character) throw new Error(`character ${characterId} not found`);
      const projectId = args.projectId as number;
      const uiChapter = args.chapter as number;

      // A5.1b: reject a pin outside [1, chapter count of the selected book].
      const chapterCount = listChapters(ctx.db, projectId).length;
      const pinCheck = validatePinChapter(uiChapter, chapterCount);
      if (!pinCheck.valid) {
        throw new Error(
          `pinned chapter ${uiChapter} is out of range; valid chapters are ${pinRangeLabel(chapterCount)}`,
        );
      }

      const context = buildChatContext(ctx.db, { characterId, projectId, uiChapter });
      const history: ChatTurn[] = (
        (args.history as Array<{ role: "user" | "assistant"; text: string }> | undefined) ??
        []
      )
        .map((h) => ({ role: h.role, text: h.text }))
        .filter((h) => h.text.trim().length > 0);
      const remainder = buildChatRemainder({
        characterName: character.name,
        history,
        message: (args.message as string).trim(),
      });

      const model = modelFor(ctx.db, "chat");
      const r = await completeWithEmDashRetry(ctx.client, {
        purpose: "chat",
        model,
        system: context.system,
        promptPrefix: context.contextPrefix,
        prompt: remainder,
        maxTokens: 1024,
      });
      logLlmCall(ctx.db, {
        purpose: "chat",
        chapterId: null,
        inputTokens: r.inputTokens,
        outputTokens: r.outputTokens,
        cacheReadTokens: r.cacheReadTokens,
        cacheWriteTokens: r.cacheWriteTokens,
        model,
      });
      const markers = extractMarkers(r.text);
      return {
        reply: markers.clean,
        missingFacts: markers.missingFacts,
        retried: r.retried,
        emDashUnresolved: hasEmDash(markers.clean),
      };
    },
  },
  {
    name: "search",
    description:
      "Full-text search across chapters (title, pov, synopsis, summary, beats, latest draft prose), canon facts, characters, and character states (A11). Matched ranges in snippets are wrapped in **. Chapter numbers are 1-based. Retired canon is excluded unless includeRetired is true; a projectId scope keeps series-wide facts and characters visible. No LLM call.",
    inputSchema: {
      query: z.string().min(1),
      kinds: z.array(z.enum(SEARCH_KINDS)).optional(),
      projectId: z.number().int().optional(),
      includeRetired: z.boolean().optional(),
      limit: z.number().int().min(1).max(50).optional(),
    },
    handler: (ctx, args) => {
      const hits = searchIndex(ctx.db, {
        query: args.query as string,
        kinds: args.kinds as SearchKind[] | undefined,
        projectId: args.projectId as number | undefined,
        includeRetired: args.includeRetired === true,
        limit: args.limit as number | undefined,
      });
      return {
        hits: hits.map((h) => ({
          ...h,
          snippet: h.snippet
            .split(SNIPPET_START)
            .join("**")
            .split(SNIPPET_END)
            .join("**"),
        })),
      };
    },
  },
  {
    name: "export_book",
    description:
      "Export a book as concatenated Markdown: locked chapters (latest draft version each) in reading order, with a heading per chapter. Returns { filename, content }. No LLM call.",
    inputSchema: { projectId: z.number().int() },
    handler: (ctx, args) => {
      const projectId = args.projectId as number;
      const project = getProject(ctx.db, projectId);
      if (!project) throw new Error(`book ${projectId} not found`);
      return buildExport(ctx.db, project);
    },
  },
  {
    name: "sweep_book",
    description:
      "Run the adversarial consistency sweep over a 1-based chapter range of a book (one call per locked chapter in range). WARNING: this costs tokens per chapter and can be slow. Returns the aggregated contradiction report.",
    inputSchema: {
      projectId: z.number().int(),
      fromChapter: z.number().int().min(1),
      toChapter: z.number().int().min(1),
    },
    handler: async (ctx, args) => {
      const projectId = args.projectId as number;
      if (!getProject(ctx.db, projectId)) {
        throw new Error(`book ${projectId} not found`);
      }
      // 1-based chapter range in, 0-based order range for the sweep.
      const fromOrder = uiChapterToOrder(args.fromChapter as number);
      const toOrder = uiChapterToOrder(args.toChapter as number);
      const report = await runSweep(ctx.db, ctx.client, {
        projectId,
        fromOrder,
        toOrder,
        model: modelFor(ctx.db, "sweep"),
      });
      return report;
    },
  },
  {
    name: "threads_list",
    description:
      "List a book's story threads plus series-wide threads, each with its computed stale/orphan flags for that book (A12). Filter by status. Chapter numbers are 1-based. No LLM call.",
    inputSchema: {
      projectId: z.number().int(),
      status: z.enum(THREAD_STATUSES).optional(),
    },
    handler: (ctx, args) => {
      const projectId = args.projectId as number;
      if (!getProject(ctx.db, projectId)) {
        throw new Error(`book ${projectId} not found`);
      }
      const rows = threadsWithFlagsForBook(ctx.db, projectId, {
        status: args.status as (typeof THREAD_STATUSES)[number] | undefined,
      });
      return {
        threads: rows.map((r) => shapeThread(r.thread, r.flags)),
      };
    },
  },
  {
    name: "thread_get",
    description:
      "Get one thread plus its touch timeline (chronological by chapter). Each touch's \"chapter\" is 1-based. Flags are computed against the thread's own book, or the optional projectId for a series-wide thread. No LLM call.",
    inputSchema: {
      id: z.number().int(),
      projectId: z.number().int().optional(),
    },
    handler: (ctx, args) => {
      const id = args.id as number;
      const thread = getThread(ctx.db, id);
      if (!thread) throw new Error(`thread ${id} not found`);
      const flagBook =
        thread.projectId ?? (args.projectId as number | undefined) ?? null;
      const flags =
        flagBook !== null ? flagsForThread(ctx.db, thread, flagBook) : undefined;
      return {
        thread: shapeThread(thread, flags),
        touches: listTouches(ctx.db, id).map(shapeThreadTouch),
      };
    },
  },
  {
    name: "thread_create",
    description:
      "Create a story thread. type is one of arc, mystery, promise, relationship. Pass a book's projectId for a book thread (its series is inferred). For a series-wide thread omit projectId and pass seriesId. Omitting both projectId and seriesId is an error: a series-wide thread must name its series. Optional character pair for relationship threads. Returns the created thread.",
    inputSchema: {
      name: z.string().min(1),
      type: z.enum(THREAD_TYPES),
      projectId: z.number().int().nullable().optional(),
      seriesId: z.number().int().optional(),
      note: z.string().optional(),
      characterAId: z.number().int().nullable().optional(),
      characterBId: z.number().int().nullable().optional(),
    },
    handler: (ctx, args) => {
      const projectId =
        typeof args.projectId === "number" ? (args.projectId as number) : null;
      const seriesId =
        typeof args.seriesId === "number" ? (args.seriesId as number) : null;
      // A16: a series-wide item (no projectId) must name its series.
      if (projectId === null && seriesId === null) {
        throw new Error(
          "a series-wide thread must name its series: pass seriesId (or pass a book's projectId instead)",
        );
      }
      const thread = createThread(ctx.db, {
        projectId,
        seriesId,
        name: (args.name as string).trim(),
        type: args.type as ThreadType,
        note: (args.note as string | undefined) ?? null,
        characterAId:
          typeof args.characterAId === "number"
            ? (args.characterAId as number)
            : null,
        characterBId:
          typeof args.characterBId === "number"
            ? (args.characterBId as number)
            : null,
      });
      return { thread: shapeThread(thread) };
    },
  },
  {
    name: "thread_touch_add",
    description:
      "Add a touch to a thread at a 1-based chapter number (chapter 1 = the book's first chapter). kind is advance, complicate, payoff, or mention. For a series-wide thread pass projectId to say which book's chapter. Source is recorded as \"mcp\".",
    inputSchema: {
      threadId: z.number().int(),
      chapter: z.number().int().min(1),
      kind: z.enum(TOUCH_KINDS),
      evidence: z.string().optional(),
      projectId: z.number().int().optional(),
    },
    handler: (ctx, args) => {
      const threadId = args.threadId as number;
      const thread = getThread(ctx.db, threadId);
      if (!thread) throw new Error(`thread ${threadId} not found`);
      const projectId =
        thread.projectId ??
        (typeof args.projectId === "number" ? (args.projectId as number) : null);
      if (projectId === null) {
        throw new Error(
          "projectId is required to add a touch to a series-wide thread",
        );
      }
      // 1-based chapter in, resolved to the chapter row at that 0-based order.
      const chapter = chapterAtOrder(
        ctx.db,
        projectId,
        uiChapterToOrder(args.chapter as number),
      );
      if (!chapter) {
        throw new Error(
          `no chapter ${args.chapter} in book ${projectId}`,
        );
      }
      const touch = addTouch(ctx.db, {
        threadId,
        chapterId: chapter.id,
        kind: args.kind as TouchKind,
        evidence: (args.evidence as string | undefined) ?? null,
        source: "mcp",
      });
      return {
        touch: {
          ...shapeThreadTouch({
            ...touch,
            chapterOrder: chapter.orderIndex,
            chapterProjectId: chapter.projectId,
          }),
        },
      };
    },
  },
  {
    name: "thread_resolve",
    description:
      "Mark a thread resolved. Like locking a canon fact, this is an author-equivalent status change on standing data (it does not approve any extraction proposal). Retired and resolved threads leave prompt assembly and flagging.",
    inputSchema: { id: z.number().int() },
    handler: (ctx, args) => {
      const id = args.id as number;
      if (!getThread(ctx.db, id)) throw new Error(`thread ${id} not found`);
      const thread = updateThread(ctx.db, id, { status: "resolved" });
      return { thread: thread ? shapeThread(thread) : null };
    },
  },
  {
    name: "thread_retire",
    description:
      "Retire a thread. Kept but excluded from prompt assembly and flagging, like retired canon. An author-equivalent status change, not an extraction-approval gate.",
    inputSchema: { id: z.number().int() },
    handler: (ctx, args) => {
      const id = args.id as number;
      if (!getThread(ctx.db, id)) throw new Error(`thread ${id} not found`);
      const thread = updateThread(ctx.db, id, { status: "retired" });
      return { thread: thread ? shapeThread(thread) : null };
    },
  },
  {
    name: "series_list",
    description:
      "List all series (id, title, order index) in order. A series is the container that scopes canon, characters, and threads; a book belongs to one series (A16). No LLM call.",
    inputSchema: {},
    handler: (ctx) => {
      return { series: listSeries(ctx.db).map(shapeSeries) };
    },
  },
  {
    name: "series_create",
    description:
      "Create a new series. Copies the five seed style rules into it as locked series-wide facts and creates its first book with a default title, so it is ready to write. Returns the created series and its first book. No LLM call.",
    inputSchema: {
      title: z.string().min(1),
      firstBookTitle: z.string().optional(),
    },
    handler: (ctx, args) => {
      const { series, firstBook } = createSeries(ctx.db, {
        title: (args.title as string).trim(),
        firstBookTitle: args.firstBookTitle as string | undefined,
      });
      return { series: shapeSeries(series), firstBook: shapeProject(firstBook) };
    },
  },
  {
    name: "book_create",
    description:
      "Create a book (project) in a series. Pass title and the seriesId it belongs to. The book is appended at the end of that series in reading order. Returns the created book. No LLM call.",
    inputSchema: {
      title: z.string().min(1),
      seriesId: z.number().int(),
    },
    handler: (ctx, args) => {
      const seriesId = args.seriesId as number;
      if (!getSeries(ctx.db, seriesId)) {
        throw new Error(`series ${seriesId} not found`);
      }
      const project = createProject(ctx.db, {
        title: (args.title as string).trim(),
        seriesId,
      });
      return { book: shapeProject(project) };
    },
  },
  {
    name: "book_rename",
    description:
      "Rename a book (title only). Does not move it between series (there is no cross-series move). Returns the updated book. No LLM call.",
    inputSchema: {
      id: z.number().int(),
      title: z.string().min(1),
    },
    handler: (ctx, args) => {
      const id = args.id as number;
      if (!getProject(ctx.db, id)) throw new Error(`book ${id} not found`);
      const project = updateProjectTitle(ctx.db, id, (args.title as string).trim());
      return { book: project ? shapeProject(project) : null };
    },
  },
];

// The tool names, for the registration guard and the absence assertion in tests.
export const TOOL_NAMES = TOOL_DEFS.map((t) => t.name);

// Registers every tool on an McpServer. Each handler is wrapped so a thrown error
// becomes an MCP tool error carrying the underlying message (SPEC A6: errors are
// never silent), and successful results are returned as compact JSON text.
export function registerTools(server: McpServer, ctx: ToolCtx): void {
  for (const def of TOOL_DEFS) {
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: def.inputSchema },
      // The SDK infers the args type from inputSchema; we accept it loosely and
      // re-read fields inside each handler.
      (async (args: Record<string, unknown>) => {
        try {
          const result = await def.handler(ctx, args ?? {});
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
          };
        } catch (err) {
          // Crash reporting (uh-oh): a no-op until UH_OH_DSN is configured.
          addBreadcrumb({ category: "mcp-tool", message: `tool ${def.name} threw` });
          captureException(err);
          const message = err instanceof Error ? err.message : String(err);
          return {
            content: [{ type: "text" as const, text: message }],
            isError: true,
          };
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any,
    );
  }
}
