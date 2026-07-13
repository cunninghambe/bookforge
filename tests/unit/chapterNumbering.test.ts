import { describe, it, expect } from "vitest";
import { orderToUiChapter, uiChapterToOrder } from "@/lib/chapterNumbering";

describe("chapter numbering conversion helpers (A2.1)", () => {
  it("orderToUiChapter shifts the 0-based order up to a 1-based chapter number", () => {
    expect(orderToUiChapter(0)).toBe(1);
    expect(orderToUiChapter(1)).toBe(2);
    expect(orderToUiChapter(22)).toBe(23);
  });

  it("uiChapterToOrder shifts the 1-based chapter number down to a 0-based order", () => {
    expect(uiChapterToOrder(1)).toBe(0);
    expect(uiChapterToOrder(2)).toBe(1);
    expect(uiChapterToOrder(23)).toBe(22);
  });

  it("the two helpers round-trip", () => {
    for (const order of [0, 1, 2, 5, 22, 99]) {
      expect(uiChapterToOrder(orderToUiChapter(order))).toBe(order);
    }
    for (const ui of [1, 2, 3, 6, 23, 100]) {
      expect(orderToUiChapter(uiChapterToOrder(ui))).toBe(ui);
    }
  });

  it("entering chapter 1 stores order 0, so a state effective from chapter 1 applies to the first chapter (order_index 0)", () => {
    // The A2.1 regression in miniature: the first chapter has order_index 0, and a
    // state entered as "effective from chapter 1" must store chapter_order 0 so that
    // effectiveState's chapter_order <= order_index test includes it.
    expect(uiChapterToOrder(1)).toBe(0);
  });
});
