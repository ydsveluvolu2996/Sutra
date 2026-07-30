import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const [
  migration,
  state,
  hosted,
  broker,
  listRoute,
  reconciliationRoute,
  reconciliation,
  template,
  appEntrypoint,
  brokerEntrypoint,
] = await Promise.all([
  read("postgres/migrations/0065_hosted_broker_runtime.sql"),
  read("services/aws-collector/src/hosted-postgres-state.ts"),
  read("services/aws-collector/src/hosted-server.ts"),
  read("services/aws-collector/src/local-server.ts"),
  read("app/api/v1/agentless-scans/route.ts"),
  read("app/api/v1/agentless-scans/[runId]/reconcile/route.ts"),
  read("lib/agentless-broker-reconciliation.ts"),
  read("infrastructure/production-ha.yaml"),
  read("deploy/production/entrypoint.sh"),
  read("deploy/production/broker-entrypoint.sh"),
]);

test("hosted agentless state, leases, resources, and restart recovery are durable", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS hosted_broker_agentless_runs/u);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS hosted_broker_agentless_resources/u);
  assert.match(migration, /lease_token/u);
  assert.match(migration, /request_sha256/u);
  assert.match(state, /FOR UPDATE SKIP LOCKED/u);
  assert.match(state, /AGENTLESS_LEASE_MS/u);
  assert.match(state, /claimExpiredAgentlessRun/u);
  assert.match(state, /finalizeAgentlessExecution/u);
  assert.match(state, /authorizeAgentlessCleanup/u);
  assert.match(
    state,
    /tenant_id = \$1 AND connection_id = \$2 AND resource_id = \$3[\s\S]*resource_kind = \$4 AND account_scope = \$5 AND region = \$6[\s\S]*deleted_at IS NULL/u,
  );
  assert.match(hosted, /recoverAgentlessOwnedResources/u);
  assert.match(hosted, /finishAgentlessRecovery/u);
  assert.match(hosted, /setInterval\(recover, 60_000\)/u);
  assert.match(broker, /agentlessRunStore/u);
  assert.match(broker, /agentlessResourceTracker/u);
  assert.match(broker, /agentlessExecutionFinalizer/u);
});

test("agentless execution is broker-pinned and readiness is authenticated broker truth", () => {
  assert.match(hosted, /approved-after-live-end-to-end-agentless-validation/u);
  assert.match(hosted, /scan account must match the broker workload account/u);
  assert.match(hosted, /scanner image must be digest-pinned in the workload account and region/u);
  assert.match(broker, /\/v1\/agentless\/readiness/u);
  assert.match(broker, /\/v1\/agentless\/plan-profile/u);
  assert.match(listRoute, /getAgentlessExecutionReadiness/u);
  assert.match(listRoute, /getAgentlessPlanProfile/u);
  assert.doesNotMatch(listRoute, /resolveAgentlessExecutorConfig|AgentlessConfigSource/u);
  assert.doesNotMatch(appEntrypoint, /^SUTRA_AGENTLESS_/mu);

  const appTask = template.slice(
    template.indexOf("  AppTaskDefinition:"),
    template.indexOf("  MigrationTaskDefinition:"),
  );
  const brokerTask = template.slice(
    template.indexOf("  BrokerTaskDefinition:"),
    template.indexOf("  AppService:"),
  );
  assert.doesNotMatch(appTask, /Name: SUTRA_AGENTLESS_/u);
  assert.match(brokerTask, /SUTRA_AGENTLESS_LIVE_VALIDATION_APPROVAL/u);
  assert.match(brokerTask, /SUTRA_AGENTLESS_SCANNER_IMAGE/u);
  assert.match(brokerEntrypoint, /SUTRA_AGENTLESS_LIVE_VALIDATION_APPROVAL/u);
});

test("terminal broker results reconcile scope, findings, and typed teardown debt", () => {
  assert.match(reconciliationRoute, /readAgentlessRun/u);
  assert.match(reconciliationRoute, /getConnectionForOrg\(orgId, connectionId\)/u);
  assert.match(reconciliationRoute, /reconcileAgentlessBrokerRun/u);
  assert.match(reconciliation, /input\.broker\.tenantId !== input\.scope\.orgId/u);
  assert.match(reconciliation, /parseAgentlessBrokerExecution/u);
  assert.match(reconciliation, /resourceKind !== "instance"/u);
  assert.match(reconciliation, /repository\.completeRun/u);
});
