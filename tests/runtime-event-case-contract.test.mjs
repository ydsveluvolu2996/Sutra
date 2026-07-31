import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sources = {
  sqlite: new URL("../drizzle/0019_runtime_event_cases.sql", import.meta.url),
  postgres: new URL("../postgres/migrations/0013_runtime_event_cases.sql", import.meta.url),
  repository: new URL("../db/runtime-event-case-repository.ts", import.meta.url),
  route: new URL("../app/api/v1/kubernetes/runtime-events/route.ts", import.meta.url),
  ui: new URL("../app/kubernetes/kubernetes-runtime-workspace.tsx", import.meta.url),
  migrator: new URL("../scripts/postgres-migrate.mjs", import.meta.url),
};

test("runtime source cases are additive and replay-safe without mutating finding cases", async () => {
  const [sqlite, postgres] = await Promise.all([
    readFile(sources.sqlite, "utf8"),
    readFile(sources.postgres, "utf8"),
  ]);
  for (const migration of [sqlite, postgres]) {
    assert.match(migration, /CREATE TABLE(?: IF NOT EXISTS)? [`]?security_source_cases/iu);
    assert.match(migration, /source_type/);
    assert.match(migration, /source_id/);
    assert.match(migration, /evidence_sha256/);
    assert.match(migration, /title/);
    assert.match(migration, /connection_id/);
    assert.match(migration, /cluster_id/);
    assert.match(migration, /security_source_cases_active_source_uq/);
    assert.match(migration, /WHERE [`]?status[`]? != 'closed'/u);
    assert.doesNotMatch(migration, /ALTER TABLE finding_cases|DROP TABLE finding_cases/iu);
  }
});

test("repository proves exact tenant, customer, connection, cluster, event and evidence scope", async () => {
  const source = await readFile(sources.repository, "utf8");
  assert.match(source, /e\.id = \? AND e\.org_id = \? AND e\.customer_id = \? AND e\.cluster_id = \?/u);
  assert.match(source, /e\.evidence_sha256 = \?/u);
  assert.match(source, /a\.id = \? AND a\.org_id = e\.org_id AND a\.customer_id = e\.customer_id/u);
  assert.match(source, /substr\(k\.cluster_uid, 1, 12\) = a\.aws_account_id/u);
  assert.match(source, /source_type = 'falco_runtime_event'/u);
  assert.match(source, /status != 'closed'/u);
  assert.match(source, /automaticContainment: "false"/u);
  assert.match(source, /humanApproved: "true"/u);
  assert.match(source, /commitAuditedStatements/u);
});

test("authenticated route requires an explicit create-case operation and never sends providers", async () => {
  const source = await readFile(sources.route, "utf8");
  assert.match(source, /export async function POST/);
  assert.match(source, /assertSameOrigin\(request\)/);
  assert.match(source, /requireApiSession\(request\)/);
  assert.match(source, /assertSessionCapability\(authenticated, "finding:manage", connection\.customerId\)/);
  assert.match(source, /input\.operation !== "create_case"/);
  assert.match(source, /providerDeliveryAttempted: false/);
  assert.match(source, /notifications\.enqueue\(/);
  assert.match(source, /\/kubernetes\/runtime\?connectionId=\$\{encodeURIComponent\(input\.connectionId\)\}/u);
  assert.match(source, /#runtime-event-\$\{encodeURIComponent\(created\.sourceId\)\}/u);
  assert.doesNotMatch(source, /reportUrl: `\$\{publicOrigin\}\/cases`/u);
  assert.doesNotMatch(source, /deliverSecurityNotification|resolveWebhook|automaticContainment: true/u);
});

test("runtime UI requires a human confirmation and has no containment action", async () => {
  const source = await readFile(sources.ui, "utf8");
  assert.match(source, /window\.confirm/);
  assert.match(source, /Create case/);
  assert.match(source, /does not contain or modify the workload/);
  assert.match(source, /id=\{`runtime-event-\$\{item\.id\}`\}/u);
  assert.match(source, /\/kubernetes\/runtime\?connectionId=\$\{encodeURIComponent\(connectionId\)\}#runtime-event-/u);
  assert.match(source, /scrollIntoView\(\{ behavior: "smooth", block: "center" \}\)/u);
  assert.doesNotMatch(source, /containWorkload|deletePod|isolateNamespace|automatic.?containment.?true/iu);
});

test("reserved migrations are wired through both runtime and owner migrators", async () => {
  const [sqliteManifest, postgresManifest, migrator] = await Promise.all([
    readFile(new URL("../db/runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/postgres-runtime-migrations.ts", import.meta.url), "utf8"),
    readFile(sources.migrator, "utf8"),
  ]);
  assert.match(sqliteManifest, /0019_runtime_event_cases/);
  assert.match(postgresManifest, /0013_runtime_event_cases/);
  assert.match(migrator, /0013_runtime_event_cases\.sql/);
});
