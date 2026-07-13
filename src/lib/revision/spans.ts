// Span anchoring. quoted_text is the source of truth for a comment's location;
// offsets are cached best-effort and recomputed by string search on load. A cached
// hint offset is trusted only when the text still matches there exactly, otherwise
// we fall back to the first string-search occurrence. This keeps the anchor stable
// across re-renders and lets the diff classifier locate flagged spans in old text.

export interface Span {
  start: number;
  end: number;
}

// Finds quotedText inside text. If hint is a valid offset where quotedText still
// sits verbatim, it wins (disambiguates repeated phrases); otherwise the first
// occurrence is used. Returns null when quotedText is empty or absent.
export function findSpan(
  text: string,
  quotedText: string,
  hint?: number | null,
): Span | null {
  if (!quotedText) return null;
  if (
    typeof hint === "number" &&
    hint >= 0 &&
    text.slice(hint, hint + quotedText.length) === quotedText
  ) {
    return { start: hint, end: hint + quotedText.length };
  }
  const idx = text.indexOf(quotedText);
  if (idx < 0) return null;
  return { start: idx, end: idx + quotedText.length };
}
