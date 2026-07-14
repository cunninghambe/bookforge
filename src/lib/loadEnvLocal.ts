import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Minimal .env.local loader: standalone entry points (the llm-smoke script and the
// MCP server) do not get Next's env loading, and this repo has no dotenv
// dependency. Only sets keys that are not already present in process.env. Not a
// full dotenv parser (no multi-line values, no interpolation). Extracted from
// scripts/llm-smoke.mjs so the MCP server reuses the exact same parsing (A6).
export function loadEnvLocal(cwd: string = process.cwd()): void {
  const path = resolve(cwd, ".env.local");
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
