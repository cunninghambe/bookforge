import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// Resolves the DB file path from DATABASE_PATH (default ./data/bookforge.db),
// ensures the parent directory exists, and opens a raw better-sqlite3 handle.
export function resolveDbPath(): string {
  const raw = process.env.DATABASE_PATH ?? "./data/bookforge.db";
  return resolve(process.cwd(), raw);
}

export function openRawDb(path?: string): Database.Database {
  const dbPath = path ?? resolveDbPath();
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return new Database(dbPath);
}
