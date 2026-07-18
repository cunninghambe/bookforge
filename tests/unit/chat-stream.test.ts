import { describe, it, expect } from "vitest";
import { ChatStreamParser } from "@/lib/chatStream";
import { CONTROL_DELIM } from "@/lib/llm/markers";

// Four-shape contract for the chat stream parser: positive (well-formed stream
// in one or many chunks), negative (delimiter lookalikes stay visible text),
// edge cases (delimiter split across chunk boundaries, empty stream, control
// frame only), and input degradation (stream cut before the frame, garbage
// after the delimiter).

const CTRL = JSON.stringify({
  finalText: "Hello.",
  retried: false,
  emDashUnresolved: false,
  missingFacts: [],
});

describe("ChatStreamParser positive", () => {
  it("parses text plus control frame arriving in a single chunk", () => {
    const p = new ChatStreamParser();
    p.push("Hello there." + CONTROL_DELIM + CTRL);
    const end = p.finish();
    expect(end.text).toBe("Hello there.");
    expect(end.control?.finalText).toBe("Hello.");
    expect(end.parseError).toBe(false);
  });

  it("parses the same stream arriving one character at a time", () => {
    const p = new ChatStreamParser();
    for (const ch of "Hi." + CONTROL_DELIM + CTRL) p.push(ch);
    const end = p.finish();
    expect(end.text).toBe("Hi.");
    expect(end.control?.finalText).toBe("Hello.");
  });

  it("visibleText never includes the delimiter or the frame", () => {
    const p = new ChatStreamParser();
    p.push("Reply text" + CONTROL_DELIM + CTRL);
    expect(p.visibleText()).toBe("Reply text");
  });
});

describe("ChatStreamParser negative", () => {
  it("a lookalike marker inside the reply stays ordinary text", () => {
    const p = new ChatStreamParser();
    const reply = "She wrote <<<BOOKFORGE>>> on the board and left.";
    p.push(reply + CONTROL_DELIM + CTRL);
    const end = p.finish();
    expect(end.text).toBe(reply);
    expect(end.control?.finalText).toBe("Hello.");
  });

  it("a newline that merely starts like the delimiter becomes visible once disproven", () => {
    const p = new ChatStreamParser();
    p.push("End of scene.\n<<<BOOK");
    // The tail could still become the delimiter: held back.
    expect(p.visibleText()).toBe("End of scene.");
    p.push("KEEPING>>> is not our marker.");
    // Disproven: the whole thing is ordinary text again.
    expect(p.visibleText()).toBe(
      "End of scene.\n<<<BOOKKEEPING>>> is not our marker.",
    );
  });
});

describe("ChatStreamParser edge cases", () => {
  it("delimiter split across a chunk boundary is never rendered", () => {
    const p = new ChatStreamParser();
    const whole = "Partial reply." + CONTROL_DELIM + CTRL;
    const splitAt = "Partial reply.".length + Math.floor(CONTROL_DELIM.length / 2);
    p.push(whole.slice(0, splitAt));
    expect(p.visibleText()).toBe("Partial reply.");
    p.push(whole.slice(splitAt));
    const end = p.finish();
    expect(end.text).toBe("Partial reply.");
    expect(end.control?.finalText).toBe("Hello.");
  });

  it("an empty stream finishes with empty text and no control frame", () => {
    const p = new ChatStreamParser();
    const end = p.finish();
    expect(end).toEqual({ text: "", control: null, parseError: false });
  });

  it("a control frame with no preceding text (error frames) parses", () => {
    const p = new ChatStreamParser();
    p.push(CONTROL_DELIM + JSON.stringify({ error: "boom" }));
    const end = p.finish();
    expect(end.text).toBe("");
    expect(end.control?.error).toBe("boom");
  });
});

describe("ChatStreamParser input degradation", () => {
  it("a stream cut before the frame keeps the partial text and reports no frame", () => {
    const p = new ChatStreamParser();
    p.push("The reply was cut mid-sen");
    const end = p.finish();
    expect(end.text).toBe("The reply was cut mid-sen");
    expect(end.control).toBeNull();
    expect(end.parseError).toBe(false);
  });

  it("garbage after the delimiter reports a parse error but keeps the text", () => {
    const p = new ChatStreamParser();
    p.push("Good text." + CONTROL_DELIM + "{not json");
    const end = p.finish();
    expect(end.text).toBe("Good text.");
    expect(end.control).toBeNull();
    expect(end.parseError).toBe(true);
  });
});
