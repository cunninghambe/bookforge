// A21: markdown emphasis interpretation, a DISPLAY concern only. The stored draft
// content is always raw markdown (the source of truth the draft editor edits and
// the export emits); this module is the single source of truth for two derived
// views of that raw text: the emphasis segments the review surface renders, and the
// marker-stripped text the TTS bridge speaks. It never changes an offset. For every
// segment parseEmphasis reports the RAW offset of the segment's first visible
// character, so the review surface can map a DOM selection back to a raw content
// offset exactly and comment quotedText stays byte-identical to today. Pure and
// unit-tested: it never throws and never drops or reorders a visible character.

export type EmphasisKind = "plain" | "italic" | "bold";

export interface EmphasisSegment {
  // The segment's VISIBLE text, with any surrounding emphasis markers removed.
  text: string;
  kind: EmphasisKind;
  // The offset in the RAW input of this visible text's first character (past any
  // leading marker). For a plain run it is the run's start; for an emphasized run
  // it is the first content character just after the opening marker. Because a
  // segment's visible text is a contiguous run of the raw input, rawStart plus an
  // offset within the visible text is an exact raw offset.
  rawStart: number;
}

function isSpace(ch: string | undefined): boolean {
  return (
    ch === " " ||
    ch === "\t" ||
    ch === "\n" ||
    ch === "\r" ||
    ch === "\f" ||
    ch === "\v"
  );
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

interface Match {
  kind: "italic" | "bold";
  text: string;
  rawStart: number; // index of the first visible character
  rawEnd: number; // index just past the closing marker
}

// Try to read a well-formed emphasis span opening exactly at index i. Returns null
// when i is not the start of a valid span, so the caller leaves that character as
// literal text (standard markdown restraint). The rules: bold is `**` or `__`,
// italic is `*` or `_`; a marker with no matching close, a space right after the
// open or right before the close, or a lone marker, is literal, never a broken
// segment. Apostrophes and hyphens are not markers, so they are untouched.
function matchEmphasis(text: string, i: number): Match | null {
  const c = text[i];
  if (c !== "*" && c !== "_") return null;
  const bold = text[i + 1] === c;
  const markerLen = bold ? 2 : 1;
  const contentStart = i + markerLen;
  const first = text[contentStart];
  // Nothing after the marker, or whitespace right after the open, is literal; a
  // lone marker at the end of the string falls out here too.
  if (first === undefined || isSpace(first)) return null;
  // Underscores do not open emphasis inside a word (snake_case_name stays literal),
  // the standard markdown restraint; asterisks legitimately work intraword.
  if (c === "_" && isWordChar(text[i - 1])) return null;

  // Scan for the matching close: the same marker, with a non-space immediately
  // before it and at least one character of content in between. In bold mode a
  // single marker character is content; only a doubled marker closes. An
  // underscore close is likewise not recognized inside a word.
  for (let j = contentStart; j < text.length; j += 1) {
    if (text[j] !== c) continue;
    if (bold && text[j + 1] !== c) continue;
    if (j <= contentStart) continue;
    if (isSpace(text[j - 1])) continue;
    if (c === "_" && isWordChar(text[j + markerLen])) continue;
    return {
      kind: bold ? "bold" : "italic",
      text: text.slice(contentStart, j),
      rawStart: contentStart,
      rawEnd: j + markerLen,
    };
  }
  return null;
}

// Ordered segments that tile `text` in raw order: concatenating their visible
// `text` yields stripEmphasis(text), and each segment's rawStart is an exact offset
// into the raw input. An empty input yields no segments.
export function parseEmphasis(text: string): EmphasisSegment[] {
  const segments: EmphasisSegment[] = [];
  let plainStart = 0;
  let i = 0;
  const flushPlain = (end: number) => {
    if (end > plainStart) {
      segments.push({
        text: text.slice(plainStart, end),
        kind: "plain",
        rawStart: plainStart,
      });
    }
  };
  while (i < text.length) {
    const m = matchEmphasis(text, i);
    if (m) {
      flushPlain(i);
      segments.push({ text: m.text, kind: m.kind, rawStart: m.rawStart });
      i = m.rawEnd;
      plainStart = i;
    } else {
      i += 1;
    }
  }
  flushPlain(text.length);
  return segments;
}

// The visible text with all emphasis markers removed, derived from the SAME
// segmentation as parseEmphasis so the rendered surface and the spoken text can
// never disagree. This is the text handed to the synthesizer and used for its cache
// key, so the voice never speaks a marker.
export function stripEmphasis(text: string): string {
  let out = "";
  for (const seg of parseEmphasis(text)) out += seg.text;
  return out;
}
