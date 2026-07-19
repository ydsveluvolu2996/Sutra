import { env } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./schema";
import { postgresDatabase } from "./postgres-d1-adapter";

export function getDb() {
  const database = getRawDb();

  return drizzle(database, { schema });
}

export function getRawDb(): D1Database {
  const databaseUrl = env.DATABASE_URL ?? process.env.DATABASE_URL;
  if (databaseUrl !== undefined && databaseUrl.trim().length > 0) {
    return postgresDatabase(databaseUrl.trim());
  }
  if (!env.DB) {
    throw new Error(
      "Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database."
    );
  }

  return env.DB;
}
