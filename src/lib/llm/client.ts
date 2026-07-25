import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isValidFixtureKey, isValidModelId } from "./validate";

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
  | "bible"
  | "chat"
  // A8: the settings-page Test button makes one tiny call with this purpose.
  | "model_test";

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
  // A10: opaque conversation identifier. Only the claude-code transport acts on
  // it (one resumable CLI session per key); the fixture and api-key clients
  // accept and ignore it.
  sessionKey?: string;
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
  // A10: the CLI session id from a sessionful claude-code call, so the transport
  // can resume the conversation next turn. Never logged to llm_calls.
  sessionId?: string;
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
  // A10: whether the transport holds a resumable session for this key. Callers
  // treat a missing implementation as always false (fixture, api-key).
  hasSession?(key: string): boolean;
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
  // A23.4 / D188: fixtureKey arrives verbatim from nine request bodies and is
  // interpolated into a filename. Shape-check it here, at the boundary, so no
  // caller has to remember to.
  if (fixtureKey !== undefined && !isValidFixtureKey(fixtureKey)) {
    throw new Error(
      `invalid fixtureKey: only letters, digits, dot, underscore, and hyphen are allowed`,
    );
  }
  const name = fixtureKey ? `${purpose}.${fixtureKey}.json` : `${purpose}.json`;
  const path = resolve(process.cwd(), "tests", "fixtures", name);
  const raw = readFileSync(path, "utf8");
  return JSON.parse(raw) as FixtureFile;
}

export class FixtureClient implements LlmClient {
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

export class AnthropicClient implements LlmClient {
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

// ---- Claude Code CLI client (A7) ------------------------------------------

// The claude-code transport spawns the locally installed Claude Code CLI in
// headless print mode, one child process per call. It rides the machine's
// existing Claude Code auth so no ANTHROPIC_API_KEY is needed. The prompt goes
// over stdin (assembled prompts exceed Windows argv length limits); the system
// prompt, model, and flags go as argv entries. See DECISIONS D63-D69.

// An error from the CLI transport. `transient` drives the retry-once wrapper:
// spawn-level failures and non-4xx CLI errors are retried once; 4xx errors and
// timeouts are surfaced immediately.
export class ClaudeCodeError extends Error {
  readonly transient: boolean;
  constructor(message: string, opts?: { transient?: boolean }) {
    super(message);
    this.name = "ClaudeCodeError";
    this.transient = opts?.transient ?? false;
  }
}

// The subset of the CLI's --output-format json result object we read.
interface CliResultShape {
  type?: string;
  subtype?: string;
  is_error?: boolean;
  api_error_status?: string | number | null;
  result?: string;
  // A10: identifies the CLI session, present on sessionful and resumed calls.
  session_id?: string;
  // Error detail lines on failed runs (e.g. a --resume of a missing session in
  // stream-json mode reports "No conversation found with session ID: ..." here).
  errors?: unknown;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_creation_input_tokens?: number | null;
    cache_read_input_tokens?: number | null;
  };
}

export interface CliArgsOptions {
  model: string;
  system?: string;
  // stream-json plus partial messages when true; a single json result when false.
  streaming: boolean;
  // A10: keep the session on disk so a later call can resume it. Omits
  // --no-session-persistence. Implied by resumeSessionId.
  persistSession?: boolean;
  // A10: continue an existing CLI session. Adds --resume <id> and does NOT
  // re-pass --system-prompt: the session retains the original one (verified
  // against the installed CLI before coding, per the A7 rule).
  resumeSessionId?: string;
}

// Pure: the argv list for a headless call. --system-prompt REPLACES the default
// Claude Code system prompt (never --append-system-prompt), so bookforge's prose
// calls do not inherit the tool-oriented default. --tools "" disables every
// built-in tool and --max-turns 1 keeps it single-turn. With neither A10 session
// option the argv is byte-identical to the pre-A10 shape. Unit tested.
export function buildCliArgs(opts: CliArgsOptions): string[] {
  // A23.4 / D188: the model id is the one caller-supplied value that reaches
  // argv. The Windows fallback can spawn with shell true (D64), where argv
  // values are not quoted, so a metacharacter here would execute. The fallback
  // is left working; the value can no longer carry one.
  if (!isValidModelId(opts.model)) {
    throw new ClaudeCodeError(`invalid model id: ${opts.model}`, {
      transient: false,
    });
  }
  const args: string[] = ["--print", "--model", opts.model, "--max-turns", "1"];
  if (!opts.persistSession && opts.resumeSessionId === undefined) {
    args.push("--no-session-persistence");
  }
  if (opts.resumeSessionId !== undefined) {
    args.push("--resume", opts.resumeSessionId);
  }
  args.push(
    "--tools",
    "",
    "--output-format",
    opts.streaming ? "stream-json" : "json",
  );
  if (opts.streaming) {
    args.push("--verbose", "--include-partial-messages");
  }
  if (opts.system !== undefined && opts.resumeSessionId === undefined) {
    args.push("--system-prompt", opts.system);
  }
  return args;
}

function has4xxStatus(status: string | number | null | undefined): boolean {
  if (status === null || status === undefined) return false;
  return /\b4\d\d\b/.test(String(status));
}

// Pure: map the CLI's json result object to a CompleteResult. is_error true or a
// non-success subtype throws a ClaudeCodeError carrying the api_error_status or
// result text; a 4xx status is non-transient. Missing usage fields tolerated.
// Unit tested.
export function parseCliResult(json: unknown): CompleteResult {
  const obj = (json ?? {}) as CliResultShape;
  if (obj.is_error === true || obj.subtype !== "success") {
    const joinedErrors = Array.isArray(obj.errors)
      ? obj.errors.filter((e): e is string => typeof e === "string").join("; ")
      : "";
    const detail =
      obj.api_error_status !== null && obj.api_error_status !== undefined
        ? String(obj.api_error_status)
        : typeof obj.result === "string" && obj.result.trim() !== ""
          ? obj.result
          : joinedErrors !== ""
            ? joinedErrors
            : "unknown error";
    throw new ClaudeCodeError(`Claude Code CLI returned an error: ${detail}`, {
      transient: !has4xxStatus(obj.api_error_status),
    });
  }
  const usage = obj.usage ?? {};
  return {
    text: typeof obj.result === "string" ? obj.result : "",
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
    cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
    sessionId:
      typeof obj.session_id === "string" && obj.session_id !== ""
        ? obj.session_id
        : undefined,
  };
}

export type StreamEventParse =
  | { kind: "delta"; text: string }
  | { kind: "result"; result: CompleteResult }
  | { kind: "other" };

// Pure: interpret one line of --output-format stream-json. Text deltas arrive as
// stream_event wrappers around content_block_delta/text_delta; the run ends with
// a result object (same shape parseCliResult reads). Blank and non-JSON lines are
// tolerated as "other". Unit tested.
export function parseStreamEvent(line: string): StreamEventParse {
  const trimmed = line.trim();
  if (trimmed === "") return { kind: "other" };
  let obj: {
    type?: string;
    event?: { type?: string; delta?: { type?: string; text?: unknown } };
  };
  try {
    obj = JSON.parse(trimmed);
  } catch {
    return { kind: "other" };
  }
  if (
    obj?.type === "stream_event" &&
    obj.event?.type === "content_block_delta" &&
    obj.event?.delta?.type === "text_delta" &&
    typeof obj.event.delta.text === "string"
  ) {
    return { kind: "delta", text: obj.event.delta.text };
  }
  if (obj?.type === "result") {
    return { kind: "result", result: parseCliResult(obj) };
  }
  return { kind: "other" };
}

// Per-call timeout. Generous default (10 minutes for prose), overridable.
function cliTimeoutMs(): number {
  const raw = process.env.CLAUDE_CODE_TIMEOUT_MS;
  const n = raw ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 600000;
}

interface ResolvedBinary {
  command: string;
  useShell: boolean;
}

// Recover the real claude.exe path that an npm-generated claude.cmd shim invokes,
// so we can spawn it directly (shell:false) rather than through a shell.
function exeFromCmdShim(cmdPath: string): string | null {
  try {
    const text = readFileSync(cmdPath, "utf8");
    const m = text.match(/%~?dp0%\\+([^"\r\n]*claude\.exe)/i);
    if (!m) return null;
    const exe = join(dirname(cmdPath), m[1]);
    return existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

// Locate the CLI. CLAUDE_CODE_BIN overrides everything. On Windows we prefer a
// real .exe spawned with shell:false: modern Node refuses to spawn a .cmd/.bat
// with shell:false (EINVAL), and shell:true mangles empty-string and multi-line
// argv entries (our --tools "" and --system-prompt). We search PATH for
// claude.exe, then read the npm claude.cmd shim to find the nested claude.exe it
// launches, and only fall back to a shell as a last resort. See D64.
function resolveClaudeBinary(): ResolvedBinary {
  const override = process.env.CLAUDE_CODE_BIN;
  if (override && override.trim() !== "") {
    return { command: override, useShell: false };
  }
  if (process.platform !== "win32") {
    return { command: "claude", useShell: false };
  }
  const dirs = (process.env.PATH ?? "")
    .split(";")
    .filter((d) => d.trim() !== "");
  for (const dir of dirs) {
    const exe = join(dir, "claude.exe");
    if (existsSync(exe)) return { command: exe, useShell: false };
  }
  for (const dir of dirs) {
    const cmd = join(dir, "claude.cmd");
    if (existsSync(cmd)) {
      const exe = exeFromCmdShim(cmd);
      if (exe) return { command: exe, useShell: false };
      return { command: cmd, useShell: true };
    }
  }
  return { command: "claude", useShell: true };
}

function spawnError(err: NodeJS.ErrnoException): ClaudeCodeError {
  if (err.code === "ENOENT" || err.code === "EINVAL") {
    return new ClaudeCodeError(
      "Could not launch the Claude Code CLI. Install it (npm i -g @anthropic-ai/claude-code) and log in, set CLAUDE_CODE_BIN to the claude executable, or set CLAUDE_CODE_OAUTH_TOKEN for headless auth.",
      { transient: true },
    );
  }
  return new ClaudeCodeError(
    `Failed to launch the Claude Code CLI: ${err.message}`,
    { transient: true },
  );
}

function cliExitMessage(code: number | null, stderr: string): string {
  const s = stderr.trim();
  return `Claude Code CLI exited with code ${code}.${
    s ? " " + s : ""
  } If this is an auth problem, run \`claude\` to log in, or set CLAUDE_CODE_OAUTH_TOKEN.`;
}

// A10: the claude-code transport's per-process memory of live CLI sessions, one
// per conversation key. Bounded with oldest-first eviction; losing an entry is
// always safe because the chat client sends the full transcript every turn, so
// the next turn re-seeds a fresh session losslessly.
export class SessionStore {
  private map = new Map<string, string>();
  constructor(private readonly maxEntries: number = 64) {}
  get(key: string): string | undefined {
    return this.map.get(key);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  set(key: string, sessionId: string): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, sessionId);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }
  delete(key: string): void {
    this.map.delete(key);
  }
  get size(): number {
    return this.map.size;
  }
}

// A10: a --resume against a session the CLI no longer has fails with this text
// (on stderr in json mode, in the result event's errors array in stream-json
// mode; both flow into the ClaudeCodeError message). Verified against the
// installed CLI before coding.
function isSessionNotFound(err: unknown): boolean {
  return (
    err instanceof ClaudeCodeError &&
    err.message.includes("No conversation found with session ID")
  );
}

export class ClaudeCodeClient implements LlmClient {
  // A10: conversation key to CLI session id.
  private readonly sessions = new SessionStore();

  hasSession(key: string): boolean {
    return this.sessions.has(key);
  }

  // Retry once on transient errors (spawn failure, non-4xx CLI error), then
  // surface. Mirrors AnthropicClient.withRetry; only complete() retries, matching
  // AnthropicClient (a partially streamed generator cannot be safely replayed).
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const transient = err instanceof ClaudeCodeError ? err.transient : false;
      if (!transient) throw err;
      return await fn();
    }
  }

  async complete(opts: CompleteOptions): Promise<CompleteResult> {
    const resume = opts.sessionKey
      ? this.sessions.get(opts.sessionKey)
      : undefined;
    const attempt = (resumeSessionId: string | undefined) =>
      this.withRetry(() =>
        this.runJsonCall(
          buildCliArgs({
            model: opts.model,
            system: opts.system,
            streaming: false,
            persistSession: opts.sessionKey !== undefined,
            resumeSessionId,
          }),
          // Resumed calls send only the new remainder: the prefix (and prior
          // turns) already live in the session. Fresh calls concatenate so the
          // model sees a prompt byte-identical to the api-key transport (A7).
          resumeSessionId !== undefined
            ? opts.prompt
            : (opts.promptPrefix ?? "") + opts.prompt,
        ),
      );
    let result: CompleteResult;
    try {
      result = await attempt(resume);
    } catch (err) {
      // The session evaporated (CLI cleanup, restart of another kind): drop it
      // and run fresh. The recovered turn loses prior-transcript context at
      // worst; the following turn re-seeds fully from the client transcript.
      if (resume === undefined || !opts.sessionKey || !isSessionNotFound(err)) {
        throw err;
      }
      this.sessions.delete(opts.sessionKey);
      result = await attempt(undefined);
    }
    if (opts.sessionKey && result.sessionId) {
      this.sessions.set(opts.sessionKey, result.sessionId);
    }
    return result;
  }

  private runJsonCall(args: string[], payload: string): Promise<CompleteResult> {
    return new Promise<CompleteResult>((resolvePromise, reject) => {
          const { command, useShell } = resolveClaudeBinary();
          const child = spawn(command, args, {
            shell: useShell,
            windowsHide: true,
          });
          let stdout = "";
          let stderr = "";
          let settled = false;
          const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
          };
          const timer = setTimeout(() => {
            child.kill();
            finish(() =>
              reject(
                new ClaudeCodeError(
                  `Claude Code CLI timed out after ${cliTimeoutMs()}ms.`,
                  { transient: false },
                ),
              ),
            );
          }, cliTimeoutMs());
          child.stdout?.on("data", (d) => (stdout += d.toString()));
          child.stderr?.on("data", (d) => (stderr += d.toString()));
          child.on("error", (err) =>
            finish(() => reject(spawnError(err as NodeJS.ErrnoException))),
          );
          child.on("close", (code) =>
            finish(() => {
              if (code !== 0 && stdout.trim() === "") {
                reject(
                  new ClaudeCodeError(cliExitMessage(code, stderr), {
                    transient: true,
                  }),
                );
                return;
              }
              let json: unknown;
              try {
                json = JSON.parse(stdout);
              } catch {
                reject(
                  new ClaudeCodeError(
                    `Claude Code CLI produced unparseable JSON output. stderr: ${stderr.trim()}`,
                    { transient: true },
                  ),
                );
                return;
              }
              try {
                resolvePromise(parseCliResult(json));
              } catch (err) {
                reject(err);
              }
            }),
          );
      child.stdin?.on("error", () => {
        // The child may exit before stdin drains; the close handler reports it.
        // Without this listener an EPIPE here (bad model id, expired CLI auth,
        // an unknown flag after an upgrade) is an uncaught exception that kills
        // the server on one authenticated request. See D188.
      });
      child.stdin?.write(payload);
      child.stdin?.end();
    });
  }

  // A10: the public stream() wraps rawStream so a resumed call whose session
  // evaporated can restart fresh, provided nothing has been yielded yet (nothing
  // was streamed, so the restart is invisible to the caller).
  async *stream(
    opts: CompleteOptions,
  ): AsyncGenerator<string, CompleteResult, unknown> {
    const key = opts.sessionKey;
    const resume = key ? this.sessions.get(key) : undefined;
    let yielded = false;
    // The inner generator must be explicitly closed when this wrapper is
    // abandoned early (a client disconnect returns this generator), so its
    // finally runs and the CLI child is killed. Abandonment does not propagate
    // to manually iterated inner generators on its own.
    let inner: AsyncGenerator<string, CompleteResult, unknown> | null = null;
    let innerSettled = false;
    try {
      inner = this.rawStream(opts, resume);
      try {
        while (true) {
          const { value, done } = await inner.next();
          if (done) {
            innerSettled = true;
            if (key && value.sessionId) this.sessions.set(key, value.sessionId);
            return value;
          }
          yielded = true;
          yield value;
        }
      } catch (err) {
        innerSettled = true;
        if (resume === undefined || !key || yielded || !isSessionNotFound(err)) {
          throw err;
        }
        this.sessions.delete(key);
        inner = this.rawStream(opts, undefined);
        innerSettled = false;
        while (true) {
          const { value, done } = await inner.next();
          if (done) {
            innerSettled = true;
            if (value.sessionId) this.sessions.set(key, value.sessionId);
            return value;
          }
          yield value;
        }
      }
    } finally {
      if (inner && !innerSettled) {
        void inner.return(undefined as unknown as CompleteResult);
      }
    }
  }

  private async *rawStream(
    opts: CompleteOptions,
    resumeSessionId: string | undefined,
  ): AsyncGenerator<string, CompleteResult, unknown> {
    const payload =
      resumeSessionId !== undefined
        ? opts.prompt
        : (opts.promptPrefix ?? "") + opts.prompt;
    const args = buildCliArgs({
      model: opts.model,
      system: opts.system,
      streaming: true,
      persistSession: opts.sessionKey !== undefined,
      resumeSessionId,
    });
    const { command, useShell } = resolveClaudeBinary();
    const child = spawn(command, args, { shell: useShell, windowsHide: true });
    let stderr = "";
    let spawnErr: ClaudeCodeError | null = null;
    let timedOut = false;
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      spawnErr = spawnError(err as NodeJS.ErrnoException);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, cliTimeoutMs());
    child.stdin?.on("error", () => {
      // The child may exit before stdin drains; the close handler reports it.
      // Without this listener an EPIPE here (bad model id, expired CLI auth,
      // an unknown flag after an upgrade) is an uncaught exception that kills
      // the server on one authenticated request. See D188.
    });
    child.stdin?.write(payload);
    child.stdin?.end();

    let buffer = "";
    let text = "";
    let finalResult: CompleteResult | null = null;
    const consume = (line: string): string | null => {
      const parsed = parseStreamEvent(line);
      if (parsed.kind === "delta") {
        text += parsed.text;
        return parsed.text;
      }
      if (parsed.kind === "result") {
        finalResult = parsed.result;
      }
      return null;
    };

    // False until the read loop finishes on its own. When the caller abandons
    // the generator early (client disconnect: gen.return() resumes execution at
    // this try's finally), the child is still running and must be killed, or it
    // would burn tokens with nobody reading.
    let readToEnd = false;
    try {
      if (!child.stdout) {
        throw new ClaudeCodeError("Claude Code CLI produced no stdout stream.", {
          transient: true,
        });
      }
      for await (const chunk of child.stdout) {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const delta = consume(line);
          if (delta !== null) yield delta;
        }
      }
      if (buffer.trim() !== "") {
        const delta = consume(buffer);
        if (delta !== null) yield delta;
      }
      readToEnd = true;
    } finally {
      clearTimeout(timer);
      if (!readToEnd && child.exitCode === null && child.signalCode === null) {
        child.kill();
      }
    }

    const code: number | null = await new Promise((res) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        res(child.exitCode);
      } else {
        child.on("close", (c) => res(c));
      }
    });

    if (spawnErr) throw spawnErr;
    if (timedOut) {
      throw new ClaudeCodeError(
        `Claude Code CLI timed out after ${cliTimeoutMs()}ms.`,
        { transient: false },
      );
    }
    if (!finalResult) {
      if (code !== 0) throw new ClaudeCodeError(cliExitMessage(code, stderr));
      throw new ClaudeCodeError(
        `Claude Code CLI stream ended without a result. stderr: ${stderr.trim()}`,
        { transient: true },
      );
    }
    const result: CompleteResult = finalResult;
    return {
      text,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      sessionId: result.sessionId,
    };
  }
}

let _client: LlmClient | null = null;

// Transport selection (A7), in priority order: USE_FIXTURE_LLM=1 always keeps
// the fixture player (the test loop never makes real calls); otherwise
// LLM_TRANSPORT selects the transport, defaulting to "claude-code". Only the
// explicit value "api-key" chooses the ANTHROPIC_API_KEY-backed client; any other
// value (including unset) is the Claude Code CLI transport. See D63.
export function getLlmClient(): LlmClient {
  if (_client) return _client;
  if (process.env.USE_FIXTURE_LLM === "1") {
    _client = new FixtureClient();
  } else if (process.env.LLM_TRANSPORT === "api-key") {
    _client = new AnthropicClient();
  } else {
    _client = new ClaudeCodeClient();
  }
  return _client;
}

// Test hook: force a specific client.
export function __setLlmClient(client: LlmClient | null) {
  _client = client;
}
