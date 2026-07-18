import { describe, it, expect } from "vitest";
import { anchorForParagraph } from "@/lib/audio/anchor";
import { findSpan } from "@/lib/revision/spans";

const CONTENT =
  "Mara crossed the bridge at dawn. She did not look back.\n\n" +
  "Kesh waited on the far bank. He had waited a long time.";

describe("anchorForParagraph: transcript-to-comment anchoring", () => {
  it("anchors to the opening sentence of the target paragraph", () => {
    const a = anchorForParagraph(CONTENT, 0);
    expect(a?.quotedText).toBe("Mara crossed the bridge at dawn.");
    const a1 = anchorForParagraph(CONTENT, 1);
    expect(a1?.quotedText).toBe("Kesh waited on the far bank.");
  });

  it("resolves offsets that locate the quoted text verbatim in the draft", () => {
    const a = anchorForParagraph(CONTENT, 1);
    expect(a).not.toBeNull();
    expect(a!.spanStart).not.toBeNull();
    expect(CONTENT.slice(a!.spanStart!, a!.spanEnd!)).toBe(a!.quotedText);
    // And it agrees with the shared findSpan primitive.
    expect(findSpan(CONTENT, a!.quotedText)).toEqual({
      start: a!.spanStart,
      end: a!.spanEnd,
    });
  });

  it("returns null for an out-of-range paragraph index", () => {
    expect(anchorForParagraph(CONTENT, 2)).toBeNull();
    expect(anchorForParagraph(CONTENT, -1)).toBeNull();
    expect(anchorForParagraph("", 0)).toBeNull();
  });
});
