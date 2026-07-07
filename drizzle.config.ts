import type { Config } from "drizzle-kit";

// Drizzle is used for typed query building against the schema in src/lib/db/schema.ts.
// Actual DDL is applied idempotently by src/lib/db/migrate.ts (CREATE TABLE IF NOT
// EXISTS), so this config exists mainly for drizzle-kit introspection tooling.
export default {
  schema: "./src/lib/db/schema.ts",
  out: "./drizzle",
  dialect: "sqlite",
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? "./data/bookforge.db",
  },
} satisfies Config;
