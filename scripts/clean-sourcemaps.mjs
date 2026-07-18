#!/usr/bin/env node
// CLI: npm run clean-sourcemaps [dir...]. Recursively deletes every *.map
// file under the given directories (default: .next/static and
// .next/standalone/.next/server): both the *.js.map files that
// productionBrowserSourceMaps / experimental.serverSourceMaps produce and any
// *.css.map Next's CSS pipeline emits alongside them (confirmed present in a
// real build, independent of those two options), so nothing with a .map
// extension is missed.
//
// Always run UNCONDITIONALLY in the Dockerfile builder stage, independent of
// whether `npm run upload-sourcemaps` ran, no-opped (no uh-oh env set), or
// partially failed, so a production image never ships a source map:
//   - .next/static/**/*.map are browser maps; Next serves .next/static
//     publicly at /_next/static, so leaving one there leaks source there.
//   - .next/standalone/.next/server/**/*.map are server maps traced into
//     the standalone output that actually ships to the runtime image. They
//     are not served over HTTP by any route, but once uploaded they are
//     dead weight (and unnecessary debug-info exposure inside the image),
//     so they are swept too.
// See DECISIONS.md and DEPLOY.md for the full reasoning.
//
// Missing directories are silently skipped: a repo without a prior build, or
// a build where a source-map option produced nothing, is not an error.

import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_DIRS = [".next/static", ".next/standalone/.next/server"];

function walk(dir, onFile) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return; // missing dir: nothing to clean
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, onFile);
    } else if (entry.isFile() && full.endsWith(".map")) {
      onFile(full);
    }
  }
}

const dirs = process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_DIRS;
let deleted = 0;
for (const dir of dirs) {
  walk(dir, (file) => {
    rmSync(file);
    deleted++;
  });
}
console.log(`clean-sourcemaps: deleted ${deleted} source map file(s) under ${dirs.join(", ")}`);
