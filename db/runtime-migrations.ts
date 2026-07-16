import baseSchemaSql from "../drizzle/0000_wild_lenny_balinger.sql?raw";
import pilotSchemaSql from "../drizzle/0001_good_sunspot.sql?raw";
import localAuthSchemaSql from "../drizzle/0002_aspiring_terrax.sql?raw";

const BREAKPOINT = "--> statement-breakpoint";

let schemaReady: Promise<void> | undefined;

function statementsFrom(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const schemaStatements = [
  ...statementsFrom(baseSchemaSql),
  ...statementsFrom(pilotSchemaSql),
  ...statementsFrom(localAuthSchemaSql),
];

/**
 * The local pilot creates the checked-in schema lazily inside Miniflare D1.
 * Production deployments still use the same generated migrations as a
 * separately approved release step.
 */
export function ensureRuntimeSchema(db: D1Database): Promise<void> {
  schemaReady ??= (async () => {
    for (const statement of schemaStatements) {
      try {
        await db.prepare(statement).run();
      } catch (error) {
        // CREATE TABLE/INDEX statements are idempotent only when generated with
        // IF NOT EXISTS. Drizzle migrations are not, so an already-created
        // object is the sole safe error to ignore during local startup races.
        const message = error instanceof Error ? error.message : String(error);
        if (!/already exists/i.test(message)) {
          throw error;
        }
      }
    }
  })();

  return schemaReady;
}

export function resetRuntimeSchemaCacheForTests(): void {
  schemaReady = undefined;
}
