import { describe, it, expect } from "vitest";
import {
  interrogationPrompt,
  normalizeQuestions,
} from "@/lib/llm/prompts";
import { hasEmDash } from "@/lib/llm/lint";

describe("normalizeQuestions", () => {
  it("accepts an array of strings", () => {
    expect(normalizeQuestions(["a", " b ", ""])).toEqual(["a", "b"]);
  });
  it("accepts an array of {question} objects", () => {
    expect(
      normalizeQuestions([{ question: "a" }, { question: " b " }, { nope: 1 }]),
    ).toEqual(["a", "b"]);
  });
  it("returns empty on non-arrays", () => {
    expect(normalizeQuestions({})).toEqual([]);
    expect(normalizeQuestions(null)).toEqual([]);
  });
});

describe("interrogationPrompt", () => {
  const prompt = interrogationPrompt({
    chapterTitle: "The Hall",
    pov: "Mara",
    synopsis: "Mara enters the hall.",
    beats: ["She hides her flame", "Julian arrives"],
    lockedCanon: ["Iron burns elementals."],
  });

  it("includes beats, POV, and canon", () => {
    expect(prompt).toContain("Mara");
    expect(prompt).toContain("She hides her flame");
    expect(prompt).toContain("Iron burns elementals.");
  });
  it("forbids em-dashes and contains none itself", () => {
    expect(prompt.toLowerCase()).toContain("do not use em-dashes");
    expect(hasEmDash(prompt)).toBe(false);
  });
  it("asks for JSON only", () => {
    expect(prompt).toContain("JSON array");
  });
});
