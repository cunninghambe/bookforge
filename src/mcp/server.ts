import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadEnvLocal } from "../lib/loadEnvLocal";
import { getDb } from "../lib/db";
import { getLlmClient } from "../lib/llm/client";
import { registerTools } from "./tools";

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

async function main(): Promise<void> {
  // Reuse the exact .env.local parsing the llm-smoke script uses (A6).
  loadEnvLocal();

  const db = getDb();
  const client = getLlmClient();
  const draftModel = process.env.DRAFT_MODEL ?? "claude-sonnet-4-6";
  const utilityModel = process.env.UTILITY_MODEL ?? "claude-sonnet-4-6";

  const server = new McpServer({ name: "bookforge", version: "0.1.0" });
  registerTools(server, { db, client, draftModel, utilityModel });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Do NOT write to stdout: stdout is the MCP transport. Diagnostics go to stderr.
  process.stderr.write("bookforge MCP server ready on stdio\n");
}

main().catch((err) => {
  process.stderr.write(
    `bookforge MCP server failed to start: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exit(1);
});
