import baseSchemaSql from "../drizzle/0000_wild_lenny_balinger.sql?raw";
import pilotSchemaSql from "../drizzle/0001_good_sunspot.sql?raw";
import localAuthSchemaSql from "../drizzle/0002_aspiring_terrax.sql?raw";
import changeHistorySchemaSql from "../drizzle/0003_opposite_siren.sql?raw";
import localOperationsSchemaSql from "../drizzle/0004_ambiguous_landau.sql?raw";
import activeRunSchemaSql from "../drizzle/0005_tiny_hobgoblin.sql?raw";
import scheduleOutboxSchemaSql from "../drizzle/0006_acoustic_thunderbolt.sql?raw";
import scheduleSequenceSchemaSql from "../drizzle/0007_demonic_hardball.sql?raw";
import scheduleProvenanceSchemaSql from "../drizzle/0008_far_nicolaos.sql?raw";
import costSnapshotsSchemaSql from "../drizzle/0009_acoustic_moondragon.sql?raw";
import operationsWaveSchemaSql from "../drizzle/0010_sutra_operations_wave.sql?raw";
import hostedIdentityLifecycleSchemaSql from "../drizzle/0011_blushing_logan.sql?raw";
import kubernetesPersistenceSchemaSql from "../drizzle/0012_nasty_satana.sql?raw";
import kubernetesScannerEvidenceSchemaSql from "../drizzle/0013_gorgeous_mercury.sql?raw";
import { isPostgresDatabase } from "./postgres-d1-adapter";
import { ensurePostgresRuntimeSchema, resetPostgresRuntimeSchemaCacheForTests } from "./postgres-runtime-migrations";

const BREAKPOINT = "--> statement-breakpoint";

let schemaReady: Promise<void> | undefined;

function statementsFrom(sql: string): string[] {
  return sql
    .split(BREAKPOINT)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

const migrations = [
  { id: "0000_wild_lenny_balinger", statements: statementsFrom(baseSchemaSql) },
  { id: "0001_good_sunspot", statements: statementsFrom(pilotSchemaSql) },
  { id: "0002_aspiring_terrax", statements: statementsFrom(localAuthSchemaSql) },
  { id: "0003_opposite_siren", statements: statementsFrom(changeHistorySchemaSql) },
  { id: "0004_ambiguous_landau", statements: statementsFrom(localOperationsSchemaSql) },
  { id: "0005_tiny_hobgoblin", statements: statementsFrom(activeRunSchemaSql) },
  { id: "0006_acoustic_thunderbolt", statements: statementsFrom(scheduleOutboxSchemaSql) },
  { id: "0007_demonic_hardball", statements: statementsFrom(scheduleSequenceSchemaSql) },
  { id: "0008_far_nicolaos", statements: statementsFrom(scheduleProvenanceSchemaSql) },
  { id: "0009_acoustic_moondragon", statements: statementsFrom(costSnapshotsSchemaSql) },
  { id: "0010_sutra_operations_wave", statements: statementsFrom(operationsWaveSchemaSql) },
  { id: "0011_blushing_logan", statements: statementsFrom(hostedIdentityLifecycleSchemaSql) },
  { id: "0012_nasty_satana", statements: statementsFrom(kubernetesPersistenceSchemaSql) },
  { id: "0013_gorgeous_mercury", statements: statementsFrom(kubernetesScannerEvidenceSchemaSql) },
] as const;

const ADD_COLUMN = /^ALTER TABLE `([A-Za-z0-9_]+)` ADD `([A-Za-z0-9_]+)`\s/iu;
const CREATE_OBJECT = /^CREATE (?:UNIQUE )?(?:TABLE|INDEX|TRIGGER)\s/iu;

async function columnExists(db: D1Database, table: string, column: string): Promise<boolean> {
  const result = await db.prepare(`PRAGMA table_info(\"${table}\")`).all<{ name: string }>();
  return (result.results ?? []).some((candidate) => candidate.name === column);
}

async function applyStatement(db: D1Database, statement: string): Promise<void> {
  const addColumn = ADD_COLUMN.exec(statement);
  if (addColumn !== null && await columnExists(db, addColumn[1], addColumn[2])) return;
  try {
    await db.prepare(statement).run();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (CREATE_OBJECT.test(statement) && /already exists/iu.test(message)) return;
    if (
      addColumn !== null &&
      /duplicate column name/iu.test(message) &&
      await columnExists(db, addColumn[1], addColumn[2])
    ) return;
    throw error;
  }
}

/**
 * The local pilot creates the checked-in schema lazily inside Miniflare D1.
 * Production deployments still use the same generated migrations as a
 * separately approved release step.
 */
export function ensureRuntimeSchema(db: D1Database): Promise<void> {
  if (isPostgresDatabase(db)) return ensurePostgresRuntimeSchema(db);
  if (schemaReady !== undefined) return schemaReady;
  const attempt = (async () => {
    await db.prepare(
      `CREATE TABLE IF NOT EXISTS sutra_runtime_migrations (
        migration_id text PRIMARY KEY NOT NULL,
        applied_at integer DEFAULT (unixepoch() * 1000) NOT NULL
      )`,
    ).run();
    for (const migration of migrations) {
      const applied = await db.prepare(
        `SELECT migration_id FROM sutra_runtime_migrations WHERE migration_id = ? LIMIT 1`,
      ).bind(migration.id).first<{ migration_id: string }>();
      if (applied !== null) continue;
      for (const statement of migration.statements) {
        await applyStatement(db, statement);
      }
      await db.prepare(
        `INSERT OR IGNORE INTO sutra_runtime_migrations (migration_id) VALUES (?)`,
      ).bind(migration.id).run();
    }
  })();
  schemaReady = attempt;
  void attempt.catch(() => {
    if (schemaReady === attempt) schemaReady = undefined;
  });
  return attempt;
}

export function resetRuntimeSchemaCacheForTests(): void {
  schemaReady = undefined;
  resetPostgresRuntimeSchemaCacheForTests();
}
