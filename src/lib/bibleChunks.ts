// Splits a pasted story bible into sequential chunks for the importer (Amendment
// A3). Long bibles are processed one chunk per LLM call, split on paragraph
// boundaries. A paragraph is never split mid-way: a single oversized paragraph
// becomes its own chunk rather than being cut. A short bible (under the cap) is a
// single chunk. The result preserves the full paragraph text so nothing pasted is
// dropped.
//
// Amendment A20: the cap dropped from 24,000 to 2,000 characters. A 24k chunk asked
// the model for 12,000 to 15,000 output tokens, far past the deployment transport's
// per-call output cap, so the call errored after minutes (D166). Measured on the box
// with the exact extraction prompt: dense bible content produces about 0.9 output
// tokens per input character (a 2,243-char packed sample returned 2,049 tokens),
// while ordinary bible prose produces about 0.4. At 2,000 characters even the dense
// ceiling stays around 1,800 output tokens, comfortably under the 2,048-token cap
// whose breach caused the 500, and each per-chunk request completes in roughly 20 to
// 30 seconds. Smaller input chunks also shorten every per-chunk output.

// Paragraphs are separated by a blank line (one or more newlines with only
// whitespace between them). This is the natural boundary an author's bible uses.
const PARAGRAPH_SEPARATOR = /\n\s*\n/;

export const DEFAULT_BIBLE_CHUNK_CHARS = 2000;

export function chunkBible(
  text: string,
  maxChars: number = DEFAULT_BIBLE_CHUNK_CHARS,
): string[] {
  const paragraphs = text
    .split(PARAGRAPH_SEPARATOR)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);

  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
    // Start a new chunk only when the current one is non-empty and appending the
    // next paragraph would exceed the cap. An oversized single paragraph (current
    // empty) is kept whole, never split mid-paragraph.
    if (current && candidate.length > maxChars) {
      chunks.push(current);
      current = paragraph;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
