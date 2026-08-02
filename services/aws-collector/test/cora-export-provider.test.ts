import assert from "node:assert/strict";
import test from "node:test";
import { CORA_PROVIDER_BOUNDS, CORA_PROVIDER_SESSION_ACTIONS, CoraProviderError,
  collectCoraProviderEvidence, type CoraProviderRequest } from "../src/cora-export-provider-adapter.js";
import { handleCoraProviderRoute, parseCoraProviderRequest } from "../src/cora-export-provider-route.js";

const NOW = Date.parse("2026-08-02T12:00:00.000Z"); const ACCOUNT = "111122223333"; const CONNECTION = `conn_${"a".repeat(32)}`;
const target = { exportArn: `arn:aws:bcm-data-exports:us-east-1:${ACCOUNT}:export/sutra-cora-12345678-abcd-abcd-abcd-1234567890ab`, exportName: "sutra-cora", bucketName: `sutra-billing-${ACCOUNT}`, prefix: "cost-optimization/recommendations", partition: "20260802", tableName: "COST_OPTIMIZATION_RECOMMENDATIONS", includeAllRecommendations: true, filterJson: null, fileVersioning: "CREATE_NEW_REPORT", refreshCadence: "SYNCHRONOUS", fileFormat: "PARQUET", compression: "PARQUET", exportDefinitionSha256: "1".repeat(64), querySha256: "2".repeat(64), tableConfigurationsSha256: "3".repeat(64) } as const;
const request: CoraProviderRequest = { schemaVersion: "sutra.cora-export-provider-request.v1", requestKey: `corarq_${"4".repeat(64)}`, scheduledWindow: "2026-08-02T00:00:00.000Z", scope: { orgId: "org_cora", customerId: "customer_cora", connectionId: CONNECTION, partition: "aws", managementAccountId: ACCOUNT, awsOrganizationId: "o-abcdefghij12" }, target, expectedAccountIds: [ACCOUNT], expectedRegions: ["global"], operations: CORA_PROVIDER_SESSION_ACTIONS.slice(1), manifestSelection: "EXECUTION_SPECIFIC_ONLY", rejectMutableLatestManifest: true, acceptDirectApiRecommendationRows: false, bounds: CORA_PROVIDER_BOUNDS, deadlineAtIso: "2026-08-02T12:15:00.000Z", credentials: "SERVER_OWNED_TRUST_ROLE_SESSION" };
const objectKey = `${target.prefix}/${target.exportName}/data/${target.partition}/20260802T060000Z-execution-1/cora-1.snappy.parquet`;
const manifestKey = `${target.prefix}/${target.exportName}/metadata/${target.partition}/20260802T060000Z-execution-1/Manifest.json`;
const row = { account_id: ACCOUNT, account_name: "Management", action_type: "PurchaseSavingsPlans", currency_code: "USD", current_resource_details: null, current_resource_summary: "Payer eligible usage", current_resource_type: "ComputeSavingsPlans", estimated_monthly_cost_after_discount: null, estimated_monthly_cost_before_discount: "1000", estimated_monthly_savings_after_discount: null, estimated_monthly_savings_before_discount: "250", estimated_savings_percentage_after_discount: null, estimated_savings_percentage_before_discount: "25", implementation_effort: "VeryLow", last_refresh_timestamp: "2026-08-02T06:00:00.000Z", recommendation_id: "rec-1", recommendation_lookback_period_in_days: 14, recommendation_source: "CostExplorer", recommended_resource_details: null, recommended_resource_summary: "0.50/hour for m7i in Payer one year NoUpfront", recommended_resource_type: "ComputeSavingsPlans", region: null, resource_arn: null, resource_id: "payer-eligible", restart_needed: false, rollback_possible: false, tags: { Owner: "FinOps" } };
const artifact = { executionId: "execution-1", status: "SUCCEEDED" as const, statusObservedAt: "2026-08-02T06:05:00.000Z", generatedAt: "2026-08-02T06:00:00.000Z", dataThroughAt: "2026-08-02T06:00:00.000Z", errorCode: null, getExecutionSha256: "5".repeat(64), manifest: { key: manifestKey, versionId: "v1", eTag: "6".repeat(32), contentSha256: "7".repeat(64), sizeBytes: 1024, executionId: "execution-1", dataObjectKeys: [objectKey], schemaSha256: "8".repeat(64) }, objects: [{ key: objectKey, versionId: "v1", eTag: "9".repeat(32), contentSha256: "a".repeat(64), sizeBytes: 4096, rows: [row] }], coveredAccountIds: [ACCOUNT], coveredRegions: ["global"], listExecutionsExhausted: true, objectListingExhausted: true };
const credentials = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", sessionToken: "token", expiration: new Date("2026-08-02T13:00:00.000Z") };
function code(expected: CoraProviderError["code"]) { return (error: unknown) => error instanceof CoraProviderError && error.code === expected; }

test("ADD-01 provider exhausts the exact execution manifest and normalizes all COR columns", async () => {
  const materialization = await collectCoraProviderEvidence({ request, credentials, reader: { readExecution: async () => artifact }, signal: new AbortController().signal, now: () => NOW });
  assert.equal(materialization.rows.length, 1); assert.equal(materialization.reconciliation.pagesExhausted, true);
  assert.match((materialization.rows[0] as { recommendation: { trackingKey: string } }).recommendation.trackingKey, /^cor_[a-f0-9]{64}$/u);
  assert.deepEqual(materialization.objects.map((item) => item.key), [objectKey]);
});

test("ADD-01 provider rejects mutable/substituted manifests, unbounded pages, and unsafe rows", async () => {
  for (const changed of [
    { ...artifact, manifest: { ...artifact.manifest, key: `${target.prefix}/${target.exportName}/metadata/${target.partition}/Manifest.json` } },
    { ...artifact, objectListingExhausted: false },
    { ...artifact, objects: [{ ...artifact.objects[0]!, rows: [{ ...row, action_type: "DeleteExport" }] }] },
  ]) await assert.rejects(collectCoraProviderEvidence({ request, credentials, reader: { readExecution: async () => changed }, signal: new AbortController().signal, now: () => NOW }), code(changed.objectListingExhausted === false ? "BOUND_REACHED" : "PROVIDER_RESPONSE_INVALID"));
});

test("ADD-01 strict route binds signed identity, server contract, exact STS actions and response hash", async () => {
  assert.deepEqual(parseCoraProviderRequest(JSON.stringify(request)), request); const seen: unknown[] = [];
  const candidate: Record<string, unknown> = { ...request };
  delete candidate.requestKey; delete candidate.scheduledWindow; delete candidate.deadlineAtIso;
  const result = await handleCoraProviderRoute({ body: JSON.stringify(request), headers: { tenantId: request.scope.orgId, customerId: request.scope.customerId, connectionId: request.scope.connectionId, requestId: request.requestKey }, signal: new AbortController().signal, dependencies: { now: () => NOW, resolveContract: async () => ({ request: candidate as never }), assumeReadOnlySession: async (value) => { seen.push(value); return { accountId: ACCOUNT, partition: "aws", credentials }; }, readerFactory: () => ({ readExecution: async () => artifact }) } });
  assert.equal(result.requestId, request.requestKey); assert.match(result.requestBodySha256, /^[a-f0-9]{64}$/u); assert.deepEqual((seen[0] as { sessionActions: unknown }).sessionActions, CORA_PROVIDER_SESSION_ACTIONS);
  await assert.rejects(handleCoraProviderRoute({ body: JSON.stringify(request), headers: { tenantId: "org_other", customerId: request.scope.customerId, connectionId: request.scope.connectionId, requestId: request.requestKey }, signal: new AbortController().signal, dependencies: { resolveContract: async () => { throw new Error("must-not-run"); }, assumeReadOnlySession: async () => { throw new Error("must-not-run"); }, readerFactory: () => { throw new Error("must-not-run"); } } }), code("INVALID_REQUEST"));
});
