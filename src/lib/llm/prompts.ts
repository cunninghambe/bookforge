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
