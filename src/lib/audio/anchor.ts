import { splitParagraphs, openingSentence } from "./paragraphs";
import { findSpan } from "../revision/spans";

// Voice-note anchoring. A voice note becomes an inline comment whose quoted_text is
// the opening sentence of the target paragraph (the existing quoted-text-is-truth
// semantics; offsets are a best-effort cache). This resolves the anchor from the
// same paragraph split the synthesis and manifest paths use, so the paragraph index
// the player sends means the same paragraph everywhere. Pure and unit-tested.

export interface ParagraphAnchor {
  quotedText: string;
  spanStart: number | null;
  spanEnd: number | null;
}

// Resolves the anchor for a paragraph index against a draft's content. Returns null
// when the index is out of range or the paragraph has no anchorable text.
export function anchorForParagraph(
  content: string,
  paragraphIndex: number,
): ParagraphAnchor | null {
  const paragraphs = splitParagraphs(content);
  if (paragraphIndex < 0 || paragraphIndex >= paragraphs.length) return null;
  const quotedText = openingSentence(paragraphs[paragraphIndex]);
  if (quotedText === "") return null;
  const span = findSpan(content, quotedText);
  return {
    quotedText,
    spanStart: span ? span.start : null,
    spanEnd: span ? span.end : null,
  };
}
