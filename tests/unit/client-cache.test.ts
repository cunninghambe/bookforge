import { describe, it, expect } from "vitest";
import {
  buildMessageRequest,
  type CacheableTextBlock,
} from "@/lib/llm/client";

// A4.1: the pure block-construction function. With a promptPrefix the system and
// prefix become cache-controlled content blocks and the remainder stays uncached;
// with no prefix it returns the old plain-string shape.
describe("buildMessageRequest", () => {
  it("returns the old plain-string shape when there is no prefix", () => {
    const shape = buildMessageRequest({
      system: "SYS",
      prompt: "PROMPT",
    });
    expect(shape.system).toBe("SYS");
    expect(shape.content).toBe("PROMPT");
  });

  it("omits system entirely when none is given and there is no prefix", () => {
    const shape = buildMessageRequest({ prompt: "PROMPT" });
    expect(shape.system).toBeUndefined();
    expect(shape.content).toBe("PROMPT");
  });

  it("caches system and prefix, leaves the remainder uncached, with a prefix", () => {
    const shape = buildMessageRequest({
      system: "SYS",
      promptPrefix: "STABLE",
      prompt: "REMAINDER",
    });

    // System becomes a single cache-controlled text block.
    expect(Array.isArray(shape.system)).toBe(true);
    const sys = shape.system as CacheableTextBlock[];
    expect(sys).toHaveLength(1);
    expect(sys[0]).toEqual({
      type: "text",
      text: "SYS",
      cache_control: { type: "ephemeral" },
    });

    // Content is two blocks: cached prefix, then uncached remainder.
    expect(Array.isArray(shape.content)).toBe(true);
    const content = shape.content as CacheableTextBlock[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({
      type: "text",
      text: "STABLE",
      cache_control: { type: "ephemeral" },
    });
    expect(content[1]).toEqual({ type: "text", text: "REMAINDER" });
    expect(content[1].cache_control).toBeUndefined();
  });

  it("caches the prefix even when there is no system", () => {
    const shape = buildMessageRequest({
      promptPrefix: "STABLE",
      prompt: "REMAINDER",
    });
    expect(shape.system).toBeUndefined();
    const content = shape.content as CacheableTextBlock[];
    expect(content[0].cache_control).toEqual({ type: "ephemeral" });
    expect(content[1].cache_control).toBeUndefined();
  });
});
