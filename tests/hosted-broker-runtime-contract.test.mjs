import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = await readFile(
  new URL("../postgres/migrations/0065_hosted_broker_runtime.sql", import.meta.url),
  "utf8",
);
const migrator = await readFile(new URL("../scripts/postgres-migrate.mjs", import.meta.url), "utf8");
const entrypoint = await readFile(
  new URL("../services/aws-collector/src/hosted-server.ts", import.meta.url),
  "utf8",
);
const state = await readFile(
  new URL("../services/aws-collector/src/hosted-postgres-state.ts", import.meta.url),
  "utf8",
);
const brokerServer = await readFile(
  new URL("../services/aws-collector/src/local-server.ts", import.meta.url),
  "utf8",
);
const onboardingRoute = await readFile(
  new URL("../app/api/pilot/connections/route.ts", import.meta.url),
  "utf8",
);
const roleRoute = await readFile(
  new URL("../app/api/pilot/connections/role/route.ts", import.meta.url),
  "utf8",
);
const syncRoute = await readFile(
  new URL("../app/api/pilot/connections/sync/route.ts", import.meta.url),
  "utf8",
);

test("hosted broker schema is migrated and uses database-enforced replay and lease uniqueness", () => {
  assert.match(migrator, /0065_hosted_broker_runtime\.sql/u);
  assert.match(migration, /hosted_broker_connections/u);
  assert.match(migration, /hosted_broker_request_nonces[\s\S]*PRIMARY KEY/u);
  assert.match(migration, /hosted_broker_operation_leases[\s\S]*PRIMARY KEY/u);
  assert.match(migration, /hosted_broker_agentless_runs[\s\S]*PRIMARY KEY/u);
  assert.match(migration, /hosted_broker_agentless_resources[\s\S]*PRIMARY KEY/u);
  assert.match(migration, /tombstoned_at/u);
  assert.match(entrypoint, /HostedPostgresState/u);
  assert.doesNotMatch(entrypoint, /EncryptedFileConnectionRegistry|from "\.\/request-auth\.js"/u);
  assert.match(entrypoint, /SUTRA_BROKER_AUTH_MODE/u);
  assert.match(entrypoint, /asymmetric/u);
  assert.match(state, /ON CONFLICT \(nonce_key\)[\s\S]*WHERE hosted_broker_request_nonces\.expires_at <=/u);
  assert.match(state, /ON CONFLICT \(operation_key\)[\s\S]*WHERE hosted_broker_operation_leases\.expires_at <=/u);
  assert.match(state, /FOR UPDATE SKIP LOCKED/u);
  assert.match(state, /claimExpiredAgentlessRun/u);
  assert.match(brokerServer, /LIVE_AWS_BROKER_TIMEOUT_MS \+ 10_000/u);
});

test("hosted onboarding and live collection preserve authenticated org scope end to end", () => {
  assert.doesNotMatch(onboardingRoute, /actor\.orgId !== LOCAL_ORG_ID/u);
  assert.match(onboardingRoute, /deriveScopedAwsConnectionIdentity\(\s*actor\.orgId/u);
  assert.match(onboardingRoute, /createConnectionDraft\(\{[\s\S]*orgId: actor\.orgId/u);
  assert.match(roleRoute, /commitVerifiedConnectionRole\(\{[\s\S]*orgId: actor\.orgId/u);
  assert.match(syncRoute, /createSyncRun\(connectionId, \{ orgId: actor\.orgId \}\)/u);
  assert.match(syncRoute, /persistSnapshot\([\s\S]*null, null, actor\.orgId, collected\.rawEvidenceBytes\)/u);
  assert.match(syncRoute, /failSyncRun\(runId, connectionId, actorId, safeReason, orgId\)/u);
});
