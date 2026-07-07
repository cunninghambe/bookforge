import { describe, it, expect } from "vitest";
import { parseJson } from "@/lib/llm/json";

describe("parseJson", () => {
  it("parses a bare array", () => {
    const r = parseJson<number[]>("[1, 2, 3]");
    expect(r.ok && r.value).toEqual([1, 2, 3]);
  });

  it("strips code fences", () => {
    const r = parseJson<{ a: number }>("```json\n{ \"a\": 1 }\n```");
    expect(r.ok && r.value).toEqual({ a: 1 });
  });

  it("extracts JSON from surrounding prose", () => {
    const r = parseJson<string[]>(
      'Here are the questions:\n["one", "two"]\nHope that helps.',
    );
    expect(r.ok && r.value).toEqual(["one", "two"]);
  });

  it("handles brackets inside strings", () => {
    const r = parseJson<{ q: string }>('{"q": "what about [this]?"}');
    expect(r.ok && r.value).toEqual({ q: "what about [this]?" });
  });

  it("returns ok:false and keeps raw on garbage", () => {
    const r = parseJson("not json at all");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.raw).toBe("not json at all");
  });
});
