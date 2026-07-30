import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");

test("live AWS snapshots migrate away from the legacy sandbox origin", async () => {
  const [sqlite, postgres, sqliteRunner, postgresRunner, migrator, publicApi] = await Promise.all([
    readFile(resolve(root, "drizzle/0067_aws_live_snapshot_origin.sql"), "utf8"),
    readFile(resolve(root, "postgres/migrations/0061_aws_live_snapshot_origin.sql"), "utf8"),
    readFile(resolve(root, "db/runtime-migrations.ts"), "utf8"),
    readFile(resolve(root, "db/postgres-runtime-migrations.ts"), "utf8"),
    readFile(resolve(root, "scripts/postgres-migrate.mjs"), "utf8"),
    readFile(resolve(root, "app/api/public/v1/openapi.json/route.ts"), "utf8"),
  ]);

  for (const source of [sqlite, postgres]) {
    assert.match(source, /SET [`"]?origin_kind[`"]? = 'aws_live'/u);
    assert.match(source, /WHERE [`"]?origin_kind[`"]? = 'aws_sandbox'/u);
  }
  assert.match(sqliteRunner, /0067_aws_live_snapshot_origin/u);
  assert.match(postgresRunner, /0061_aws_live_snapshot_origin/u);
  assert.match(migrator, /0061_aws_live_snapshot_origin\.sql/u);
  assert.match(publicApi, /"aws_live"/u);
  assert.doesNotMatch(publicApi, /"aws_sandbox"/u);
});
