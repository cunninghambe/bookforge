import { describe, it, expect } from "vitest";
import { isValidFixtureKey, isValidModelId } from "@/lib/llm/validate";
import { FixtureClient, buildCliArgs } from "@/lib/llm/client";

// A23.4 / D188: the two untrusted strings that reach the subprocess boundary.
// Command injection is NOT present on the production path (Linux always spawns
// with shell false and the prompt rides stdin, never argv); these checks keep
// the Windows shell fallback safe and keep a request body out of a filename.

describe("isValidModelId", () => {
  it("accepts the model ids the app actually uses", () => {
    expect(isValidModelId("claude-sonnet-4-6")).toBe(true);
    expect(isValidModelId("claude-opus-4-1-20250805")).toBe(true);
    expect(isValidModelId("claude-3-5-haiku-latest")).toBe(true);
    expect(isValidModelId("bedrock:anthropic.claude-v2")).toBe(true);
    expect(isValidModelId("model_1.2")).toBe(true);
  });

  it("rejects shell metacharacters", () => {
    for (const bad of [
      "claude-sonnet-4-6; calc.exe",
      "claude & whoami",
      "claude | more",
      "claude`whoami`",
      "claude$(whoami)",
      "claude>out.txt",
      "claude<in.txt",
      'claude"x"',
      "claude'x'",
      "claude%PATH%",
      "claude\nwhoami",
      "claude sonnet",
      "claude^x",
      "claude(x)",
    ]) {
      expect(isValidModelId(bad)).toBe(false);
    }
  });

  it("rejects path traversal and empty or non-string values", () => {
    expect(isValidModelId("../../etc/passwd")).toBe(false);
    expect(isValidModelId("..\\..\\windows\\system32")).toBe(false);
    expect(isValidModelId("")).toBe(false);
    expect(isValidModelId(undefined)).toBe(false);
    expect(isValidModelId(null)).toBe(false);
    expect(isValidModelId(42)).toBe(false);
  });
});

describe("buildCliArgs validates the model id", () => {
  it("builds argv for a normal model id", () => {
    const args = buildCliArgs({ model: "claude-sonnet-4-6", streaming: false });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-sonnet-4-6");
  });

  it("throws rather than letting a metacharacter reach argv", () => {
    expect(() =>
      buildCliArgs({ model: "claude-sonnet-4-6; calc.exe", streaming: false }),
    ).toThrow(/invalid model id/);
    expect(() => buildCliArgs({ model: "", streaming: true })).toThrow(
      /invalid model id/,
    );
  });
});

describe("isValidFixtureKey", () => {
  it("accepts the fixture keys the suite uses", () => {
    expect(isValidFixtureKey("chapter1")).toBe(true);
    expect(isValidFixtureKey("bible.chunk-2")).toBe(true);
    expect(isValidFixtureKey("a22_suggest")).toBe(true);
  });

  it("rejects traversal and separators", () => {
    expect(isValidFixtureKey("../../../etc/passwd")).toBe(false);
    expect(isValidFixtureKey("..\\..\\secrets")).toBe(false);
    expect(isValidFixtureKey("nested/key")).toBe(false);
    expect(isValidFixtureKey("C:\\windows\\win.ini")).toBe(false);
  });

  it("rejects metacharacters, whitespace, and non-strings", () => {
    expect(isValidFixtureKey("key with space")).toBe(false);
    expect(isValidFixtureKey("key\u0000null")).toBe(false);
    expect(isValidFixtureKey("key;rm")).toBe(false);
    expect(isValidFixtureKey("key$(x)")).toBe(false);
    expect(isValidFixtureKey("")).toBe(false);
    expect(isValidFixtureKey(undefined)).toBe(false);
    expect(isValidFixtureKey(7)).toBe(false);
  });
});

describe("loadFixture rejects a bad key before it reaches a filename", () => {
  it("throws a clear error for a traversal key", async () => {
    const client = new FixtureClient();
    await expect(
      client.complete({
        purpose: "chat",
        model: "claude-sonnet-4-6",
        prompt: "hello",
        fixtureKey: "../../package",
      }),
    ).rejects.toThrow(/invalid fixtureKey/);
  });

  it("leaves the no-key path working", async () => {
    const client = new FixtureClient();
    const res = await client.complete({
      purpose: "chat",
      model: "claude-sonnet-4-6",
      prompt: "hello",
    });
    expect(typeof res.text).toBe("string");
  });
});
