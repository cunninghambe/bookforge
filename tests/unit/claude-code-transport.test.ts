import { describe, it, expect, afterEach } from "vitest";
import {
  buildCliArgs,
  parseCliResult,
  parseStreamEvent,
  getLlmClient,
  __setLlmClient,
  ClaudeCodeClient,
  ClaudeCodeError,
  FixtureClient,
  AnthropicClient,
} from "@/lib/llm/client";

// A7: the claude-code transport. These cover the transport-selection matrix and
// the three pure functions (buildCliArgs, parseCliResult, parseStreamEvent). No
// process is spawned and no real call is made; parser tests are fed real captured
// CLI output (see the JSON constants below, captured from claude 2.1.207).

// ---- Transport selection --------------------------------------------------

const ENV_KEYS = ["USE_FIXTURE_LLM", "LLM_TRANSPORT"] as const;

describe("getLlmClient transport selection", () => {
  const original: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) original[k] = process.env[k];

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    __setLlmClient(null);
  });

  it("USE_FIXTURE_LLM=1 always selects the fixture client", () => {
    __setLlmClient(null);
    process.env.USE_FIXTURE_LLM = "1";
    process.env.LLM_TRANSPORT = "api-key";
    expect(getLlmClient()).toBeInstanceOf(FixtureClient);
  });

  it("defaults to the claude-code transport when LLM_TRANSPORT is unset", () => {
    __setLlmClient(null);
    delete process.env.USE_FIXTURE_LLM;
    delete process.env.LLM_TRANSPORT;
    expect(getLlmClient()).toBeInstanceOf(ClaudeCodeClient);
  });

  it("selects claude-code when LLM_TRANSPORT=claude-code", () => {
    __setLlmClient(null);
    delete process.env.USE_FIXTURE_LLM;
    process.env.LLM_TRANSPORT = "claude-code";
    expect(getLlmClient()).toBeInstanceOf(ClaudeCodeClient);
  });

  it("selects the api-key transport when LLM_TRANSPORT=api-key", () => {
    __setLlmClient(null);
    delete process.env.USE_FIXTURE_LLM;
    process.env.LLM_TRANSPORT = "api-key";
    expect(getLlmClient()).toBeInstanceOf(AnthropicClient);
  });

  it("an unrecognized LLM_TRANSPORT falls back to claude-code", () => {
    __setLlmClient(null);
    delete process.env.USE_FIXTURE_LLM;
    process.env.LLM_TRANSPORT = "nonsense";
    expect(getLlmClient()).toBeInstanceOf(ClaudeCodeClient);
  });
});

// ---- buildCliArgs ---------------------------------------------------------

describe("buildCliArgs", () => {
  it("replaces (does not append) the system prompt", () => {
    const args = buildCliArgs({
      model: "claude-sonnet-4-6",
      system: "You are a novelist.",
      streaming: false,
    });
    expect(args).toContain("--system-prompt");
    expect(args).not.toContain("--append-system-prompt");
    const i = args.indexOf("--system-prompt");
    expect(args[i + 1]).toBe("You are a novelist.");
  });

  it("passes the model through and stays single-turn with no session files", () => {
    const args = buildCliArgs({ model: "opus", streaming: false });
    const mi = args.indexOf("--model");
    expect(args[mi + 1]).toBe("opus");
    const ti = args.indexOf("--max-turns");
    expect(args[ti + 1]).toBe("1");
    expect(args).toContain("--no-session-persistence");
    expect(args).toContain("--print");
  });

  it("disables all built-in tools", () => {
    const args = buildCliArgs({ model: "opus", streaming: false });
    const i = args.indexOf("--tools");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(args[i + 1]).toBe("");
  });

  // D196: --tools "" drops only the BUILT-IN tools. Every MCP server configured
  // for the host user stays loaded, so without --strict-mcp-config a prose call
  // is handed the operator's MCP fleet (measured on the production box
  // 2026-08-14: 172 tools across 9 servers, including Gmail send and Notion
  // write). --strict-mcp-config limits MCP to servers passed via --mcp-config,
  // of which we pass none, taking the tool count to 0. Boolean flag, so the
  // variadic --tools does not swallow it.
  it("detaches the host's MCP servers", () => {
    const args = buildCliArgs({ model: "opus", streaming: false });
    expect(args).toContain("--strict-mcp-config");
  });

  // The flag is a security control, so it must hold across every argv variant,
  // not just the default one — a session resume must not silently re-attach the
  // host's MCP servers.
  it.each([
    ["default", { model: "opus", streaming: false }],
    ["streaming", { model: "opus", streaming: true }],
    ["persistSession", { model: "opus", streaming: false, persistSession: true }],
    [
      "resumeSessionId",
      { model: "opus", streaming: true, resumeSessionId: "abc-123" },
    ],
    ["with system prompt", { model: "opus", streaming: false, system: "S" }],
  ])("keeps --strict-mcp-config in the %s variant", (_name, opts) => {
    expect(buildCliArgs(opts)).toContain("--strict-mcp-config");
  });

  it("omits --system-prompt entirely when no system prompt is given", () => {
    const args = buildCliArgs({ model: "opus", streaming: false });
    expect(args).not.toContain("--system-prompt");
  });

  it("uses json output when not streaming", () => {
    const args = buildCliArgs({ model: "opus", streaming: false });
    const i = args.indexOf("--output-format");
    expect(args[i + 1]).toBe("json");
    expect(args).not.toContain("--include-partial-messages");
    expect(args).not.toContain("--verbose");
  });

  it("uses stream-json with partial messages and verbose when streaming", () => {
    const args = buildCliArgs({ model: "opus", streaming: true });
    const i = args.indexOf("--output-format");
    expect(args[i + 1]).toBe("stream-json");
    expect(args).toContain("--include-partial-messages");
    // stream-json with --print requires --verbose per the installed CLI.
    expect(args).toContain("--verbose");
  });
});

// ---- parseCliResult -------------------------------------------------------

// Captured real success result object from claude 2.1.207 (--output-format json
// shape), trimmed to the fields the parser reads.
const SUCCESS_RESULT = {
  type: "result",
  subtype: "success",
  is_error: false,
  api_error_status: null,
  result: "ping",
  stop_reason: "end_turn",
  total_cost_usd: 0.07014770000000001,
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 10039,
    cache_read_input_tokens: 30869,
    output_tokens: 4,
  },
};

describe("parseCliResult", () => {
  it("maps the reply text and all four token fields on success", () => {
    const r = parseCliResult(SUCCESS_RESULT);
    expect(r.text).toBe("ping");
    expect(r.inputTokens).toBe(2);
    expect(r.outputTokens).toBe(4);
    expect(r.cacheWriteTokens).toBe(10039); // cache_creation_input_tokens
    expect(r.cacheReadTokens).toBe(30869); // cache_read_input_tokens
  });

  it("tolerates missing usage fields", () => {
    const r = parseCliResult({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "hi",
    });
    expect(r.text).toBe("hi");
    expect(r.inputTokens).toBe(0);
    expect(r.outputTokens).toBe(0);
    expect(r.cacheReadTokens).toBeUndefined();
    expect(r.cacheWriteTokens).toBeUndefined();
  });

  it("throws when is_error is true, carrying the api_error_status", () => {
    let caught: unknown;
    try {
      parseCliResult({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        api_error_status: "529",
        result: "Overloaded",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ClaudeCodeError);
    expect((caught as ClaudeCodeError).message).toContain("529");
    // 5xx is transient.
    expect((caught as ClaudeCodeError).transient).toBe(true);
  });

  it("classifies a 4xx api_error_status as non-transient", () => {
    let caught: unknown;
    try {
      parseCliResult({
        type: "result",
        subtype: "error",
        is_error: true,
        api_error_status: "401",
      });
    } catch (e) {
      caught = e;
    }
    expect((caught as ClaudeCodeError).transient).toBe(false);
    expect((caught as ClaudeCodeError).message).toContain("401");
  });

  it("throws with the result text when there is no api_error_status", () => {
    expect(() =>
      parseCliResult({
        type: "result",
        subtype: "success",
        is_error: true,
        result: "something went wrong",
      }),
    ).toThrow("something went wrong");
  });
});

// ---- parseStreamEvent -----------------------------------------------------

// Captured real stream-json lines from claude 2.1.207.
const DELTA_LINE =
  '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ping"}},"session_id":"x","uuid":"y"}';
const RESULT_LINE =
  '{"type":"result","subtype":"success","is_error":false,"api_error_status":null,"result":"ping","stop_reason":"end_turn","session_id":"x","total_cost_usd":0.07,"usage":{"input_tokens":2,"cache_creation_input_tokens":10039,"cache_read_input_tokens":30869,"output_tokens":4}}';
const INIT_LINE =
  '{"type":"system","subtype":"init","session_id":"x","model":"claude-sonnet-5"}';
const MESSAGE_START_LINE =
  '{"type":"stream_event","event":{"type":"message_start","message":{"role":"assistant"}},"session_id":"x"}';

describe("parseStreamEvent", () => {
  it("extracts text deltas from content_block_delta events", () => {
    const p = parseStreamEvent(DELTA_LINE);
    expect(p.kind).toBe("delta");
    if (p.kind === "delta") expect(p.text).toBe("ping");
  });

  it("recognizes the final result and maps its usage", () => {
    const p = parseStreamEvent(RESULT_LINE);
    expect(p.kind).toBe("result");
    if (p.kind === "result") {
      expect(p.result.text).toBe("ping");
      expect(p.result.inputTokens).toBe(2);
      expect(p.result.outputTokens).toBe(4);
      expect(p.result.cacheWriteTokens).toBe(10039);
      expect(p.result.cacheReadTokens).toBe(30869);
    }
  });

  it("treats non-delta stream events as other", () => {
    expect(parseStreamEvent(INIT_LINE).kind).toBe("other");
    expect(parseStreamEvent(MESSAGE_START_LINE).kind).toBe("other");
  });

  it("tolerates blank and non-JSON lines", () => {
    expect(parseStreamEvent("").kind).toBe("other");
    expect(parseStreamEvent("   ").kind).toBe("other");
    expect(parseStreamEvent("not json at all").kind).toBe("other");
    expect(parseStreamEvent("{broken").kind).toBe("other");
  });
});

// ---- A10: session reuse ----------------------------------------------------

import { SessionStore } from "@/lib/llm/client";

describe("buildCliArgs A10 session variants", () => {
  it("with neither session option the argv is the pre-A10 shape plus the D196 MCP opt-out", () => {
    expect(
      buildCliArgs({ model: "m1", system: "S", streaming: false }),
    ).toEqual([
      "--print",
      "--model",
      "m1",
      "--max-turns",
      "1",
      "--no-session-persistence",
      "--tools",
      "",
      "--strict-mcp-config",
      "--output-format",
      "json",
      "--system-prompt",
      "S",
    ]);
  });

  it("persistSession omits --no-session-persistence and keeps everything else", () => {
    const args = buildCliArgs({
      model: "m1",
      system: "S",
      streaming: false,
      persistSession: true,
    });
    expect(args).not.toContain("--no-session-persistence");
    expect(args).toContain("--system-prompt");
    expect(args).toContain("--tools");
  });

  it("resumeSessionId adds --resume, omits session-persistence opt-out AND the system prompt", () => {
    const args = buildCliArgs({
      model: "m1",
      system: "S",
      streaming: true,
      persistSession: true,
      resumeSessionId: "abc-123",
    });
    expect(args).toContain("--resume");
    expect(args[args.indexOf("--resume") + 1]).toBe("abc-123");
    expect(args).not.toContain("--no-session-persistence");
    // The session retains the original system prompt; it is never re-passed.
    expect(args).not.toContain("--system-prompt");
  });
});

describe("parseCliResult A10 session id and errors detail", () => {
  it("captures session_id on success", () => {
    const r = parseCliResult({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "OK",
      session_id: "507f28c6-bc86-47ba-a0b3-9d9134925487",
      usage: { input_tokens: 3, output_tokens: 5 },
    });
    expect(r.sessionId).toBe("507f28c6-bc86-47ba-a0b3-9d9134925487");
  });

  it("leaves sessionId undefined when absent or empty", () => {
    const r = parseCliResult({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "OK",
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    expect(r.sessionId).toBeUndefined();
  });

  it("surfaces the errors array detail when status and result are absent (missing-session shape)", () => {
    // Captured from claude 2.1.209: --resume of a nonexistent session in
    // stream-json mode.
    const failed = {
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      session_id: "00000000-0000-0000-0000-000000000000",
      errors: [
        "No conversation found with session ID: 00000000-0000-0000-0000-000000000000",
      ],
    };
    expect(() => parseCliResult(failed)).toThrowError(
      /No conversation found with session ID/,
    );
  });
});

describe("SessionStore", () => {
  it("stores, reports, and deletes session ids per key", () => {
    const s = new SessionStore();
    expect(s.has("a")).toBe(false);
    s.set("a", "sid-1");
    expect(s.has("a")).toBe(true);
    expect(s.get("a")).toBe("sid-1");
    s.set("a", "sid-2");
    expect(s.get("a")).toBe("sid-2");
    s.delete("a");
    expect(s.has("a")).toBe(false);
  });

  it("evicts the oldest entry past the cap", () => {
    const s = new SessionStore(3);
    s.set("k1", "s1");
    s.set("k2", "s2");
    s.set("k3", "s3");
    s.set("k4", "s4");
    expect(s.size).toBe(3);
    expect(s.has("k1")).toBe(false);
    expect(s.has("k4")).toBe(true);
  });

  it("re-setting an existing key refreshes its eviction position", () => {
    const s = new SessionStore(2);
    s.set("k1", "s1");
    s.set("k2", "s2");
    s.set("k1", "s1b"); // refresh k1: k2 is now oldest
    s.set("k3", "s3");
    expect(s.has("k1")).toBe(true);
    expect(s.has("k2")).toBe(false);
  });
});

describe("parseStreamEvent A10 session id", () => {
  it("the stream result event carries session_id through to the CompleteResult", () => {
    const line = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "OK",
      session_id: "cac3265f-d58c-44bd-91de-5252189a43a5",
      usage: { input_tokens: 3, output_tokens: 5 },
    });
    const parsed = parseStreamEvent(line);
    expect(parsed.kind).toBe("result");
    if (parsed.kind === "result") {
      expect(parsed.result.sessionId).toBe(
        "cac3265f-d58c-44bd-91de-5252189a43a5",
      );
    }
  });
});
