import { openRawDb } from "../src/lib/db/raw";
import { migrateAndSeed } from "../src/lib/db/migrate";

// CLI: npm run migrate. Opens the configured DB, applies idempotent DDL and seed.
const sqlite = openRawDb();
migrateAndSeed(sqlite);
// eslint-disable-next-line no-console
console.log("Migrated and seeded:", sqlite.name);
sqlite.close();
