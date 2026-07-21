#!/usr/bin/env node
// DEMO FIXTURE SEED — populate the LOCAL / fixture pilot with realistic,
// evidence-honest sample data so every panel renders before a tester has
// connected their own AWS.
//
// STRICT SAFETY. This script:
//   * runs ONLY in local/fixture mode (SUTRA_LOCAL_MODE=true and
//     SUTRA_COLLECTOR_MODE=fixture) and REFUSES otherwise;
//   * REFUSES when live AWS is enabled (SUTRA_ALLOW_LIVE_AWS=true), when a real
//     AWS trust-role connection already exists, or when a DATABASE_URL is set
//     (that is the Postgres/hosted path — never the local fixture store);
//   * writes ONLY to the local Cloudflare D1 sqlite file the pilot uses, and
//     ONLY under the bundled "northstar-retail" simulated-fixture demo tenant;
//   * is IDEMPOTENT: every write replaces (by natural key) rather than
//     duplicates, so re-running is safe.
//
// It NEVER fabricates data in a real tenant: there is no code path that writes
// unless all of the local-mode guards pass. All data is DISCLOSED as demo by the
// fact that it exists only in local fixture mode, is authored by "demo-seed",
// and hangs off a connection whose source_kind is "simulated_fixture".
//
// The actual shaping lives in the pure lib/demo-seed-fixtures.ts helper; all I/O,
// guarding and persistence live here. Persistence reuses the real, validated
// repositories (finops / saved-report / alert-rule / cmdb / kubernetes) through
// a thin D1-over-node:sqlite adapter, so nothing bypasses their honesty checks.
//
// Usage:
//   node scripts/seed-demo-data.mjs [--db <path-to.sqlite>] [--dry-run]
// The local pilot must have booted at least once (so the D1 file exists) and be
// STOPPED while seeding.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { register } from "node:module";
import { DatabaseSync } from "node:sqlite";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const DEFAULT_D1_DIR = resolve(root, ".wrangler/state/v3/d1/miniflare-D1DatabaseObject");
const LOCAL_ORG_SLUG = "local-sutra";
const LOCAL_ORG_NAME = "Sutra local MSP";
const LOCAL_FIXTURE_PACK = "sutra-simulated-2026-07";

class SeedRefusal extends Error {}

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 && typeof process.argv[index + 1] === "string" ? process.argv[index + 1] : undefined;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);

// --- Config: process.env plus a parsed view of .dev.vars (local-mode flags). --
// Both sources are kept separate so guards can be FAIL-SAFE: a required enabling
// flag must be present in the effective config, while any DANGER signal from
// EITHER source (ambient env or .dev.vars) forces a refusal — an ambient env can
// never mask a danger the file omitted, and the file can never mask an ambient
// danger.
function loadConfig() {
  const devVars = {};
  const variablesPath = resolve(root, process.env.SUTRA_LOCAL_CONFIG_PATH ?? ".dev.vars");
  if (existsSync(variablesPath)) {
    for (const rawLine of readFileSync(variablesPath, "utf8").split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const separator = line.indexOf("=");
      if (separator < 1) continue;
      devVars[line.slice(0, separator)] = line.slice(separator + 1);
    }
  }
  const procEnv = process.env;
  // Effective value for a flag: .dev.vars is the local source of truth, else env.
  const effective = (key) => devVars[key] ?? procEnv[key];
  // Any source is enough to trip a danger guard.
  const anyEquals = (key, value) => devVars[key] === value || procEnv[key] === value;
  const anySet = (key) => (devVars[key] ?? "").trim().length > 0 || (procEnv[key] ?? "").trim().length > 0;
  return { devVars, procEnv, effective, anyEquals, anySet };
}

// --- Environment guards (evaluated BEFORE any database is opened). ------------
function assertLocalModeOrRefuse(config) {
  if (config.effective("SUTRA_LOCAL_MODE") !== "true") {
    throw new SeedRefusal(
      "REFUSED: the demo seed runs only in local mode (SUTRA_LOCAL_MODE=true). " +
      "This environment is not the local fixture pilot — nothing was written.",
    );
  }
  if (config.effective("SUTRA_COLLECTOR_MODE") !== "fixture") {
    throw new SeedRefusal(
      "REFUSED: the demo seed runs only in fixture collector mode " +
      `(SUTRA_COLLECTOR_MODE=fixture); found "${config.effective("SUTRA_COLLECTOR_MODE") ?? "unset"}". Nothing was written.`,
    );
  }
  if (config.anyEquals("SUTRA_ALLOW_LIVE_AWS", "true")) {
    throw new SeedRefusal(
      "REFUSED: live AWS is enabled (SUTRA_ALLOW_LIVE_AWS=true). The demo seed never " +
      "writes when a tenant can reach real AWS. Nothing was written.",
    );
  }
  if (config.anySet("DATABASE_URL")) {
    throw new SeedRefusal(
      "REFUSED: a DATABASE_URL is configured. The demo seed only ever touches the " +
      "local Cloudflare D1 fixture store, never a Postgres/hosted database. Nothing was written.",
    );
  }
}

// --- Locate the pilot's local D1 sqlite file. --------------------------------
function locateD1File(config) {
  const override = arg("db") ?? config.effective("SUTRA_LOCAL_D1_PATH");
  if (typeof override === "string" && override.length > 0) {
    const path = resolve(root, override);
    if (!existsSync(path)) throw new SeedRefusal(`REFUSED: the D1 file "${path}" does not exist.`);
    return path;
  }
  if (!existsSync(DEFAULT_D1_DIR)) {
    throw new SeedRefusal(
      "REFUSED: the local D1 store was not found. Boot the local pilot once " +
      "(pnpm dev:pilot) so the database is created, then re-run the seed.",
    );
  }
  const candidates = readdirSync(DEFAULT_D1_DIR)
    .filter((name) => name.endsWith(".sqlite") && !name.startsWith("metadata"))
    .map((name) => resolve(DEFAULT_D1_DIR, name));
  if (candidates.length === 0) {
    throw new SeedRefusal(
      "REFUSED: no local D1 database file was found. Boot the local pilot once " +
      "(pnpm dev:pilot) so the database is created, then re-run the seed.",
    );
  }
  if (candidates.length > 1) {
    throw new SeedRefusal(
      `REFUSED: found ${candidates.length} local D1 files; pass --db <path> to pick one.`,
    );
  }
  return candidates[0];
}

// --- Minimal D1Database implemented over node:sqlite. ------------------------
// It faithfully mirrors the narrow D1 surface the repositories use (prepare /
// bind / run / all / first / batch), so the repositories run unchanged and every
// honesty/validation check still applies. Foreign keys are OFF to match D1.
function coerceParam(value) {
  if (value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return value;
}

class SqliteStatement {
  constructor(database, sql, params) {
    this.database = database;
    this.sql = sql;
    this.params = params ?? [];
  }

  bind(...params) {
    return new SqliteStatement(this.database, this.sql, params.map(coerceParam));
  }

  async run() {
    // Parameterless runs are schema DDL that may bundle several statements in one
    // string (drizzle migration files without statement-breakpoints). D1/Miniflare
    // executes every statement in such a run; node:sqlite's prepare compiles only
    // the first, so route these through exec() to apply them all. Statements with
    // bound params are always single writes where the change count matters.
    if (this.params.length === 0) {
      this.database.exec(this.sql);
      return { success: true, meta: { changes: 0, last_row_id: 0 }, results: [] };
    }
    const info = this.database.prepare(this.sql).run(...this.params);
    return {
      success: true,
      meta: { changes: Number(info.changes ?? 0), last_row_id: Number(info.lastInsertRowid ?? 0) },
      results: [],
    };
  }

  async all() {
    const rows = this.database.prepare(this.sql).all(...this.params);
    return { success: true, results: rows, meta: { changes: 0 } };
  }

  async first(column) {
    const row = this.database.prepare(this.sql).get(...this.params);
    if (row === undefined || row === null) return null;
    return typeof column === "string" ? row[column] ?? null : row;
  }
}

function makeD1(database) {
  return {
    prepare(sql) {
      return new SqliteStatement(database, sql);
    },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* ignore */ }
        throw error;
      }
    },
    async exec(sql) {
      database.exec(sql);
      return { count: 0, duration: 0 };
    },
  };
}

function fixtureSlug(fixtureId) {
  return `fixture-${createHash("sha256").update(fixtureId, "utf8").digest("hex").slice(0, 20)}`;
}

// --- Ensure the honest demo tenant (org + customer + simulated_fixture connection).
async function ensureDemoTenant(db, demo, now) {
  const slug = fixtureSlug(demo.DEMO_FIXTURE_ID);
  await db.batch([
    db.prepare(
      `INSERT OR IGNORE INTO organizations (id, slug, name, status, created_at) VALUES (?, ?, ?, 'active', ?)`,
    ).bind(demo.DEMO_ORG_ID, LOCAL_ORG_SLUG, LOCAL_ORG_NAME, now),
    db.prepare(
      `INSERT OR IGNORE INTO customers (id, org_id, slug, name, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'active', ?, ?)`,
    ).bind(demo.DEMO_CUSTOMER_ID, demo.DEMO_ORG_ID, slug, demo.DEMO_CUSTOMER_NAME, now, now),
    db.prepare(
      `INSERT OR IGNORE INTO aws_connections
        (id, org_id, customer_id, source_kind, fixture_id, fixture_version,
         partition, aws_account_id, role_arn, external_id_ciphertext,
         external_id_key_version, permission_pack_version, status,
         enabled_regions_json, last_validated_at, created_at, updated_at)
       VALUES (?, ?, ?, 'simulated_fixture', ?, NULL, ?, ?, '', '', '', ?, 'active', ?, NULL, ?, ?)`,
    ).bind(
      demo.DEMO_CONNECTION_ID, demo.DEMO_ORG_ID, demo.DEMO_CUSTOMER_ID, demo.DEMO_FIXTURE_ID,
      demo.DEMO_PARTITION, demo.DEMO_ACCOUNT_ID, LOCAL_FIXTURE_PACK,
      JSON.stringify(demo.DEMO_REGIONS), now, now,
    ),
  ]);
}

// --- Database-level guard: never seed when a real trust-role connection exists.
async function assertNoRealConnection(db) {
  let row;
  try {
    row = await db.prepare(
      `SELECT COUNT(*) AS total FROM aws_connections WHERE source_kind IS NOT 'simulated_fixture'`,
    ).first();
  } catch {
    return; // Table absent on a brand-new store: no real connection can exist.
  }
  if (Number(row?.total ?? 0) > 0) {
    throw new SeedRefusal(
      "REFUSED: a real (trust-role) AWS connection exists in this workspace. The demo " +
      "seed only writes to a pristine local fixture workspace. Nothing was written.",
    );
  }
}

async function main() {
  const config = loadConfig();
  const dryRun = hasFlag("dry-run");

  process.stdout.write("Sutra demo fixture seed (local/fixture mode only)\n");
  assertLocalModeOrRefuse(config);

  // Refuse to run against a live/serving local pilot (mirrors backup/restore).
  const { assertLocalServicesStopped } = await import("./local-data-utils.mjs");
  await assertLocalServicesStopped("seeding demo data");

  const d1Path = locateD1File(config);
  process.stdout.write(`Local D1 store: ${d1Path}\n`);

  // Resolve TypeScript + cloudflare:workers + .sql?raw imports exactly like the
  // repository tests do, then load the real repositories and the pure fixtures.
  register(new URL("../tests/cloudflare-loader.mjs", import.meta.url));
  const runtimeMigrations = await import("../db/runtime-migrations.ts");
  const { FinopsWorkspaceRepository } = await import("../db/finops-workspace-repository.ts");
  const { FinopsUnitCountRepository } = await import("../db/finops-unit-count-repository.ts");
  const { SavedReportRepository } = await import("../db/saved-report-repository.ts");
  const { AlertRuleRepository } = await import("../db/alert-rule-repository.ts");
  const { CmdbCustomAssetRepository } = await import("../db/cmdb-custom-asset-repository.ts");
  const { CmdbRelationshipRepository } = await import("../db/cmdb-relationship-repository.ts");
  const { KubernetesRepository } = await import("../db/kubernetes-repository.ts");
  const demo = await import("../lib/demo-seed-fixtures.ts");

  const database = new DatabaseSync(d1Path, { enableForeignKeyConstraints: false });
  const db = makeD1(database);
  const scope = { orgId: demo.DEMO_ORG_ID, customerId: demo.DEMO_CUSTOMER_ID };
  const now = Date.now();
  const summary = {};

  try {
    runtimeMigrations.resetRuntimeSchemaCacheForTests();
    await runtimeMigrations.ensureRuntimeSchema(db);
    await assertNoRealConnection(db);

    if (dryRun) {
      process.stdout.write("Dry run: guards passed and schema is ready. No data was written.\n");
      return;
    }

    await ensureDemoTenant(db, demo, now);

    // 1. FinOps CUR lines — 3 months, multi-service, covered + fee + anomaly + untagged.
    const finops = new FinopsWorkspaceRepository(db);
    let curInserted = 0;
    for (const { period, lines } of demo.buildDemoCurPeriods()) {
      const result = await finops.replacePeriod(scope, demo.DEMO_CONNECTION_ID, period, lines, now);
      curInserted += result.inserted;
    }
    summary.curLines = curInserted;

    // 2. Budgets (breach / utilization panels).
    let budgets = 0;
    for (const budget of demo.buildDemoBudgets()) {
      await finops.saveBudget(scope, budget, demo.DEMO_CREATED_BY, now);
      budgets += 1;
    }
    summary.budgets = budgets;

    // 3. Unit counts (unit-economics denominators).
    const unitCounts = new FinopsUnitCountRepository(db);
    let counts = 0;
    for (const unit of demo.buildDemoUnitCounts()) {
      await unitCounts.upsert(scope, unit, now);
      counts += 1;
    }
    summary.unitCounts = counts;

    // 4. Saved report view.
    const savedReport = demo.buildDemoSavedReport();
    await new SavedReportRepository(db).save(scope, savedReport.name, savedReport.definition, demo.DEMO_CREATED_BY, now);
    summary.savedReports = 1;

    // 5. Alert rules.
    const alerts = new AlertRuleRepository(db);
    let alertRules = 0;
    for (const rule of demo.buildDemoAlertRules()) {
      await alerts.save(scope, rule, demo.DEMO_CREATED_BY, now);
      alertRules += 1;
    }
    summary.alertRules = alertRules;

    // 6. Custom / external CMDB assets.
    const customAssets = new CmdbCustomAssetRepository(db);
    let assets = 0;
    for (const asset of demo.buildDemoCustomAssets()) {
      await customAssets.upsert(scope, asset, demo.DEMO_CREATED_BY, now);
      assets += 1;
    }
    summary.customAssets = assets;

    // 7. One manual CMDB relationship.
    await new CmdbRelationshipRepository(db).add(scope, demo.buildDemoRelationship(), demo.DEMO_CREATED_BY, now);
    summary.manualRelationships = 1;

    // 8. One COMPLETE Kubernetes scan (posture + cost allocation).
    const kubernetes = new KubernetesRepository(db);
    const scan = demo.buildDemoKubernetesScan();
    const cluster = await kubernetes.registerCluster({
      scope,
      clusterUid: scan.clusterUid,
      name: scan.clusterName,
      distribution: scan.distribution,
      version: scan.version,
    });
    await kubernetes.publishScan({
      scope,
      clusterId: cluster.id,
      idempotencyKey: scan.idempotencyKey,
      status: scan.status,
      evidence: scan.evidence,
      coverage: scan.coverage,
    });
    summary.kubernetesScans = 1;
  } finally {
    database.close();
  }

  process.stdout.write(`Seeded demo tenant ${scope.customerId} (${demo.DEMO_CUSTOMER_NAME}):\n`);
  for (const [key, value] of Object.entries(summary)) {
    process.stdout.write(`  ${key}: ${value}\n`);
  }
  process.stdout.write("Done. This is DEMO data, present only in local fixture mode.\n");
}

main().catch((error) => {
  if (error instanceof SeedRefusal) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`Demo seed failed: ${error?.stack ?? error}\n`);
  process.exitCode = 1;
});
