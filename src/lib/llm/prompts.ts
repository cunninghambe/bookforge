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

// Patch-mode revision (A4.2). Same contract as revisionSystemPrompt, but the model
// returns a JSON envelope of verbatim-anchored patches instead of the whole
// rewritten chapter, so a revision costs output tokens proportional to the change.
// The enforcement discipline is unchanged: a patch touching an unflagged span that
// is not a declared consistency fix will be caught as an unauthorized change.
export function patchRevisionSystemPrompt(styleRules: string[]): string {
  const rules = styleRules.length
    ? styleRules.map((r) => `- ${r}`).join("\n")
    : "- (no style rules locked yet)";
  return `You are revising a chapter draft. The author has flagged specific spans with comments. Return your edits as patches, not a rewritten chapter. Your contract:
- Change ONLY the flagged spans, plus the minimum surrounding text needed for grammatical continuity. Put those changes in "patches".
- Each patch's "original" must be copied VERBATIM from the chapter text (exact characters, including punctuation and spacing) and extended outward to whole sentence boundaries so it anchors cleanly. "replacement" is the new text for that span.
- If a flagged change forces a consistency fix elsewhere in the chapter (a name, a repeated detail), put it in "consistency_fixes" with a one-line "justification". Do NOT put out-of-span fixes in "patches".
- Do not restyle, tighten, or improve unflagged text. Resist the urge.
- All style rules still apply to every replacement:
${rules}

Return ONLY a JSON object with this exact shape, and nothing else:
{
  "patches": [
    { "original": "verbatim span from the chapter, whole sentences", "replacement": "the revised text" }
  ],
  "consistency_fixes": [
    { "original": "verbatim span from the chapter", "replacement": "the revised text", "justification": "one line explaining why this out-of-span change is required" }
  ]
}
Use an empty array where there is nothing to change. Do not use em-dashes anywhere. No prose outside the JSON.`;
}

// Summary generated at lock time. Summary-purpose model, ~150 words, factual,
// present tense, includes canon-relevant developments. Returns plain prose, not JSON.
export function summaryPrompt(args: {
  chapterTitle: string;
  pov: string;
  text: string;
}): string {
  return `You are summarizing a locked chapter of a novel so later chapters can be drafted against it. Write a single paragraph of about 150 words in the present tense. Be factual and concrete: who does what, what changes, what is now known or decided. Prioritize developments that future chapters must not contradict (deaths, revelations, promises, movements, injuries, decisions). Do not editorialize or describe style. Do not use em-dashes.

CHAPTER
Title: ${args.chapterTitle}
POV: ${args.pov}

TEXT
${args.text}

Return only the summary paragraph. No preamble, no heading.`;
}

// Canon extraction at lock time (Amendment A1). Reads the final chapter text plus
// the current canon list and proposes BOTH new durable facts AND character-state
// deltas as a single JSON object. States are deltas only, never restatements.
export function extractionPrompt(args: {
  chapterTitle: string;
  pov: string;
  text: string;
  currentCanon: string[];
  knownCharacters: string[];
  // A12: the book's existing OPEN threads plus series-wide, by name, so the model
  // attaches a touch to one it recognizes rather than proposing a duplicate.
  openThreads?: string[];
}): string {
  const canon = args.currentCanon.length
    ? args.currentCanon.map((c) => `- ${c}`).join("\n")
    : "(none yet)";
  const chars = args.knownCharacters.length
    ? args.knownCharacters.map((c) => `- ${c}`).join("\n")
    : "(none tracked yet)";
  const threads = args.openThreads && args.openThreads.length
    ? args.openThreads.map((t) => `- ${t}`).join("\n")
    : "(none open yet)";
  return `You are extracting canon from a locked chapter. Read the final text and the current canon, then propose three things:

1. New durable facts the chapter establishes. A durable fact is something future chapters must not contradict: a world rule, a timeline event, a lasting character fact, or an authorial plot decision. Do NOT propose scene details, mood, or phrasing. Do NOT restate facts already in the current canon.

2. Character-state deltas: what a named character now knows, feels, or is hiding that changed in this chapter. Deltas only. Do NOT restate a state the character already had. Only propose states for characters that plausibly match the tracked characters listed below; use the exact tracked name when you can.

3. Thread touches: which standing story threads this chapter advances, complicates, pays off, or mentions. When the chapter touches one of the OPEN THREADS listed below, reuse that thread's exact name and set isNew to false, so the touch attaches to the existing thread instead of duplicating it. Only propose a new thread (isNew true, with a type) for a genuinely new arc, mystery, promise, or relationship the chapter opens. Do NOT invent threads for incidental beats.

CHAPTER
Title: ${args.chapterTitle}
POV: ${args.pov}

TEXT
${args.text}

CURRENT CANON
${canon}

TRACKED CHARACTERS
${chars}

OPEN THREADS
${threads}

Return ONLY a JSON object with this exact shape, and nothing else:
{
  "facts": [
    { "type": "world_rule | timeline_event | character_fact | plot_decision", "content": "the durable fact, one sentence", "evidence_quote": "a short verbatim quote from the text that supports it" }
  ],
  "states": [
    { "character": "the character name", "knows": "new knowledge or empty", "feels": "shifted stance or empty", "hiding": "new secret or empty", "evidence_quote": "a short verbatim quote from the text" }
  ],
  "threads": [
    { "thread": "the thread name", "isNew": true, "type": "arc | mystery | promise | relationship", "kind": "advance | complicate | payoff | mention", "evidence": "a short verbatim quote from the text" }
  ]
}
Use an empty array for facts, states, or threads if there are none. Do not use em-dashes anywhere. No prose outside the JSON.`;
}

// Thread backfill scan for one locked chapter (Amendment A17). A sibling of
// extractionPrompt that reuses its threads-section contract text, but asks ONLY
// for thread touches (the scan is about threads, not facts or states). The prompt
// carries the chapter's locked text and summary, the book's existing OPEN THREADS
// as attach targets, and the thread names ALREADY PROPOSED earlier in this run, so
// a recurring line (chapter 7's "Theo and Mara") reuses the same name as chapter
// 2's instead of duplicating. The reply contract is exactly the A12 threads
// section, so parseExtractionResponse reads it unchanged (a missing facts/states
// key parses as empty).
export function scanThreadsPrompt(args: {
  chapterTitle: string;
  chapterNumber: number;
  text: string;
  summary: string | null;
  openThreads: string[]; // the book's existing open threads (attach targets)
  proposedThisRun: string[]; // thread names already proposed earlier in this run
}): string {
  const threads = args.openThreads.length
    ? args.openThreads.map((t) => `- ${t}`).join("\n")
    : "(none open yet)";
  const proposed = args.proposedThisRun.length
    ? args.proposedThisRun.map((t) => `- ${t}`).join("\n")
    : "(none proposed yet in this scan)";
  const summary = args.summary && args.summary.trim() ? args.summary.trim() : "(no summary)";
  return `You are scanning a locked chapter of a novel to recover the standing story threads it touches: the arcs, mysteries, promises, and relationships running through the book. This chapter was written before threads were tracked, so its touches were never recorded. Read the chapter and propose which threads it advances, complicates, pays off, or mentions.

When the chapter touches one of the OPEN THREADS listed below, reuse that thread's exact name and set isNew to false, so the touch attaches to the existing thread instead of duplicating it. When it touches a thread you ALREADY PROPOSED earlier in this scan, reuse that exact name too, so a recurring line is one thread across chapters rather than many. Only propose a new thread (isNew true, with a type) for a genuinely new arc, mystery, promise, or relationship. Do NOT invent threads for incidental beats.

CHAPTER ${args.chapterNumber}
Title: ${args.chapterTitle}

SUMMARY
${summary}

TEXT
${args.text}

OPEN THREADS
${threads}

ALREADY PROPOSED THIS SCAN
${proposed}

Return ONLY a JSON object with this exact shape, and nothing else:
{
  "threads": [
    { "thread": "the thread name", "isNew": true, "type": "arc | mystery | promise | relationship", "kind": "advance | complicate | payoff | mention", "evidence": "a short verbatim quote from the text" }
  ]
}
Use an empty array if the chapter touches no threads. Do not use em-dashes anywhere. No prose outside the JSON.`;
}

// Consistency sweep for one locked chapter. A4.1 splits the prompt so the locked
// canon (identical for every chapter in a run) is a cacheable shared prefix and
// only the per-chapter text is the variable remainder. sweepPrefix builds the
// prefix once; sweepChapterPrompt builds each chapter's remainder. runSweep sends
// the prefix as promptPrefix so chapters 2..N read from the cache.
export function sweepPrefix(lockedCanon: string[]): string {
  const canon = lockedCanon.length
    ? lockedCanon.map((c, i) => `[${i + 1}] ${c}`).join("\n")
    : "(none)";
  return `You are running an adversarial consistency sweep on one chapter of a novel. Compare the chapter text against the locked canon and report ONLY contradictions: places where the text states or implies something that conflicts with a locked fact. Do not report style, quality, or missing detail. If there are no contradictions, return an empty array.

LOCKED CANON
${canon}`;
}

export function sweepChapterPrompt(args: {
  chapterNumber: number;
  chapterTitle: string;
  text: string;
}): string {
  return `CHAPTER ${args.chapterNumber}: ${args.chapterTitle}
TEXT
${args.text}

Return ONLY a JSON array with this exact shape, and nothing else:
[
  { "chapter": ${args.chapterNumber}, "quote": "the verbatim conflicting text from the chapter", "conflicting_fact": "the canon fact it conflicts with, or a one-line description", "severity": "low | medium | high" }
]
Return [] if there are no contradictions. Do not use em-dashes. No prose outside the JSON.`;
}

// Series-bible extraction (Amendment A3). Reads a pasted chunk of the author's
// story bible plus the current canon list and tracked character names (to avoid
// duplicate proposals) and returns a single JSON object carrying new-fact,
// character, and character-state proposals. Nothing is written from this; the
// caller renders proposals for the approval checklist.
export function bibleExtractionPrompt(args: {
  text: string;
  currentCanon: string[];
  knownCharacters: string[];
}): string {
  const canon = args.currentCanon.length
    ? args.currentCanon.map((c) => `- ${c}`).join("\n")
    : "(none yet)";
  const chars = args.knownCharacters.length
    ? args.knownCharacters.map((c) => `- ${c}`).join("\n")
    : "(none tracked yet)";
  return `You are importing an author's story bible for a fantasy series: the accumulated world rules, character sheets, timeline notes, and standing decisions that never lived in any chapter. Read the bible text below and propose three things as structured data:

1. Canon facts the bible establishes: world rules, style rules, timeline events, durable character facts, and authorial plot decisions. Do NOT restate a fact already in the current canon below.

2. Characters the bible describes, with any of: a one-line role, voice rules (dialect, verbal tics, what they would never say), physical description, and notes. Use the exact tracked name when a character is already tracked below, so it can be matched instead of duplicated.

3. Character-state facts the bible gives as a starting point: what a named character knows, feels, or is hiding at the start. Only propose states for characters you also list in the characters array or that are already tracked.

BIBLE TEXT
${args.text}

CURRENT CANON
${canon}

TRACKED CHARACTERS
${chars}

Return ONLY a JSON object with this exact shape, and nothing else:
{
  "facts": [
    { "type": "world_rule | style_rule | timeline_event | character_fact | plot_decision", "content": "the fact, one sentence" }
  ],
  "characters": [
    { "name": "the character name", "role": "one line or empty", "voice_rules": "voice constraints or empty", "physical": "physical description or empty", "notes": "notes or empty" }
  ],
  "states": [
    { "character": "the character name", "knows": "what they know or empty", "feels": "how they feel or empty", "hiding": "what they hide or empty" }
  ]
}
Use an empty array for any section with nothing to propose. Do not use em-dashes anywhere. No prose outside the JSON.`;
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
