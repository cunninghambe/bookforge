import { describe, it, expect } from "vitest";
import {
  splitParagraphs,
  paragraphRanges,
  paragraphIndexForOffset,
  openingSentence,
} from "@/lib/audio/paragraphs";

describe("splitParagraphs: stable boundaries and edge cases", () => {
  it("returns [] for empty or whitespace-only content", () => {
    expect(splitParagraphs("")).toEqual([]);
    expect(splitParagraphs("   \n  \n\t")).toEqual([]);
  });

  it("splits on blank lines and keeps interior single newlines", () => {
    expect(splitParagraphs("One.\n\nTwo.")).toEqual(["One.", "Two."]);
    expect(splitParagraphs("A line\nsame paragraph\n\nNext.")).toEqual([
      "A line\nsame paragraph",
      "Next.",
    ]);
  });

  it("collapses runs of blank lines and trims each paragraph", () => {
    expect(splitParagraphs("A.\n\n\n\nB.")).toEqual(["A.", "B."]);
    expect(splitParagraphs("  A.  \n\n   B.   ")).toEqual(["A.", "B."]);
    // A blank line that carries trailing spaces still separates.
    expect(splitParagraphs("A.\n   \nB.")).toEqual(["A.", "B."]);
  });

  it("treats a single block as one paragraph", () => {
    expect(splitParagraphs("Just one paragraph here.")).toEqual([
      "Just one paragraph here.",
    ]);
  });

  it("is stable: splitting the same content twice yields the same boundaries", () => {
    const content = "P one.\n\nP two is longer.\n\nP three.";
    expect(splitParagraphs(content)).toEqual(splitParagraphs(content));
  });
});

describe("paragraphRanges: offsets into the original content", () => {
  it("reports the trimmed text at its true offset in the source", () => {
    const content = "  First.  \n\n  Second sentence.  ";
    const ranges = paragraphRanges(content);
    expect(ranges).toHaveLength(2);
    for (const r of ranges) {
      expect(content.slice(r.start, r.end)).toBe(r.text);
    }
    expect(ranges[0].text).toBe("First.");
    expect(ranges[1].text).toBe("Second sentence.");
  });
});

describe("paragraphIndexForOffset", () => {
  const content = "First paragraph.\n\nSecond paragraph.\n\nThird one.";
  it("maps an offset inside a paragraph to that paragraph's index", () => {
    expect(paragraphIndexForOffset(content, 0)).toBe(0);
    expect(paragraphIndexForOffset(content, content.indexOf("Second"))).toBe(1);
    expect(paragraphIndexForOffset(content, content.indexOf("Third"))).toBe(2);
  });
  it("clamps an offset past the end to the last paragraph, and empty to 0", () => {
    expect(paragraphIndexForOffset(content, content.length + 50)).toBe(2);
    expect(paragraphIndexForOffset("", 5)).toBe(0);
  });
});

describe("openingSentence: verbatim anchor prefix", () => {
  it("takes the first sentence up to terminal punctuation", () => {
    expect(openingSentence("She ran. Then she stopped.")).toBe("She ran.");
    expect(openingSentence("Wait! Who is there?")).toBe("Wait!");
  });
  it("returns the whole paragraph when there is no sentence terminator", () => {
    expect(openingSentence("a fragment with no end")).toBe(
      "a fragment with no end",
    );
  });
  it("is always a verbatim prefix of the paragraph", () => {
    const para = "The gate stood open, and no one guarded it. She went in.";
    expect(para.startsWith(openingSentence(para))).toBe(true);
  });
  it("does not split on a decimal point mid-number", () => {
    expect(openingSentence("It cost 3.50 that day. She paid.")).toBe(
      "It cost 3.50 that day.",
    );
  });
});
