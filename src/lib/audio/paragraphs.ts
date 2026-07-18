// The single source of paragraph boundaries for A14 (listen and voice notes).
// Both the synthesis path (manifest and per-paragraph audio) and the voice-note
// anchoring logic split a draft into paragraphs through THIS module, so a paragraph
// index means the same thing everywhere. A paragraph is a block of prose separated
// from the next by a blank line, which is exactly what the reader sees on the
// whitespace-pre-wrap review and draft surfaces. Pure and unit-tested.

export interface ParagraphRange {
  // Offsets into the ORIGINAL content of the trimmed paragraph text.
  start: number;
  end: number;
  text: string;
}

// The one boundary computation. Splits content on blank lines (interior single
// newlines stay inside a paragraph), trims each block, drops empties, and reports
// each surviving paragraph's text and its offsets in the original content. Every
// other export here is derived from this, so there is a single source of truth.
export function paragraphRanges(content: string): ParagraphRange[] {
  const ranges: ParagraphRange[] = [];
  if (!content) return ranges;
  const sep = /\n[ \t]*\n/g;
  let last = 0;
  const pushBlock = (rawStart: number, rawEnd: number) => {
    const raw = content.slice(rawStart, rawEnd);
    const trimmed = raw.trim();
    if (trimmed.length === 0) return;
    const leading = raw.length - raw.trimStart().length;
    const start = rawStart + leading;
    ranges.push({ start, end: start + trimmed.length, text: trimmed });
  };
  let m: RegExpExecArray | null;
  while ((m = sep.exec(content)) !== null) {
    pushBlock(last, m.index);
    last = m.index + m[0].length;
  }
  pushBlock(last, content.length);
  return ranges;
}

// The paragraph texts of a draft, in order. Returns [] for empty or
// whitespace-only content, so an undrafted chapter has zero paragraphs.
export function splitParagraphs(content: string): string[] {
  return paragraphRanges(content).map((r) => r.text);
}

// The paragraph index containing (or nearest before) a character offset, used on
// the review surface to turn a text selection into the paragraph a voice note
// targets. A selection inside the blank-line gap is attributed to the following
// paragraph; an offset before the first paragraph maps to 0.
export function paragraphIndexForOffset(content: string, offset: number): number {
  const ranges = paragraphRanges(content);
  if (ranges.length === 0) return 0;
  for (let i = 0; i < ranges.length; i += 1) {
    if (offset < ranges[i].end) return i;
  }
  return ranges.length - 1;
}

// The opening sentence of a paragraph, used as the verbatim anchor (quoted_text)
// for a voice-note comment. Ends at the first sentence terminator (. ! ?) that is
// followed by whitespace or the end of the paragraph; failing that, the whole
// paragraph. Long first sentences are capped at a word boundary so the anchor
// stays a manageable highlight. The result is always a verbatim prefix of the
// paragraph, so it is a verbatim substring of the draft and findSpan can locate it.
const ANCHOR_CAP = 200;

export function openingSentence(paragraph: string): string {
  const trimmed = paragraph.trim();
  if (trimmed === "") return "";
  const m = trimmed.match(/^[\s\S]*?[.!?](?=\s|$)/);
  let sentence = m ? m[0].trim() : trimmed;
  if (sentence.length > ANCHOR_CAP) {
    const slice = sentence.slice(0, ANCHOR_CAP);
    const lastSpace = slice.lastIndexOf(" ");
    sentence = lastSpace > 0 ? slice.slice(0, lastSpace) : slice;
  }
  return sentence;
}
