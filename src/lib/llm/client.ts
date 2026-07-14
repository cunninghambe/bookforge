import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// One injectable LLM client. In tests and E2E (USE_FIXTURE_LLM=1) a fixture player
// answers from tests/fixtures/*.json so nothing ever hits the network. In real use
// it wraps @anthropic-ai/sdk. Every utility call names a `purpose` so responses can
// be routed to fixtures and token counts logged to the llm_calls table.

export type LlmPurpose =
  | "interrogation"
  | "summary"
  | "extraction"
  | "sweep"
  | "draft"
  | "revision"
  | "bible";

export interface CompleteOptions {
  purpose: LlmPurpose;
  model: string;
  system?: string;
  prompt: string;
  maxTokens?: number;
  // Distinguishes multiple fixtures for the same purpose in one test run.
  fixtureKey?: string;
}

export interface CompleteResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  complete(opts: CompleteOptions): Promise<CompleteResult>;
  // Streaming prose. Yields text chunks; resolves usage via the returned promise.
  stream(opts: CompleteOptions): AsyncGenerator<string, CompleteResult, unknown>;
}

// ---- Fixture client -------------------------------------------------------

interface FixtureFile {
  text: string;
  inputTokens?: number;
  outputTokens?: number;
  // Optional: stream chunks. Falls back to splitting `text` into words.
  chunks?: string[];
}

function loadFixture(purpose: LlmPurpose, fixtureKey?: string): FixtureFile {
  const name = fixtureKey ? `${purpose}.${fixtureKey}.json` : `${purpose}.json`;
  const path = resolve(process.cwd(), "tests", "fixtures", name);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as FixtureFile;
}

class FixtureClient implements LlmClient {
  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const fx = loadFixture(opts.purpose, opts.fixtureKey);
    return {
      text: fx.text,
      inputTokens: fx.inputTokens ?? opts.prompt.length / 4,
      outputTokens: fx.outputTokens ?? fx.text.length / 4,
    };
  }

  async *stream(
    opts: CompleteOptions,
  ): AsyncGenerator<string, CompleteResult, unknown> {
    const fx = loadFixture(opts.purpose, opts.fixtureKey);
    const chunks = fx.chunks ?? fx.text.match(/\S+\s*/g) ?? [fx.text];
    for (const c of chunks) {
      yield c;
    }
    return {
      text: fx.text,
      inputTokens: fx.inputTokens ?? Math.ceil(opts.prompt.length / 4),
      outputTokens: fx.outputTokens ?? Math.ceil(fx.text.length / 4),
    };
  }
}

// ---- Real Anthropic client ------------------------------------------------

class AnthropicClient implements LlmClient {
  private async getSdk() {
    const mod = await import("@anthropic-ai/sdk");
    const Anthropic = mod.default;
    return new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY ?? "" });
  }

  // Retry once on transient errors, then surface.
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number }).status;
      const transient = status === undefined || status >= 500 || status === 429;
      if (!transient) throw err;
      return await fn();
    }
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const client = await this.getSdk();
    return this.withRetry(async () => {
      const res = await client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        system: opts.system,
        messages: [{ role: "user", content: opts.prompt }],
      });
      const text = res.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      return {
        text,
        inputTokens: res.usage.input_tokens,
        outputTokens: res.usage.output_tokens,
      };
    });
  }

  async *stream(
    opts: CompleteOptions,
  ): AsyncGenerator<string, CompleteResult, unknown> {
    const client = await this.getSdk();
    const stream = client.messages.stream({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: opts.system,
      messages: [{ role: "user", content: opts.prompt }],
    });
    let text = "";
    for await (const event of stream) {
      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        text += event.delta.text;
        yield event.delta.text;
      }
    }
    const final = await stream.finalMessage();
    return {
      text,
      inputTokens: final.usage.input_tokens,
      outputTokens: final.usage.output_tokens,
    };
  }
}

let _client: LlmClient | null = null;

export function getLlmClient(): LlmClient {
  if (_client) return _client;
  _client =
    process.env.USE_FIXTURE_LLM === "1"
      ? new FixtureClient()
      : new AnthropicClient();
  return _client;
}

// Test hook: force a specific client.
export function __setLlmClient(client: LlmClient | null) {
  _client = client;
}
