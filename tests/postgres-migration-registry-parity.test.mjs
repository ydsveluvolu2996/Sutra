import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

function uniqueSorted(values, label) {
  assert.equal(new Set(values).size, values.length, `${label} contains duplicate entries`);
  return [...values].sort();
}

test("every migration is registered by each runtime and the PostgreSQL deploy migrator", async () => {
  const [drizzleFiles, postgresFiles, runtimeSource, postgresRuntimeSource, deploySource] = await Promise.all([
    readdir(path.join(root, "drizzle")),
    readdir(path.join(root, "postgres/migrations")),
    readFile(path.join(root, "db/runtime-migrations.ts"), "utf8"),
    readFile(path.join(root, "db/postgres-runtime-migrations.ts"), "utf8"),
    readFile(path.join(root, "scripts/postgres-migrate.mjs"), "utf8"),
  ]);

  const expectedDrizzle = uniqueSorted(drizzleFiles.filter((file) => file.endsWith(".sql")), "drizzle directory");
  const importedDrizzle = uniqueSorted(
    [...runtimeSource.matchAll(/from "\.\.\/drizzle\/([^"?]+\.sql)\?raw"/gu)].map((match) => match[1]),
    "SQLite runtime imports",
  );
  const registeredDrizzle = uniqueSorted(
    [...runtimeSource.matchAll(/\{ id: "([^"]+)", statements:/gu)].map((match) => `${match[1]}.sql`),
    "SQLite runtime registry",
  );

  const expectedPostgres = uniqueSorted(postgresFiles.filter((file) => file.endsWith(".sql")), "PostgreSQL directory");
  const importedPostgres = uniqueSorted(
    [...postgresRuntimeSource.matchAll(/from "\.\.\/postgres\/migrations\/([^"?]+\.sql)\?raw"/gu)].map((match) => match[1]),
    "PostgreSQL runtime imports",
  );
  const registeredPostgres = uniqueSorted(
    [...postgresRuntimeSource.matchAll(/\{ id: "([^"]+)", source:/gu)].map((match) => `${match[1]}.sql`),
    "PostgreSQL runtime registry",
  );
  const deployListBlock = deploySource.match(/const migrationFiles = \[([\s\S]*?)\n\];/u)?.[1] ?? "";
  const deployedPostgres = uniqueSorted(
    [...deployListBlock.matchAll(/"([^"]+\.sql)"/gu)].map((match) => match[1]),
    "PostgreSQL deploy migrator",
  );

  assert.deepEqual(importedDrizzle, expectedDrizzle);
  assert.deepEqual(registeredDrizzle, expectedDrizzle);
  assert.deepEqual(importedPostgres, expectedPostgres);
  assert.deepEqual(registeredPostgres, expectedPostgres);
  assert.deepEqual(deployedPostgres, expectedPostgres);
});
