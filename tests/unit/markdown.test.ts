import { describe, it, expect } from "vitest";
import { parseEmphasis, stripEmphasis } from "@/lib/markdown";

// A21: the emphasis parser is display-only and must never disturb offsets. Every
// segment's rawStart is an exact offset into the raw input, the segments tile the
// input in order, and stripEmphasis is derived from the same segmentation. These
// tests pin the parsing rules (italic, bold, both marker families, restraint on
// space-flanked and unmatched markers) and the two structural invariants.

// Asserts the structural invariants for any input: each segment's visible text is
// exactly the raw slice at [rawStart, rawStart + len), the rawStarts are strictly
// ordered, and concatenating the visible text equals stripEmphasis(input).
function expectWellFormed(input: string) {
  const segs = parseEmphasis(input);
  let joined = "";
  let prevEnd = 0;
  for (const seg of segs) {
    // rawStart lands on the segment's first visible character.
    expect(input.slice(seg.rawStart, seg.rawStart + seg.text.length)).toBe(
      seg.text,
    );
    // Segments advance through the raw input in order (markers may sit between).
    expect(seg.rawStart).toBeGreaterThanOrEqual(prevEnd);
    prevEnd = seg.rawStart + seg.text.length;
    joined += seg.text;
  }
  expect(joined).toBe(stripEmphasis(input));
  return segs;
}

describe("parseEmphasis: emphasis kinds", () => {
  it("reads single-asterisk italic", () => {
    const segs = parseEmphasis("You're *in* it,");
    expect(segs).toEqual([
      { text: "You're ", kind: "plain", rawStart: 0 },
      { text: "in", kind: "italic", rawStart: 8 },
      { text: " it,", kind: "plain", rawStart: 11 },
    ]);
    expect(stripEmphasis("You're *in* it,")).toBe("You're in it,");
  });

  it("reads double-asterisk bold", () => {
    const segs = parseEmphasis("the **word** now");
    expect(segs).toEqual([
      { text: "the ", kind: "plain", rawStart: 0 },
      { text: "word", kind: "bold", rawStart: 6 },
      { text: " now", kind: "plain", rawStart: 12 },
    ]);
    expect(stripEmphasis("the **word** now")).toBe("the word now");
  });

  it("reads underscore italic and underscore bold", () => {
    expect(parseEmphasis("a _b_ c")).toEqual([
      { text: "a ", kind: "plain", rawStart: 0 },
      { text: "b", kind: "italic", rawStart: 3 },
      { text: " c", kind: "plain", rawStart: 5 },
    ]);
    expect(parseEmphasis("a __b__ c")).toEqual([
      { text: "a ", kind: "plain", rawStart: 0 },
      { text: "b", kind: "bold", rawStart: 4 },
      { text: " c", kind: "plain", rawStart: 7 },
    ]);
    expect(stripEmphasis("a _b_ c")).toBe("a b c");
    expect(stripEmphasis("a __b__ c")).toBe("a b c");
  });

  it("reads multiple spans in one paragraph", () => {
    const input = "a *b* c **d** e";
    const segs = expectWellFormed(input);
    expect(segs.map((s) => `${s.kind}:${s.text}`)).toEqual([
      "plain:a ",
      "italic:b",
      "plain: c ",
      "bold:d",
      "plain: e",
    ]);
    expect(stripEmphasis(input)).toBe("a b c d e");
  });
});

describe("parseEmphasis: markdown restraint leaves markers literal", () => {
  it("leaves an unmatched open marker literal", () => {
    expect(parseEmphasis("a *b")).toEqual([
      { text: "a *b", kind: "plain", rawStart: 0 },
    ]);
    expect(stripEmphasis("a *b")).toBe("a *b");
  });

  it("leaves a lone asterisk literal (arithmetic, bullets)", () => {
    expect(stripEmphasis("5 * 3 = 15")).toBe("5 * 3 = 15");
    expect(parseEmphasis("5 * 3 = 15")).toEqual([
      { text: "5 * 3 = 15", kind: "plain", rawStart: 0 },
    ]);
  });

  it("treats a space right after the open as literal", () => {
    expect(stripEmphasis("* not emphasis*")).toBe("* not emphasis*");
  });

  it("treats a space right before the close as literal", () => {
    expect(stripEmphasis("*not emphasis *")).toBe("*not emphasis *");
  });

  it("leaves apostrophes and hyphens untouched", () => {
    const input = "don't fence me in, it's well-known and self-made";
    expect(stripEmphasis(input)).toBe(input);
    expect(parseEmphasis(input)).toEqual([
      { text: input, kind: "plain", rawStart: 0 },
    ]);
  });

  it("keeps intraword underscores literal when unmatched", () => {
    expect(stripEmphasis("snake_case_name")).toBe("snake_case_name");
  });
});

describe("parseEmphasis: structural invariants", () => {
  it("returns no segments for an empty string", () => {
    expect(parseEmphasis("")).toEqual([]);
    expect(stripEmphasis("")).toBe("");
  });

  it("never throws and tiles the raw input for varied inputs", () => {
    const inputs = [
      "",
      "plain",
      "*",
      "**",
      "***word***",
      "*a* *b* *c*",
      "**bold** and *italic* together",
      "mix *of* **kinds** and _under_ __scores__",
      "trailing *",
      "* leading",
      "line one\n\n*emph* on line two",
      "edge*case*with*many*stars",
    ];
    for (const input of inputs) {
      expect(() => parseEmphasis(input)).not.toThrow();
      expectWellFormed(input);
    }
  });

  it("preserves paragraph breaks inside plain segments (raw offsets intact)", () => {
    const input = "First *para*.\n\nSecond plain para.";
    const segs = expectWellFormed(input);
    // The offset of "Second" in the visible text differs from its raw offset only
    // by the two removed markers, and rawStart proves the raw location.
    const secondPara = segs[segs.length - 1];
    expect(secondPara.kind).toBe("plain");
    expect(input.slice(secondPara.rawStart)).toContain("Second plain para.");
  });
});
