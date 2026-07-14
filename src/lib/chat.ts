import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "./db/schema";
import { assemblableCanon, type CanonFact } from "./repo/canon";
import { getCharacter, effectiveState, type Character, type CharacterState } from "./repo/characters";
import { listChapters } from "./repo/chapters";
import { uiChapterToOrder, orderToUiChapter } from "./chapterNumbering";

// Pure context assembly for character chatbots (Amendment A5). Given a character
// and a moment pinned by book and 1-based chapter number, it builds the chat
// system prompt (fixed knowledge-hygiene and voice rules) plus the character
// context prefix (card, effective state, locked character facts, and the
// knowledge-horizon chapter summaries). The prefix is the A4.1 cacheable prompt
// prefix; the running transcript plus the new message is the variable remainder
// (see buildChatRemainder). Nothing here reads or writes chat transcripts.
//
// This module is deliberately kept free of any route or streaming concerns so it
// can be imported directly by the MCP server (Amendment A6) later.

type Db = BetterSQLite3Database<typeof schema>;

export interface ChatPin {
  projectId: number;
  // 1-based chapter number as spoken by the UI (A2 convention).
  uiChapter: number;
}

export interface ChatChapterSummary {
  title: string;
  summary: string;
}

export interface ChatContext {
  // Fixed instructions: knowledge hygiene, voice discipline, the [MISSING FACT]
  // convention, and the em-dash ban.
  system: string;
  // The character context: card, effective state, style rules, character facts,
  // and the knowledge-horizon chapter summaries. Passed as the A4.1 promptPrefix.
  contextPrefix: string;
  character: Character;
  effectiveState: CharacterState | undefined;
  styleRules: string[];
  characterFacts: CanonFact[];
  chapterSummaries: ChatChapterSummary[];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The fixed system prompt: knowledge-hygiene and voice rules, verbatim in intent
// from SPEC A5. Character-agnostic, so it is identical across turns and cacheable.
function chatSystemPrompt(characterName: string): string {
  const name = characterName.trim() || "the character";
  return `You are ${name}, a character in a literary fantasy novel. You speak in the first person, in your own voice, and you never break character or acknowledge that you are a character in a book. You are pinned to one specific moment in the story. Everything you know is fixed at that moment.

Knowledge hygiene, all mandatory:
- You know ONLY what the context below establishes as true as of this moment. Nothing else exists for you.
- You deflect, in character, about anything your state says you are hiding. You do not reveal a secret you are keeping, though you may dodge, change the subject, or answer sideways.
- You refuse, in character, to speak of anything that happens after this moment. You have not lived those events yet, so you cannot know them. Say so in your own voice.
- If you are asked about something the context does not establish, do not invent it. Answer in character that you do not know, then append one final line after the marker [MISSING FACT]: naming plainly what the context did not give you. That line is for the author, not part of your speech.

Speaking, all mandatory:
- You speak ONLY in the first person. Every line is you talking or thinking aloud, never yourself described from the outside.
- Do NOT write third-person stage directions or narration about yourself. Never write lines like "She pulled the edge of her left glove straighter" or "He looked away". You are speaking, not being narrated.
- Do NOT address, name, or refer to the author, a reader, a narrator, or anyone outside this conversation. The one and only exception is the [MISSING FACT] marker line described above, which is the sole place you may speak to the author.

Voice, all mandatory:
- Stay in your voice at all times, following your voice rules in the context below.
- Dialogue carries subtext. Follow the locked style rules in the context. Do not make on-the-nose emotional declarations; say things sideways, the way people actually do.
- Never use em-dashes. Use commas, colons, full stops, or restructure the sentence.`;
}

// Builds the full chat context for a pinned moment. Throws if the character does
// not exist.
export function buildChatContext(db: Db, args: { characterId: number } & ChatPin): ChatContext {
  const character = getCharacter(db, args.characterId);
  if (!character) throw new Error(`character ${args.characterId} not found`);

  const pinnedOrder = uiChapterToOrder(args.uiChapter);

  // Effective state as of the pin: the most recent state row with
  // chapter_order <= pinnedOrder in the pinned book (existing semantics).
  const state = effectiveState(db, {
    characterId: character.id,
    projectId: args.projectId,
    chapterOrder: pinnedOrder,
  });

  // Locked style rules in scope (series-wide plus the pinned book), for the
  // dialogue-subtext discipline.
  const styleRules = assemblableCanon(db, {
    projectId: args.projectId,
    types: ["style_rule"],
  }).map((f) => f.content);

  // Locked character_fact canon mentioning the character, series-wide plus the
  // pinned book. assemblableCanon already scopes to series (null) or this book;
  // we then keep only facts whose content mentions the character by name.
  const nameRe = new RegExp(`\\b${escapeRegExp(character.name)}\\b`, "i");
  const characterFacts = assemblableCanon(db, {
    projectId: args.projectId,
    types: ["character_fact"],
  }).filter((f) => character.name.trim().length > 0 && nameRe.test(f.content));

  // The knowledge horizon: summaries of locked chapters of the pinned book up to
  // and including the pinned chapter, in order.
  const chapterSummaries: ChatChapterSummary[] = listChapters(db, args.projectId)
    .filter((c) => c.status === "locked" && c.orderIndex <= pinnedOrder)
    .map((c) => ({
      title: c.title ?? `Chapter ${orderToUiChapter(c.orderIndex)}`,
      summary: c.summary && c.summary.trim().length > 0 ? c.summary.trim() : "(no summary stored)",
    }));

  const contextPrefix = renderContextPrefix({
    character,
    state,
    styleRules,
    characterFacts,
    chapterSummaries,
  });

  return {
    system: chatSystemPrompt(character.name),
    contextPrefix,
    character,
    effectiveState: state,
    styleRules,
    characterFacts,
    chapterSummaries,
  };
}

function renderContextPrefix(args: {
  character: Character;
  state: CharacterState | undefined;
  styleRules: string[];
  characterFacts: CanonFact[];
  chapterSummaries: ChatChapterSummary[];
}): string {
  const c = args.character;
  const cardLines: string[] = [`Name: ${c.name}`];
  if (c.role) cardLines.push(`Role: ${c.role}`);
  if (c.voiceRules) cardLines.push(`Voice rules: ${c.voiceRules}`);
  if (c.physical) cardLines.push(`Physical: ${c.physical}`);
  if (c.notes) cardLines.push(`Notes: ${c.notes}`);

  const stateLines: string[] = [];
  if (args.state) {
    if (args.state.knows) stateLines.push(`You know: ${args.state.knows}`);
    if (args.state.feels) stateLines.push(`You feel: ${args.state.feels}`);
    if (args.state.hiding) stateLines.push(`You are hiding: ${args.state.hiding}`);
  }
  const stateBlock = stateLines.length
    ? stateLines.join("\n")
    : "(no recorded change to your state at this point)";

  const styleBlock = args.styleRules.length
    ? args.styleRules.map((r) => `- ${r}`).join("\n")
    : "(no style rules locked yet)";

  const factsBlock = args.characterFacts.length
    ? args.characterFacts.map((f) => `- ${f.content}`).join("\n")
    : "(no locked facts about you yet)";

  const summariesBlock = args.chapterSummaries.length
    ? args.chapterSummaries.map((s) => `${s.title}: ${s.summary}`).join("\n")
    : "(nothing has happened yet at this point)";

  return [
    `## CHARACTER\n${cardLines.join("\n")}`,
    `## YOUR STATE AS OF THIS MOMENT\n${stateBlock}`,
    `## STYLE RULES\n${styleBlock}`,
    `## FACTS ABOUT YOU\n${factsBlock}`,
    `## THE STORY SO FAR (everything you have lived up to now)\n${summariesBlock}`,
  ].join("\n\n");
}

export interface ChatTurn {
  role: "user" | "assistant";
  text: string;
}

// Serializes the running transcript plus the new user message into the variable
// remainder. This is the uncached tail of the prompt (A4.1), so every turn after
// the first reuses the cached character context prefix.
export function buildChatRemainder(args: {
  characterName: string;
  history: ChatTurn[];
  message: string;
}): string {
  const name = args.characterName.trim() || "You";
  const lines: string[] = [
    "The author is talking with you. Here is the conversation so far, then their new message. Reply in character, in your own voice.",
    "",
    "## CONVERSATION",
  ];
  for (const turn of args.history) {
    const speaker = turn.role === "assistant" ? name : "Author";
    lines.push(`${speaker}: ${turn.text}`);
  }
  lines.push(`Author: ${args.message}`);
  lines.push("");
  lines.push(`${name}:`);
  return lines.join("\n");
}
