// Client-side consumption of the chat stream protocol: raw reply text, then a
// CONTROL_DELIM separator, then one JSON control frame. Extracted from the chat
// component so the incremental parsing is pure and unit-testable. The parser is
// fed decoded chunks as they arrive; visibleText() is safe to render mid-stream
// (a partially received delimiter is held back, never shown); finish() returns
// the final text and the parsed control frame once the stream has ended.

import { CONTROL_DELIM } from "./llm/markers";

export interface ChatControlFrame {
  finalText?: string;
  retried?: boolean;
  emDashUnresolved?: boolean;
  missingFacts?: string[];
  error?: string;
}

export interface ChatStreamEnd {
  // The raw streamed text before the delimiter (the whole buffer when no
  // delimiter ever arrived, e.g. a stream cut short).
  text: string;
  // The parsed control frame, or null when it never arrived or was unparseable.
  control: ChatControlFrame | null;
  // True when a delimiter arrived but the JSON after it did not parse.
  parseError: boolean;
}

export class ChatStreamParser {
  private buffer = "";

  push(chunk: string): void {
    this.buffer += chunk;
  }

  // Everything before the control delimiter, safe to render while streaming.
  // A chunk boundary can fall inside the delimiter, so any buffer tail that is
  // a prefix of the delimiter is held back until it either completes into the
  // real delimiter or turns out to be ordinary text.
  visibleText(): string {
    // A23.5 / D189: scan from the END. The delimiter is documented as a string
    // that will never occur in generated prose, but nothing enforces that, and
    // manuscript text can instruct the model to emit it. The server always
    // writes the genuine frame last, so lastIndexOf is strictly correct and
    // cannot be spoofed by content.
    const idx = this.buffer.lastIndexOf(CONTROL_DELIM);
    if (idx >= 0) return this.buffer.slice(0, idx);
    const maxHold = Math.min(CONTROL_DELIM.length - 1, this.buffer.length);
    for (let k = maxHold; k > 0; k--) {
      if (this.buffer.endsWith(CONTROL_DELIM.slice(0, k))) {
        return this.buffer.slice(0, this.buffer.length - k);
      }
    }
    return this.buffer;
  }

  finish(): ChatStreamEnd {
    // D189: the genuine frame is always the last one written.
    const idx = this.buffer.lastIndexOf(CONTROL_DELIM);
    if (idx < 0) {
      return { text: this.buffer, control: null, parseError: false };
    }
    const text = this.buffer.slice(0, idx);
    try {
      const control = JSON.parse(
        this.buffer.slice(idx + CONTROL_DELIM.length),
      ) as ChatControlFrame;
      return { text, control, parseError: false };
    } catch {
      return { text, control: null, parseError: true };
    }
  }
}
