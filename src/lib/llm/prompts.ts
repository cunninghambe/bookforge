// Prompt templates. The assembler (Phase 3) fills the bracketed parts of
// DRAFT_SYSTEM_PROMPT. Every template forbids em-dashes explicitly. Templates are
// added per phase as they are needed.

export interface InterrogationInput {
  chapterTitle: string;
  pov: string;
  synopsis: string;
  beats: string[];
  lockedCanon: string[]; // one line per relevant locked fact
}

// Interrogation: before drafting, force the author to decide the things the scene
// cannot be written without. Output is a JSON array of question strings only.
export function interrogationPrompt(input: InterrogationInput): string {
  const beats = input.beats.map((b, i) => `${i + 1}. ${b}`).join("\n");
  const canon = input.lockedCanon.length
    ? input.lockedCanon.map((c) => `- ${c}`).join("\n")
    : "(none yet)";
  return `You are interrogating a chapter plan before it is drafted. Your job is to surface the decisions the author must lock down first: the facts, motivations, and continuity choices the scene cannot be written without. Ask about what is undecided or ambiguous, not what is already settled in canon.

Do not write prose. Do not use em-dashes anywhere. Ask sharp, specific questions, each answerable in a sentence or two.

CHAPTER
Title: ${input.chapterTitle}
POV: ${input.pov}
Synopsis: ${input.synopsis}
Beats:
${beats}

LOCKED CANON IN SCOPE
${canon}

Return ONLY a JSON array of question strings, for example:
["Does the POV character already know X at this point?", "What is the physical cost of using the power here?"]
Return between 3 and 8 questions. No prose outside the JSON.`;
}

// The drafting system prompt. The assembler fills the two bracketed parts: the
// locked style rules and the POV character. No em-dashes anywhere.
export function draftSystemPrompt(args: {
  styleRules: string[];
  pov: string;
}): string {
  const rules = args.styleRules.length
    ? args.styleRules.map((r) => `- ${r}`).join("\n")
    : "- (no style rules locked yet)";
  return `You are drafting prose for a literary fantasy novel. You write scenes, not summaries. You never break character or address the author except when a required fact is missing (see below).

Register and style rules, all mandatory:
${rules}

Rules of engagement:
- Draft ONLY the beats marked in the TASK block. Stop when the last marked beat completes. Do not draft ahead.
- Everything in the CANON block is immutable fact. If a beat appears to contradict canon, write the scene in the way that honors canon and append a single line at the very end after the marker [CANON TENSION]: describing the conflict in one sentence.
- If drafting requires a fact that is not in canon (a name, a distance, whether a character knows something), do not invent it. Append a line at the end after the marker [MISSING FACT]: stating what you needed. Write the scene around the gap if possible.
- POV discipline: stay inside ${args.pov}'s perception. No head-hopping.
- Match the voice of the PREVIOUS CHAPTER text. Continuity of voice outranks novelty.`;
}

// The revision prompt contract (Phase 4). Kept here so all templates live together.
export function revisionSystemPrompt(styleRules: string[]): string {
  const rules = styleRules.length
    ? styleRules.map((r) => `- ${r}`).join("\n")
    : "- (no style rules locked yet)";
  return `You are revising a chapter draft. The author has flagged specific spans with comments. Your contract:
- Change ONLY the flagged spans, plus the minimum surrounding text needed for grammatical continuity.
- If a flagged change forces a consistency fix elsewhere in the chapter (a name, a repeated detail), you may make that fix, and you must list every such out-of-span change at the end after the marker [CONSISTENCY FIXES]: with a one-line justification each.
- Do not restyle, tighten, or improve unflagged text. Resist the urge.
- All style rules still apply:
${rules}
Return the complete revised chapter text.`;
}

export interface InterrogationQuestion {
  question: string;
}

// Normalizes whatever shape the model returned (array of strings, or array of
// objects with a `question` field) into a clean list of question strings.
export function normalizeQuestions(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === "string" && item.trim()) out.push(item.trim());
    else if (
      item &&
      typeof item === "object" &&
      typeof (item as { question?: unknown }).question === "string"
    ) {
      const q = (item as { question: string }).question.trim();
      if (q) out.push(q);
    }
  }
  return out;
}
