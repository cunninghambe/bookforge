import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema";
import { assemblableCanon, type CanonType } from "./repo/canon";
import {
  getChapter,
  previousLockedChapter,
  priorLockedChapters,
  type Chapter,
} from "./repo/chapters";
import { listCharacters, effectiveState } from "./repo/characters";
import { latestDraft } from "./repo/drafts";
import { getProject, listProjects } from "./repo/projects";
import { draftSystemPrompt } from "./llm/prompts";
import { orderToUiChapter } from "./chapterNumbering";

type Db = BetterSQLite3Database<typeof schema>;

// Character-count budget heuristics. Roughly 4 characters per token.
const CHARS_PER_TOKEN = 4;
const CANON_CHAR_CAP = 4000 * CHARS_PER_TOKEN; // ~4k tokens
const PREV_CHAPTER_CHAR_CAP = 8000 * CHARS_PER_TOKEN; // ~8k tokens
const DRAFTED_CHAR_CAP = 6000 * CHARS_PER_TOKEN; // ~6k tokens
const SUMMARY_WORD_CAP = 150;
const DRAFTED_KEEP_LAST_WORDS = 1000;

const DEFAULT_TARGET_WORDS = { min: 800, max: 1500 };

export interface AssembleInput {
  chapterId: number;
  targetBeatIndices: number[];
  draftedSoFar?: string;
  targetWords?: { min: number; max: number };
}

export interface AssembledBlock {
  name: string;
  content: string;
}

export interface AssembledPrompt {
  system: string;
  prompt: string;
  // A4.1 cache split. CANON / CHARACTERS / STORY SO FAR / PREVIOUS CHAPTER are
  // stable across the calls for a chapter (and reused when drafting scene by
  // scene); CURRENT CHAPTER / TASK vary per call. stablePrefix carries the
  // trailing separator so that `stablePrefix + variableRemainder === prompt`
  // exactly, letting the draft route pass promptPrefix without altering the
  // bytes the model sees.
  stablePrefix: string;
  variableRemainder: string;
  blocks: AssembledBlock[];
  warnings: string[];
  appearingCharacters: string[];
}

// The first four blocks are the stable, cacheable prefix; the last two vary.
const STABLE_BLOCK_COUNT = 4;

function words(s: string): string[] {
  return s.trim().length === 0 ? [] : s.trim().split(/\s+/);
}

function truncateToWords(s: string, max: number): string {
  const w = words(s);
  return w.length <= max ? s : w.slice(0, max).join(" ");
}

function keepLastWords(s: string, max: number): string {
  const w = words(s);
  return w.length <= max ? s : w.slice(w.length - max).join(" ");
}

function truncateFront(s: string, cap: number): string {
  if (s.length <= cap) return s;
  return "[earlier text truncated to fit the budget]\n" + s.slice(s.length - cap);
}

// A character appears in a chapter if it is the POV, or its name occurs (word
// boundary, case-insensitive) in the synopsis or any beat.
function appearingCharacters(
  chapter: Chapter,
  all: Array<{ id: number; name: string }>,
): Array<{ id: number; name: string }> {
  const haystack = [chapter.synopsis ?? "", ...chapter.beats].join("\n");
  const pov = (chapter.pov ?? "").toLowerCase();
  return all.filter((c) => {
    if (!c.name.trim()) return false;
    if (c.name.toLowerCase() === pov) return true;
    const re = new RegExp(`\\b${escapeRegExp(c.name)}\\b`, "i");
    return re.test(haystack) || re.test(chapter.pov ?? "");
  });
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function assemblePrompt(db: Db, input: AssembleInput): AssembledPrompt {
  const chapter = getChapter(db, input.chapterId);
  if (!chapter) throw new Error(`chapter ${input.chapterId} not found`);
  const warnings: string[] = [];
  const targetWords = input.targetWords ?? DEFAULT_TARGET_WORDS;
  const targetSet = new Set(input.targetBeatIndices);

  // 1. System prompt with locked style rules and POV.
  const styleRules = assemblableCanon(db, {
    projectId: chapter.projectId,
    types: ["style_rule"],
  }).map((f) => f.content);
  const pov = chapter.pov ?? "omniscient";
  const system = draftSystemPrompt({ styleRules, pov });

  const allChars = listCharacters(db).map((c) => ({ id: c.id, name: c.name }));
  const appearing = appearingCharacters(chapter, allChars);
  const appearingNames = appearing.map((c) => c.name);

  // 2. CANON block: world_rule, timeline_event, plot_decision (grouped), plus
  // character_fact only for appearing characters.
  const canonBlock = buildCanonBlock(db, chapter, appearingNames, warnings);

  // 3. CHARACTERS block.
  const charactersBlock = buildCharactersBlock(db, chapter, appearing);

  // 4. STORY SO FAR.
  const storyBlock = buildStorySoFar(db, chapter);

  // 5. PREVIOUS CHAPTER.
  const prevBlock = buildPreviousChapter(db, chapter);

  // 6. CURRENT CHAPTER.
  const currentBlock = buildCurrentChapter(db, chapter, targetSet, input.draftedSoFar);

  // 7. TASK.
  const taskBlock = buildTask(chapter, input.targetBeatIndices, targetWords);

  const blocks: AssembledBlock[] = [
    { name: "CANON", content: canonBlock },
    { name: "CHARACTERS", content: charactersBlock },
    { name: "STORY SO FAR", content: storyBlock },
    { name: "PREVIOUS CHAPTER", content: prevBlock },
    { name: "CURRENT CHAPTER", content: currentBlock },
    { name: "TASK", content: taskBlock },
  ];

  const render = (bs: AssembledBlock[]) =>
    bs.map((b) => `## ${b.name}\n${b.content}`).join("\n\n");
  const stableBlocks = blocks.slice(0, STABLE_BLOCK_COUNT);
  const variableBlocks = blocks.slice(STABLE_BLOCK_COUNT);
  const stableBody = render(stableBlocks);
  const variableRemainder = render(variableBlocks);
  // Prefix carries the "\n\n" that joined the two halves, so prefix + remainder
  // reconstitutes the whole prompt with no lost separator.
  const stablePrefix = `${stableBody}\n\n`;
  const prompt = `${stablePrefix}${variableRemainder}`;

  return {
    system,
    prompt,
    stablePrefix,
    variableRemainder,
    blocks,
    warnings,
    appearingCharacters: appearingNames,
  };
}

function buildCanonBlock(
  db: Db,
  chapter: Chapter,
  appearingNames: string[],
  warnings: string[],
): string {
  const groups: Array<{ label: string; type: CanonType }> = [
    { label: "World rules", type: "world_rule" },
    { label: "Timeline", type: "timeline_event" },
    { label: "Plot decisions", type: "plot_decision" },
  ];
  const parts: string[] = [];
  for (const g of groups) {
    const facts = assemblableCanon(db, {
      projectId: chapter.projectId,
      types: [g.type],
    });
    if (facts.length === 0) continue;
    parts.push(
      `${g.label}:\n${facts.map((f) => `- ${f.content}`).join("\n")}`,
    );
  }

  // character_fact only for appearing characters (heuristic: content mentions an
  // appearing character name).
  const charFacts = assemblableCanon(db, {
    projectId: chapter.projectId,
    types: ["character_fact"],
  }).filter((f) =>
    appearingNames.some((n) =>
      new RegExp(`\\b${escapeRegExp(n)}\\b`, "i").test(f.content),
    ),
  );
  if (charFacts.length > 0) {
    parts.push(
      `Character facts:\n${charFacts.map((f) => `- ${f.content}`).join("\n")}`,
    );
  }

  let block = parts.length ? parts.join("\n\n") : "(no locked canon in scope yet)";
  if (block.length > CANON_CHAR_CAP) {
    warnings.push(
      `Canon block is ${Math.round(block.length / CHARS_PER_TOKEN)} tokens, over the ~4000 token cap. Only locked facts are included; consider retiring stale facts.`,
    );
  }
  return block;
}

function buildCharactersBlock(
  db: Db,
  chapter: Chapter,
  appearing: Array<{ id: number; name: string }>,
): string {
  if (appearing.length === 0) return "(no tracked characters appear in this chapter)";
  const full = listCharacters(db);
  const parts: string[] = [];
  for (const a of appearing) {
    const c = full.find((x) => x.id === a.id);
    if (!c) continue;
    const lines: string[] = [`${c.name}`];
    if (c.role) lines.push(`  role: ${c.role}`);
    if (c.voiceRules) lines.push(`  voice: ${c.voiceRules}`);
    if (c.physical) lines.push(`  physical: ${c.physical}`);
    if (c.notes) lines.push(`  notes: ${c.notes}`);
    const state = effectiveState(db, {
      characterId: c.id,
      projectId: chapter.projectId,
      chapterOrder: chapter.orderIndex,
    });
    if (state) {
      const bits: string[] = [];
      if (state.knows) bits.push(`knows ${state.knows}`);
      if (state.feels) bits.push(`feels ${state.feels}`);
      if (state.hiding) bits.push(`hiding ${state.hiding}`);
      if (bits.length) lines.push(`  state: ${bits.join("; ")}`);
    }
    parts.push(lines.join("\n"));
  }
  return parts.join("\n\n");
}

function buildStorySoFar(db: Db, chapter: Chapter): string {
  const prior = priorLockedChapters(db, chapter);
  const parts: string[] = [];

  // One-line note per prior book, derived from that book's last locked chapter
  // summary if present. Book-level summaries are not stored (see DECISIONS D12).
  const priorBooks = listProjects(db).filter(
    (p) => p.orderIndex < (getProject(db, chapter.projectId)?.orderIndex ?? 0),
  );
  for (const b of priorBooks) {
    parts.push(`Prior book "${b.title}": see its locked chapters.`);
  }

  if (prior.length === 0 && parts.length === 0) {
    return "(this is the first chapter; nothing has happened yet)";
  }
  for (const c of prior) {
    const title = c.title ?? `Chapter ${orderToUiChapter(c.orderIndex)}`;
    const summary = c.summary
      ? truncateToWords(c.summary, SUMMARY_WORD_CAP)
      : "(no summary stored)";
    parts.push(`${title}: ${summary}`);
  }
  return parts.join("\n");
}

function buildPreviousChapter(db: Db, chapter: Chapter): string {
  const prev = previousLockedChapter(db, chapter);
  if (!prev) return "(no previous locked chapter)";
  const draft = latestDraft(db, prev.id);
  if (!draft) return "(previous chapter is locked but has no draft text)";
  const title = prev.title ?? `Chapter ${orderToUiChapter(prev.orderIndex)}`;
  return `${title} (full text):\n${truncateFront(draft.content, PREV_CHAPTER_CHAR_CAP)}`;
}

function buildCurrentChapter(
  db: Db,
  chapter: Chapter,
  targetSet: Set<number>,
  draftedSoFar: string | undefined,
): string {
  const title = chapter.title ?? `Chapter ${orderToUiChapter(chapter.orderIndex)}`;
  const beatLines = chapter.beats.map((b, i) => {
    const mark = targetSet.has(i) ? ">> " : "   ";
    const tail = targetSet.has(i) ? "   <-- DRAFT THIS BEAT" : "";
    return `${mark}${i + 1}. ${b}${tail}`;
  });
  const parts: string[] = [
    `Title: ${title}`,
    `POV: ${chapter.pov ?? "omniscient"}`,
    `Synopsis: ${chapter.synopsis ?? "(none)"}`,
    `Beats (>> marks the ones to draft now):`,
    beatLines.join("\n"),
  ];

  const drafted = (draftedSoFar ?? "").trim();
  if (drafted.length > 0) {
    let text = drafted;
    if (text.length > DRAFTED_CHAR_CAP) {
      text =
        "[earlier drafted scenes in this chapter omitted to fit the budget]\n" +
        keepLastWords(text, DRAFTED_KEEP_LAST_WORDS);
    }
    parts.push(`Drafted so far in this chapter:\n${text}`);
  } else {
    parts.push("Drafted so far in this chapter: (nothing yet)");
  }
  return parts.join("\n");
}

function buildTask(
  chapter: Chapter,
  targetBeatIndices: number[],
  targetWords: { min: number; max: number },
): string {
  const targetBeats = targetBeatIndices
    .map((i) => chapter.beats[i])
    .filter((b): b is string => typeof b === "string");
  const list = targetBeats.map((b, i) => `${i + 1}. ${b}`).join("\n");
  return `Draft the marked beats now:
${list || "(no beats marked)"}

Target length: ${targetWords.min} to ${targetWords.max} words for this scene group.
Stop at the end of the last marked beat. Do not draft ahead into later beats.
Write the scene in ${chapter.pov ?? "omniscient"}'s point of view. Do not use em-dashes.`;
}
