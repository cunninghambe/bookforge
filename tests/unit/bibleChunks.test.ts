import { describe, it, expect } from "vitest";
import { chunkBible } from "@/lib/bibleChunks";

describe("chunkBible", () => {
  it("returns a single chunk for a short bible", () => {
    const r = chunkBible("A short bible.\n\nWith two paragraphs.");
    expect(r).toHaveLength(1);
    expect(r[0]).toContain("A short bible.");
    expect(r[0]).toContain("With two paragraphs.");
  });

  it("splits on paragraph boundaries when the combined length is over the cap", () => {
    const p1 = "A".repeat(15000);
    const p2 = "B".repeat(15000);
    // Default cap is ~24,000; the two paragraphs together (30,002) exceed it.
    const r = chunkBible(`${p1}\n\n${p2}`);
    expect(r).toHaveLength(2);
    expect(r[0]).toBe(p1);
    expect(r[1]).toBe(p2);
  });

  it("packs whole paragraphs up to the cap, never splitting one mid-paragraph", () => {
    const p1 = "A".repeat(10000);
    const p2 = "B".repeat(10000);
    const p3 = "C".repeat(10000);
    const r = chunkBible(`${p1}\n\n${p2}\n\n${p3}`, 24000);
    // p1 + p2 (20,002) fit in one chunk; adding p3 would exceed the cap.
    expect(r).toHaveLength(2);
    // Every original paragraph appears intact within exactly one chunk.
    for (const p of [p1, p2, p3]) {
      const containing = r.filter((c) => c.includes(p));
      expect(containing).toHaveLength(1);
    }
  });

  it("keeps an oversized single paragraph whole in its own chunk", () => {
    const big = "X".repeat(30000);
    const small = "a small trailing paragraph";
    const r = chunkBible(`${big}\n\n${small}`, 24000);
    expect(r).toHaveLength(2);
    expect(r[0]).toBe(big); // not cut down to the cap
    expect(r[0].length).toBe(30000);
    expect(r[1]).toBe(small);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(chunkBible("   \n\n   \n\n")).toHaveLength(0);
  });
});
