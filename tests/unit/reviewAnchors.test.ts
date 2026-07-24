import { describe, it, expect } from "vitest";
import { parseEmphasis } from "@/lib/markdown";
import { decorateSegments, type ReviewAnchor } from "@/lib/reviewAnchors";

// A22.3: anchor decoration is a pure function layered on the A21 parser. It splits
// the emphasis segments at anchor boundaries and tags each finer segment with the
// ids of the anchors that cover it, while every finer segment keeps a correct
// rawStart so the data-raw-start tiling (and therefore selection mapping) is
// untouched. These tests pin the split behavior and the two structural invariants.

// Asserts, for any decoration: concatenating the visible text reproduces the raw
// content's stripped text, each finer segment's text is exactly the raw slice at
// [rawStart, rawStart + len), and the rawStarts advance in order.
function expectTiles(content: string, decorated: ReturnType<typeof decorateSegments>) {
  let joined = "";
  let prevEnd = 0;
  for (const seg of decorated) {
    expect(content.slice(seg.rawStart, seg.rawStart + seg.text.length)).toBe(
      seg.text,
    );
    expect(seg.rawStart).toBeGreaterThanOrEqual(prevEnd);
    prevEnd = seg.rawStart + seg.text.length;
    joined += seg.text;
  }
  let stripped = "";
  for (const s of parseEmphasis(content)) stripped += s.text;
  expect(joined).toBe(stripped);
}

describe("decorateSegments: no anchors yields A21 segments verbatim", () => {
  it("returns the parseEmphasis segments with empty anchorIds", () => {
    const content = "the **word** now and *then*";
    const decorated = decorateSegments(content, []);
    expect(
      decorated.map(({ text, kind, rawStart }) => ({ text, kind, rawStart })),
    ).toEqual(parseEmphasis(content));
    expect(decorated.every((s) => s.anchorIds.length === 0)).toBe(true);
    expectTiles(content, decorated);
  });

  it("returns nothing for empty content", () => {
    expect(decorateSegments("", [])).toEqual([]);
    expect(decorateSegments("", [{ id: 1, start: 0, end: 0, kind: "comment" }])).toEqual(
      [],
    );
  });
});

describe("decorateSegments: an anchor inside an emphasis run splits it", () => {
  it("splits an italic run into covered and uncovered pieces, all italic", () => {
    const content = "*abcdef* z"; // italic 'abcdef' at raw 1..7, plain ' z' at 8..10
    const anchors: ReviewAnchor[] = [{ id: 7, start: 3, end: 5, kind: "comment" }];
    const decorated = decorateSegments(content, anchors);
    expect(
      decorated.map((s) => ({
        text: s.text,
        kind: s.kind,
        rawStart: s.rawStart,
        anchorIds: s.anchorIds,
      })),
    ).toEqual([
      { text: "ab", kind: "italic", rawStart: 1, anchorIds: [] },
      { text: "cd", kind: "italic", rawStart: 3, anchorIds: [7] },
      { text: "ef", kind: "italic", rawStart: 5, anchorIds: [] },
      { text: " z", kind: "plain", rawStart: 8, anchorIds: [] },
    ]);
    expectTiles(content, decorated);
  });

  it("covers a whole emphasized word", () => {
    const content = "the **word** now"; // bold 'word' at raw 6..10
    const decorated = decorateSegments(content, [
      { id: 3, start: 6, end: 10, kind: "suggestion" },
    ]);
    const bold = decorated.find((s) => s.kind === "bold");
    expect(bold).toMatchObject({ text: "word", rawStart: 6, anchorIds: [3] });
    // The surrounding plain runs carry no anchor.
    for (const s of decorated.filter((s) => s.kind === "plain")) {
      expect(s.anchorIds).toEqual([]);
    }
  });
});

describe("decorateSegments: anchors spanning segment boundaries", () => {
  it("tags every finer piece a boundary-spanning anchor covers", () => {
    const content = "a *b* c"; // plain 'a '(0..2), italic 'b'(3..4), plain ' c'(5..7)
    // The anchor covers raw 0..4: the plain 'a ' and the italic 'b', across the
    // opening marker gap in between.
    const decorated = decorateSegments(content, [
      { id: 9, start: 0, end: 4, kind: "comment" },
    ]);
    const byText = new Map(decorated.map((s) => [s.text, s.anchorIds]));
    expect(byText.get("a ")).toEqual([9]);
    expect(byText.get("b")).toEqual([9]);
    expect(byText.get(" c")).toEqual([]);
    expectTiles(content, decorated);
  });

  it("splits a plain run at an anchor boundary", () => {
    const content = "hello world";
    const decorated = decorateSegments(content, [
      { id: 1, start: 0, end: 5, kind: "comment" },
    ]);
    expect(
      decorated.map((s) => ({ text: s.text, anchorIds: s.anchorIds })),
    ).toEqual([
      { text: "hello", anchorIds: [1] },
      { text: " world", anchorIds: [] },
    ]);
  });
});

describe("decorateSegments: overlapping anchors", () => {
  it("lists every covering anchor id on the shared region", () => {
    const content = "abcdefgh";
    const decorated = decorateSegments(content, [
      { id: 1, start: 0, end: 5, kind: "comment" },
      { id: 2, start: 3, end: 8, kind: "suggestion" },
    ]);
    expect(
      decorated.map((s) => ({ text: s.text, anchorIds: s.anchorIds })),
    ).toEqual([
      { text: "abc", anchorIds: [1] },
      { text: "de", anchorIds: [1, 2] },
      { text: "fgh", anchorIds: [2] },
    ]);
    expectTiles(content, decorated);
  });
});
