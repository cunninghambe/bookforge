import { describe, it, expect } from "vitest";
import { validatePinChapter, pinRangeLabel } from "@/lib/chatPin";

// Amendment A5.1b: the pin form accepted chapter 13 in a four-chapter book. The
// pinned chapter must fall in [1, chapter count of the selected book].
describe("validatePinChapter", () => {
  it("accepts a chapter inside the range", () => {
    const v = validatePinChapter(3, 4);
    expect(v.valid).toBe(true);
    expect(v.min).toBe(1);
    expect(v.max).toBe(4);
    expect(v.clamped).toBe(3);
  });

  it("accepts the first and last chapters (inclusive bounds)", () => {
    expect(validatePinChapter(1, 4).valid).toBe(true);
    expect(validatePinChapter(4, 4).valid).toBe(true);
  });

  it("rejects a chapter past the last one and clamps it down (the reported bug)", () => {
    const v = validatePinChapter(13, 4);
    expect(v.valid).toBe(false);
    expect(v.clamped).toBe(4);
    expect(v.max).toBe(4);
  });

  it("rejects a chapter below 1 and clamps it up", () => {
    const v = validatePinChapter(0, 4);
    expect(v.valid).toBe(false);
    expect(v.clamped).toBe(1);
  });

  it("rejects non-integer chapters", () => {
    expect(validatePinChapter(2.5, 4).valid).toBe(false);
    expect(validatePinChapter(NaN, 4).valid).toBe(false);
  });

  it("rejects anything for a book with no chapters and clamps to the minimum", () => {
    const v = validatePinChapter(1, 0);
    expect(v.valid).toBe(false);
    expect(v.max).toBe(0);
    expect(v.clamped).toBe(1);
  });
});

describe("pinRangeLabel", () => {
  it("renders the inclusive range", () => {
    expect(pinRangeLabel(4)).toBe("1 to 4");
    expect(pinRangeLabel(1)).toBe("1 to 1");
  });

  it("notes an empty book", () => {
    expect(pinRangeLabel(0)).toBe("no chapters yet");
  });
});
