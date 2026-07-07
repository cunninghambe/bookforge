import { describe, it, expect } from "vitest";
import { extractMarkers } from "@/lib/llm/markers";

describe("extractMarkers", () => {
  it("strips MISSING FACT and CANON TENSION lines and collects them", () => {
    const text = [
      "The scene body is here.",
      "It has two paragraphs.",
      "[MISSING FACT]: the distance to the gate is unknown",
      "[CANON TENSION]: the beat says noon but canon says the sun set",
    ].join("\n");
    const r = extractMarkers(text);
    expect(r.missingFacts).toEqual(["the distance to the gate is unknown"]);
    expect(r.canonTensions).toEqual([
      "the beat says noon but canon says the sun set",
    ]);
    expect(r.clean).toBe("The scene body is here.\nIt has two paragraphs.");
    expect(r.clean).not.toContain("[MISSING FACT]");
  });

  it("returns empty marker lists when there are none", () => {
    const r = extractMarkers("Just prose, nothing flagged.");
    expect(r.missingFacts).toEqual([]);
    expect(r.canonTensions).toEqual([]);
    expect(r.clean).toBe("Just prose, nothing flagged.");
  });
});
