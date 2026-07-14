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
  // A4.1: a stable prefix that precedes `prompt`. When present, the real client
  // marks the system and this prefix as cacheable (cache_control ephemeral) and
  // leaves `prompt` uncached, so repeated calls that share the prefix hit the
  // prompt cache. The fixture client accepts it and ignores it.
  promptPrefix?: string;
  maxTokens?: number;
  // Distinguishes multiple fixtures for the same purpose in one test run.
  fixtureKey?: string;
}

export interface CompleteResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  // A4.1: prompt-cache usage, when the provider reports it. cacheWriteTokens is
  // the SDK's cache_creation_input_tokens; cacheReadTokens is
  // cache_read_input_tokens. Undefined when caching is not in play.
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

// ---- Cacheable request construction (A4.1) --------------------------------

// A single ephemeral cache breakpoint. Everything up to and including a block
// carrying this control is cached by the API.
export interface EphemeralCacheControl {
  type: "ephemeral";
}

// A text content block, optionally carrying a cache breakpoint.
export interface CacheableTextBlock {
  type: "text";
  text: string;
  cache_control?: EphemeralCacheControl;
}

// The system and user content the real client hands the SDK. Either the old
// plain-string shape (no prefix) or the block shape with cache breakpoints.
export interface MessageRequestShape {
  system?: string | CacheableTextBlock[];
  content: string | CacheableTextBlock[];
}

// Pure block construction, unit tested without the SDK. With no promptPrefix it
// returns the old plain-string shape (system as a string, content as a string).
// With a promptPrefix it returns block arrays: the system block and the prefix
// block each carry a cache_control breakpoint, and the remainder (`prompt`) is a
// trailing uncached block.
export function buildMessageRequest(opts: {
  system?: string;
  promptPrefix?: string;
  prompt: string;
}): MessageRequestShape {
  if (opts.promptPrefix === undefined) {
    return { system: opts.system, content: opts.prompt };
  }
  const system: string | CacheableTextBlock[] | undefined =
    opts.system !== undefined
      ? [
          {
            type: "text",
            text: opts.system,
            cache_control: { type: "ephemeral" },
          },
        ]
      : undefined;
  const content: CacheableTextBlock[] = [
    {
      type: "text",
      text: opts.promptPrefix,
      cache_control: { type: "ephemeral" },
    },
    { type: "text", text: opts.prompt },
  ];
  return { system, content };
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
  // Optional: prompt-cache usage, so a fixture can exercise the passthrough.
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
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
    // promptPrefix is accepted and ignored by the fixture player.
    const fx = loadFixture(opts.purpose, opts.fixtureKey);
    return {
      text: fx.text,
      inputTokens: fx.inputTokens ?? opts.prompt.length / 4,
      outputTokens: fx.outputTokens ?? fx.text.length / 4,
      cacheReadTokens: fx.cacheReadTokens,
      cacheWriteTokens: fx.cacheWriteTokens,
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
      cacheReadTokens: fx.cacheReadTokens,
      cacheWriteTokens: fx.cacheWriteTokens,
    };
  }
}

// The SDK's usage object, widened to include the prompt-cache fields. The
// installed @anthropic-ai/sdk (0.32.x) does not type these on the non-beta
// endpoint, but the GA API returns them, so we read them through this shape.
interface UsageWithCache {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
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
    const shape = buildMessageRequest({
      system: opts.system,
      promptPrefix: opts.promptPrefix,
      prompt: opts.prompt,
    });
    return this.withRetry(async () => {
      const res = await client.messages.create({
        model: opts.model,
        max_tokens: opts.maxTokens ?? 4096,
        // The block shape (with cache_control) is runtime-valid on the GA API;
        // the 0.32.x non-beta types accept only string here, so we bridge with a
        // cast (see DECISIONS D50).
        system: shape.system as unknown as string | undefined,
        messages: [
          { role: "user", content: shape.content as unknown as string },
        ],
      });
      const text = res.content
        .filter((b): b is { type: "text"; text: string } => b.type === "text")
        .map((b) => b.text)
        .join("");
      const usage = res.usage as UsageWithCache;
      return {
        text,
        inputTokens: usage.input_tokens,
        outputTokens: usage.output_tokens,
        cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
        cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
      };
    });
  }

  async *stream(
    opts: CompleteOptions,
  ): AsyncGenerator<string, CompleteResult, unknown> {
    const client = await this.getSdk();
    const shape = buildMessageRequest({
      system: opts.system,
      promptPrefix: opts.promptPrefix,
      prompt: opts.prompt,
    });
    const stream = client.messages.stream({
      model: opts.model,
      max_tokens: opts.maxTokens ?? 4096,
      system: shape.system as unknown as string | undefined,
      messages: [{ role: "user", content: shape.content as unknown as string }],
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
    const usage = final.usage as UsageWithCache;
    return {
      text,
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
      cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
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
