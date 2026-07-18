import { describe, it, expect } from "vitest";
import { cacheKey, planPrune, type PruneEntry } from "@/lib/audio/cache";

describe("cacheKey: content-addressed by text and voice", () => {
  it("is deterministic and 64 hex chars (sha256)", () => {
    const k = cacheKey("A paragraph.", "default");
    expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(k).toBe(cacheKey("A paragraph.", "default"));
  });

  it("changes when the text changes", () => {
    expect(cacheKey("A.", "v")).not.toBe(cacheKey("B.", "v"));
  });

  it("changes when the voice changes, so voices never alias", () => {
    expect(cacheKey("A.", "alice")).not.toBe(cacheKey("A.", "bob"));
  });

  it("does not alias across the voice/text boundary", () => {
    // Without a separator, ("ab","c") and ("a","bc") would collide.
    expect(cacheKey("bc", "a")).not.toBe(cacheKey("c", "ab"));
  });
});

describe("planPrune: oldest-first eviction to a cap", () => {
  const entries: PruneEntry[] = [
    { name: "old.opus", size: 100, mtimeMs: 1 },
    { name: "mid.opus", size: 100, mtimeMs: 2 },
    { name: "new.opus", size: 100, mtimeMs: 3 },
  ];

  it("evicts nothing when already within the cap", () => {
    expect(planPrune(entries, 300)).toEqual([]);
    expect(planPrune(entries, 500)).toEqual([]);
  });

  it("evicts the oldest files until under the cap", () => {
    // Total 300; cap 150 needs to drop 150+ worth, oldest first.
    expect(planPrune(entries, 150)).toEqual(["old.opus", "mid.opus"]);
  });

  it("evicts just enough, stopping as soon as it is within the cap", () => {
    expect(planPrune(entries, 250)).toEqual(["old.opus"]);
  });

  it("handles an empty directory", () => {
    expect(planPrune([], 100)).toEqual([]);
  });
});
