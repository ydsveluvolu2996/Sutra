import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const sqlitePath = new URL("../drizzle/0014_falco_runtime_events.sql", import.meta.url);
const postgresPath = new URL("../postgres/migrations/0008_falco_runtime_events.sql", import.meta.url);

test("Falco migrations enforce replay uniqueness and immutable evidence", async () => {
  const [sqlite, postgres] = await Promise.all([
    readFile(sqlitePath, "utf8"),
    readFile(postgresPath, "utf8"),
  ]);
  for (const source of [sqlite, postgres]) {
    assert.match(source, /falco_ingestion_nonces/iu);
    assert.match(source, /PRIMARY KEY\s*\(.*cluster_id.*key_id.*nonce_sha256/isu);
    assert.match(source, /falco_runtime_events_cluster_evidence_uq/iu);
    assert.match(source, /falco_runtime_events_no_update/iu);
    assert.match(source, /falco_runtime_events_no_delete/iu);
    assert.doesNotMatch(source, /command_line|environment_json|raw_event|raw_output|file_contents/iu);
  }
});

test("runtime migration manifests include the additive Falco migrations", async () => {
  const [sqliteManifest, postgresManifest] = await Promise.all([
    readFile(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8"),
  ]);
  assert.match(sqliteManifest, /0014_falco_runtime_events/);
  assert.match(postgresManifest, /0008_falco_runtime_events/);
});
