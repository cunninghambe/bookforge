#!/usr/bin/env node
// CLI: npm run backup. Copies the SQLite database file (plus WAL/SHM sidecars,
// if present) to a timestamped file under a backups/ directory next to it.
//
// Plain Node, no TS deps: this cannot import src/lib/db/raw.ts (TypeScript), so
// DATABASE_PATH resolution is duplicated here in the same two lines raw.ts
// uses. See DECISIONS.md for the reasoning.

import { resolve, dirname, join } from "node:path";
import { backupDbFile } from "./backup-core.mjs";

function resolveDbPath() {
  const raw = process.env.DATABASE_PATH ?? "./data/bookforge.db";
  return resolve(process.cwd(), raw);
}

const dbPath = resolveDbPath();
// Backups live under a "backups" directory beside the database file, so a
// production DATABASE_PATH on a mounted volume (for example /data/bookforge.db)
// keeps its backups on the same volume rather than an ephemeral container path.
const backupDir = join(dirname(dbPath), "backups");

try {
  const result = backupDbFile({ dbPath, backupDir });
  console.log(`Backup created: ${result.targetPath}`);
  for (const sidecar of result.copiedSidecars) {
    console.log(`Copied sidecar: ${sidecar}`);
  }
} catch (err) {
  console.error(`Backup failed: ${err.message}`);
  process.exit(1);
}
