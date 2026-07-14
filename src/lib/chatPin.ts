// Pin validation for character chat (Amendment A5.1b). The live drive accepted
// chapter 13 in a four-chapter book. A pinned chapter must fall in
// [1, number of chapters in the selected book]; pinning past the last chapter is
// not a use case v1 supports (the last chapter means "end of book so far"). This
// pure helper is the single place the range is decided, used by the chat page/
// component (to clamp and show the range), the chat route, and the MCP
// character_chat tool (to reject an out-of-range pin with a clear error).

export interface PinValidation {
  // True only when uiChapter is a whole number inside [min, max].
  valid: boolean;
  // Always 1: the first chapter.
  min: number;
  // The number of chapters in the book. 0 when the book has no chapters yet.
  max: number;
  // uiChapter clamped into [min, max]. Falls back to min when there are no
  // chapters to pin to.
  clamped: number;
}

// Validates a 1-based pinned chapter against a book's chapter count. chapterCount
// is the total number of chapters in the selected book (A2 1-based convention: the
// valid range is 1..chapterCount).
export function validatePinChapter(
  uiChapter: number,
  chapterCount: number,
): PinValidation {
  const max = chapterCount > 0 ? chapterCount : 0;
  const min = 1;
  const valid =
    Number.isInteger(uiChapter) &&
    max >= 1 &&
    uiChapter >= min &&
    uiChapter <= max;
  const clamped =
    max < 1 ? min : Math.min(Math.max(Math.round(uiChapter) || min, min), max);
  return { valid, min, max, clamped };
}

// A one-line human-readable range for the UI and for error messages, e.g.
// "1 to 4", or a clear note when the book has no chapters yet.
export function pinRangeLabel(chapterCount: number): string {
  return chapterCount > 0 ? `1 to ${chapterCount}` : "no chapters yet";
}
