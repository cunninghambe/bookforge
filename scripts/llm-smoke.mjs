// CLI: npm run llm-smoke. Makes ONE tiny real LLM call through the currently
// selected transport (claude-code by default, or api-key), prints the reply, the
// transport used, and the token/cache usage, and exits nonzero with a clear
// message if auth is missing. NOT part of npm test: it is a human/orchestrator
// end-to-end auth check. Run via tsx so it can import the TypeScript client.
//
// A7. See DECISIONS D63-D69.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getLlmClient } from "../src/lib/llm/client";

// Minimal .env.local loader: standalone scripts do not get Next's env loading,
// and this repo has no dotenv dependency (see backup.mjs precedent). Only sets
// keys that are not already present in process.env. Not a full dotenv parser.
function loadEnvLocal() {
  const path = resolve(process.cwd(), ".env.local");
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

function selectedTransportName() {
  if (process.env.USE_FIXTURE_LLM === "1") return "fixture";
  if (process.env.LLM_TRANSPORT === "api-key") return "api-key";
  return "claude-code";
}

async function main() {
  loadEnvLocal();
  const transport = selectedTransportName();
  const model = process.env.UTILITY_MODEL ?? "claude-sonnet-4-6";

  // eslint-disable-next-line no-console
  console.log(`Transport: ${transport}`);
  // eslint-disable-next-line no-console
  console.log(`Model: ${model}`);

  const client = getLlmClient();
  const result = await client.complete({
    purpose: "chat",
    model,
    system: "You are a terse assistant. Answer in one short sentence.",
    prompt: "In one sentence, what is a novel?",
  });

  // eslint-disable-next-line no-console
  console.log("\nReply:");
  // eslint-disable-next-line no-console
  console.log(result.text.trim());
  // eslint-disable-next-line no-console
  console.log("\nUsage:");
  // eslint-disable-next-line no-console
  console.log(
    JSON.stringify(
      {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
      },
      null,
      2,
    ),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("\nllm-smoke failed:");
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
