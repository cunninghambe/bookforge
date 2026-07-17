import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnvLocal } from "../lib/loadEnvLocal";
import { getDb } from "../lib/db";
import { getLlmClient } from "../lib/llm/client";
import { registerTools } from "./tools";
import { init, captureException, flush } from "../lib/uh-oh-client";
import { UH_OH_RELEASE } from "../lib/uh-oh-release";

// BookForge MCP server (Amendment A6). A local, single-user stdio process that
// operates directly on the SQLite database through the same repo layer the web
// routes use. It rides the machine's Claude Code auth via the same LLM client
// factory (USE_FIXTURE_LLM for tests, claude-code by default, api-key when
// configured), reads DATABASE_PATH and the model env vars, and speaks MCP over
// stdio.
//
// THE HARD BOUNDARY (SPEC quality bar): the human-only approval gates are NOT
// exposed as tools and must never be. No tool here approves extraction or bible
// proposals, resolves revision hunks, locks (or unlocks) chapters, or imports
// chapters. Those decisions protect quality (the diff-enforcement and
// approval-gate features the SPEC forbids softening) and stay in the web UI where
// a human drives them. The server does not even register such tools, so a
// confused agent cannot be talked into performing one. chapter_update deliberately
// omits status/summary for the same reason: it cannot change a chapter's locked
// state. See DECISIONS D70+ and tests/unit/mcp-server.test.ts, which asserts these
// tools are absent by name.
//
// The MCP server bypasses the web password gate by design: it is a local process
// with the same trust boundary as the SQLite file itself (see DEPLOY.md).

// The MCP client (StdioClientTransport.close()) sends SIGTERM, then SIGKILL after
// its own timeout, to shut this process down. Flush any queued-but-unsent crash
// report before exiting so it is not silently dropped. A no-op (resolves
// immediately) when uh-oh was never initialized (no DSN).
function installShutdownFlush(): void {
  const shutdown = async (): Promise<void> => {
    await flush(2000);
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

async function main(): Promise<void> {
  // Reuse the exact .env.local parsing the llm-smoke script uses (A6).
  loadEnvLocal();

  // Crash reporting (uh-oh, self-hosted). init() without a DSN is a silent
  // no-op (no listeners installed, no console noise), so this ships safely
  // before any server DSN exists. The client never writes to stdout (only
  // console.error/console.warn, and only on an actual internal failure), so
  // it cannot corrupt the MCP stdio transport.
  init({
    dsn: process.env.UH_OH_DSN,
    release: UH_OH_RELEASE,
    environment: process.env.NODE_ENV,
  });
  installShutdownFlush();

  const db = getDb();
  const client = getLlmClient();

  // A8: per-call models are resolved from settings/env by modelFor inside each tool
  // handler, so the server carries no fixed model strings.
  const server = new McpServer({ name: "bookforge", version: "0.1.0" });
  registerTools(server, { db, client });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Do NOT write to stdout: stdout is the MCP transport. Diagnostics go to stderr.
  process.stderr.write("bookforge MCP server ready on stdio\n");
}

main().catch(async (err) => {
  captureException(err);
  await flush(2000);
  process.stderr.write(
    `bookforge MCP server failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
