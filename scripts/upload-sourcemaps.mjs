#!/usr/bin/env node
// CLI: npm run upload-sourcemaps. Thin wrapper around the vendored
// scripts/uh-oh-upload-sourcemaps.mjs (kept byte-identical to the uh-oh
// source so it can be re-vendored cleanly) that resolves the release string
// this app already uses for crash reporting and forwards it as --release.
//
// Plain Node, no TS deps: this cannot import src/lib/uh-oh-release.ts
// (TypeScript), so the same "<package.json version>+0" convention is
// duplicated here in one line (same reasoning backup.mjs records for
// duplicating DATABASE_PATH resolution: a plain-Node script cannot import
// TypeScript).
//
// Safe with no uh-oh env configured: the vendored script no-ops (exit 0)
// when UH_OH_SERVER_URL / UH_OH_SYMBOL_TOKEN / UH_OH_PROJECT are unset, so
// this is safe to wire into every build unconditionally.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
const release = `${pkg.version}+0`;

const extraArgs = process.argv.slice(2);

const result = spawnSync(
  process.execPath,
  [
    join(here, "uh-oh-upload-sourcemaps.mjs"),
    "--dir",
    ".next",
    "--release",
    release,
    "--delete-browser-maps",
    ...extraArgs,
  ],
  { stdio: "inherit" },
);

if (result.error) {
  console.error(`upload-sourcemaps: failed to start: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
