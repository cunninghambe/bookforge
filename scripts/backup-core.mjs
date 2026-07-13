// Core backup logic, importable and unit tested. The CLI wrapper (backup.mjs)
// stays a thin shell around this. Plain Node ESM, no TypeScript, no build step,
// so `node scripts/backup.mjs` works straight from a checkout or a container.

import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { basename, join } from "node:path";

// YYYYMMDD-HHmmss, local time, zero padded. Filenames only need to sort and be
// unambiguous, not be an ISO timestamp, and local time is what a human doing a
// manual restore will recognize.
export function formatTimestamp(date) {
  const pad = (n) => String(n).padStart(2, "0");
  const y = date.getFullYear();
  const mo = pad(date.getMonth() + 1);
  const d = pad(date.getDate());
  const h = pad(date.getHours());
  const mi = pad(date.getMinutes());
  const s = pad(date.getSeconds());
  return `${y}${mo}${d}-${h}${mi}${s}`;
}

// Copies the SQLite file at dbPath to backupDir with a timestamp suffix.
// SQLite runs in WAL mode here (see src/lib/db/migrate.ts), so a copy of the
// main file alone can miss committed-but-not-checkpointed writes sitting in the
// -wal file. Best-effort: copy the -wal and -shm sidecars too when present, so
// the backup set matches what a fresh `better-sqlite3` open of the main file
// would recover. This is not a substitute for stopping writes during a restore,
// but it is a meaningfully more complete snapshot than the main file alone.
export function backupDbFile({ dbPath, backupDir, now = new Date() }) {
  if (!existsSync(dbPath)) {
    throw new Error(
      `Database file not found at ${dbPath}. Nothing to back up.`,
    );
  }

  if (!existsSync(backupDir)) mkdirSync(backupDir, { recursive: true });

  const stamp = formatTimestamp(now);
  const base = basename(dbPath).replace(/\.db$/, "");
  const targetPath = join(backupDir, `${base}-${stamp}.db`);
  copyFileSync(dbPath, targetPath);

  const copiedSidecars = [];
  for (const ext of ["-wal", "-shm"]) {
    const sidecarSrc = `${dbPath}${ext}`;
    if (existsSync(sidecarSrc)) {
      const sidecarDest = `${targetPath}${ext}`;
      copyFileSync(sidecarSrc, sidecarDest);
      copiedSidecars.push(sidecarDest);
    }
  }

  return { targetPath, copiedSidecars };
}
