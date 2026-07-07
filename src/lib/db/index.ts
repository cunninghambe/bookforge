import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type Database from "better-sqlite3";
import { openRawDb } from "./raw";
import { migrateAndSeed } from "./migrate";
import * as schema from "./schema";

// Singleton Drizzle client. Opens the DB, runs idempotent migrations + seed once
// per process, and hands back a typed client. Server-side only: importing this in
// a client component will fail because better-sqlite3 is a native module.

let _sqlite: Database.Database | null = null;
let _db: BetterSQLite3Database<typeof schema> | null = null;

export function getDb(): BetterSQLite3Database<typeof schema> {
  if (_db) return _db;
  _sqlite = openRawDb();
  migrateAndSeed(_sqlite);
  _db = drizzle(_sqlite, { schema });
  return _db;
}

// Raw handle for the rare case a route needs prepared statements or transactions
// that Drizzle does not express cleanly.
export function getRawDb(): Database.Database {
  if (!_sqlite) getDb();
  return _sqlite as Database.Database;
}

export { schema };
