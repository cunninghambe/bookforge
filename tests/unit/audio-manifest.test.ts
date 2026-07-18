import { describe, it, expect } from "vitest";
import { buildManifest } from "@/lib/audio/manifest";
import { cacheKey } from "@/lib/audio/cache";

describe("buildManifest: shape and per-paragraph cache state", () => {
  const content = "First paragraph.\n\nSecond, a bit longer paragraph.";

  it("reports the paragraph count, format, and one entry per paragraph", () => {
    const m = buildManifest({
      chapterId: 7,
      content,
      voiceId: "default",
      format: "opus",
      ext: "opus",
      probeCached: () => false,
    });
    expect(m.chapterId).toBe(7);
    expect(m.format).toBe("opus");
    expect(m.paragraphCount).toBe(2);
    expect(m.paragraphs).toHaveLength(2);
    expect(m.paragraphs[0]).toEqual({ index: 0, chars: "First paragraph.".length, cached: false });
    expect(m.paragraphs[1].index).toBe(1);
    expect(m.paragraphs.every((p) => p.cached === false)).toBe(true);
  });

  it("marks a paragraph cached when the probe finds its key", () => {
    const firstKey = cacheKey("First paragraph.", "default");
    const m = buildManifest({
      chapterId: 1,
      content,
      voiceId: "default",
      format: "wav",
      ext: "wav",
      probeCached: (key) => key === firstKey,
    });
    expect(m.paragraphs[0].cached).toBe(true);
    expect(m.paragraphs[1].cached).toBe(false);
  });

  it("is empty for an undrafted chapter", () => {
    const m = buildManifest({
      chapterId: 2,
      content: "",
      voiceId: "default",
      format: "wav",
      ext: "wav",
      probeCached: () => true,
    });
    expect(m.paragraphCount).toBe(0);
    expect(m.paragraphs).toEqual([]);
  });
});
