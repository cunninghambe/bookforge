import { describe, it, expect } from "vitest";
import { britishismWarnings, hasEmDash } from "@/lib/llm/lint";

describe("hasEmDash", () => {
  it("detects a real em-dash", () => {
    expect(hasEmDash("She paused — then spoke.")).toBe(true);
  });
  it("detects a double hyphen used as one", () => {
    expect(hasEmDash("She paused--then spoke.")).toBe(true);
    expect(hasEmDash("She paused -- then spoke.")).toBe(true);
  });
  it("passes clean prose and single hyphens", () => {
    expect(hasEmDash("A well-worn path, nothing more.")).toBe(false);
    expect(hasEmDash("Commas, colons: all fine.")).toBe(false);
  });
});

describe("britishismWarnings", () => {
  const terms = ["bloody", "knackered"];
  it("warns when a term appears outside the designated character's paragraph", () => {
    const text =
      "Julian was knackered after the climb.\n\nMara said nothing at all.";
    const w = britishismWarnings(text, {
      terms,
      designatedCharacter: "Mara",
    });
    expect(w.map((x) => x.term)).toContain("knackered");
  });
  it("does not warn inside the designated character's paragraph", () => {
    const text = "Mara was bloody knackered, she admitted.";
    const w = britishismWarnings(text, { terms, designatedCharacter: "Mara" });
    expect(w).toHaveLength(0);
  });
});
