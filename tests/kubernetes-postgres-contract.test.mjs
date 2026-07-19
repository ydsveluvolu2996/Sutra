import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const [d1Base, d1Scanner, postgresBase, postgresScanner, repository] = await Promise.all([
  readFile(resolve(root, "drizzle/0012_nasty_satana.sql"), "utf8"),
  readFile(resolve(root, "drizzle/0013_gorgeous_mercury.sql"), "utf8"),
  readFile(resolve(root, "postgres/migrations/0006_kubernetes_persistence.sql"), "utf8"),
  readFile(resolve(root, "postgres/migrations/0007_kubernetes_scanner_evidence.sql"), "utf8"),
  readFile(resolve(root, "db/kubernetes-repository.ts"), "utf8"),
]);
const d1Migration = `${d1Base}\n${d1Scanner}`;
const postgresMigration = `${postgresBase}\n${postgresScanner}`;

const tables = [
  "kubernetes_clusters",
  "kubernetes_scan_runs",
  "kubernetes_scan_heads",
  "kubernetes_scan_resources",
  "kubernetes_scan_findings",
  "kubernetes_scan_coverage",
  "kubernetes_scan_scanner_evidence",
];

test("D1 and PostgreSQL migrations contain the same Kubernetes tables and indexes", () => {
  for (const table of tables) {
    assert.match(d1Migration, new RegExp(`CREATE TABLE .?${table}`, "u"));
    assert.match(postgresMigration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`, "u"));
  }
  const indexNames = [...d1Migration.matchAll(/CREATE (?:UNIQUE )?INDEX `([^`]+)`/gu)]
    .map((match) => match[1]).sort();
  for (const index of indexNames) {
    assert.match(postgresMigration, new RegExp(`INDEX IF NOT EXISTS ${index}\\b`, "u"));
  }
});

test("both dialects enforce immutable scan evidence and expose no credential storage", () => {
  for (const table of ["kubernetes_scan_runs", "kubernetes_scan_resources", "kubernetes_scan_findings", "kubernetes_scan_coverage", "kubernetes_scan_scanner_evidence"]) {
    assert.match(d1Migration, new RegExp(`${table}_no_update`, "u"));
    assert.match(d1Migration, new RegExp(`${table}_no_delete`, "u"));
    assert.match(postgresMigration, new RegExp(`${table}_no_update`, "u"));
    assert.match(postgresMigration, new RegExp(`${table}_no_delete`, "u"));
  }
  for (const source of [d1Migration, postgresMigration, repository]) {
    assert.doesNotMatch(source, /\b(?:credential|password|secret|access_token|refresh_token|client_key)\b/iu);
  }
});

test("runtime and migrator registers the immutable PostgreSQL migration", async () => {
  const [runtime, migrator] = await Promise.all([
    readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8"),
    readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8"),
  ]);
  assert.match(runtime, /0006_kubernetes_persistence/u);
  assert.match(runtime, /0007_kubernetes_scanner_evidence/u);
  assert.match(migrator, /0006_kubernetes_persistence\.sql/u);
  assert.match(migrator, /0007_kubernetes_scanner_evidence\.sql/u);
});
