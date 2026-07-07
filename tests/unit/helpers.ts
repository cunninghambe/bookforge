import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrateAndSeed } from "@/lib/db/migrate";
import * as schema from "@/lib/db/schema";

// Fresh in-memory database, migrated and seeded, wrapped in Drizzle. Each test
// gets an isolated DB so ordering never matters.
export function testDb() {
  const sqlite = new Database(":memory:");
  migrateAndSeed(sqlite);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}
