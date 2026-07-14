import { eq, like } from "drizzle-orm";
import type { BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import * as schema from "../db/schema";

type Db = BetterSQLite3Database<typeof schema>;

// A8: the key/value settings store. Model overrides live under keys
// model.<purpose>; the resolver (src/lib/modelFor.ts) reads them through getSetting.

export function getSetting(db: Db, key: string): string | undefined {
  const row = db
    .select()
    .from(schema.settings)
    .where(eq(schema.settings.key, key))
    .get();
  return row?.value;
}

// Upsert: set (or replace) the value for a key.
export function setSetting(db: Db, key: string, value: string): void {
  db.insert(schema.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: schema.settings.key, set: { value } })
    .run();
}

// Delete a key. A no-op if the key is absent.
export function deleteSetting(db: Db, key: string): void {
  db.delete(schema.settings).where(eq(schema.settings.key, key)).run();
}

// All settings whose key starts with the given prefix.
export function listSettings(
  db: Db,
  prefix: string,
): Array<{ key: string; value: string }> {
  return db
    .select()
    .from(schema.settings)
    .where(like(schema.settings.key, `${prefix}%`))
    .all();
}
