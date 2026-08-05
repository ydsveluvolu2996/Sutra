import assert from "node:assert/strict";
import test from "node:test";
import { SCAD_CUR2_PROVIDER_ACTIONS, ScadCur2ProviderAdapterError,
  type ScadCur2ProviderBinding, type ScadCur2ProviderRequest } from "../src/scad-cur2-provider-adapter.js";
import { parseScadCur2ProviderRouteRequest, runScadCur2ProviderRoute } from "../src/scad-cur2-provider-route.js";

const CONNECTION = `conn_${"a".repeat(32)}`; const JOB = `job_${"b".repeat(32)}`;
const binding: ScadCur2ProviderBinding = { schemaVersion: "sutra.scad-cur2-provider-binding.v1",
  tenantId: "org_scad", customerId: "customer_scad", connectionId: CONNECTION,
  accountId: "111111111111", partition: "aws", region: "us-east-1",
  permissionPackVersion: "standard-2026-08.14", contractId: "foundational-cur2-export-v1",
  policyName: "SutraFoundationalCur2ReadV1", exportTable: "COST_AND_USAGE_REPORT",
  exportName: "sutra_scad", exportArn: "arn:aws:bcm-data-exports:us-east-1:111111111111:export/sutra_scad",
  bucket: "sutra-scad-111111111111", prefix: "exports/sutra_scad/" };
const request: ScadCur2ProviderRequest = { schemaVersion: "sutra.scad-cur2-provider-request.v1",
  requestId: `scr_${"c".repeat(64)}`, jobId: JOB, scheduledWindow: "2026-08-02T00:00:00.000Z",
  boundary: { schemaVersion: "sutra.scad-cur2-runtime-boundary.v1", binding: "SERVER_RESOLVED_SCAD_CUR2_EXPORT",
    scope: { orgId: binding.tenantId, customerId: binding.customerId, connectionId: CONNECTION,
      partition: "aws", payerAccountIds: [binding.accountId], usageAccountIds: [binding.accountId], regions: [binding.region] },
    exportName: binding.exportName, exportArn: binding.exportArn, bucket: binding.bucket, prefix: binding.prefix,
    billingPeriodStartAt: "2026-08-01T00:00:00.000Z", billingPeriodEndAt: "2026-09-01T00:00:00.000Z",
    scadEnabledAt: "2026-08-01T00:00:00.000Z", firstDeliveryObservedAt: null,
    priorDeliverySequence: 0, lastAcceptedGenerationId: null,
    tableConfiguration: { tableName: "COST_AND_USAGE_REPORT", timeGranularity: "HOURLY",
      includeResources: "TRUE", includeSplitCostAllocationData: "TRUE" } }, operation: { kind: "GET_MANIFEST" } };
const manifest = { schemaVersion: "sutra.scad-cur2-provider-manifest.v1", scope: request.boundary.scope,
  exportArn: binding.exportArn, bucket: binding.bucket, prefix: binding.prefix,
  billingPeriodStartAt: request.boundary.billingPeriodStartAt, billingPeriodEndAt: request.boundary.billingPeriodEndAt,
  manifestSha256: "d".repeat(64), activeGenerationId: `fbg_${"d".repeat(64)}`,
  generatedAt: "2026-08-02T01:00:00.000Z", dataThroughAt: "2026-08-02T00:00:00.000Z",
  schemaColumns: [], expectedObjectCount: 0, runtimeS3PermissionsValidated: true };
const credentials = { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", sessionToken: "token",
  expiration: new Date("2026-08-02T02:00:00.000Z") };

test("strict SCAD route binds tenant, immutable CUR2 add-on, exact actions and signed payload", async () => {
  let assumed: unknown = null;
  const body = JSON.stringify(request);
  assert.deepEqual(parseScadCur2ProviderRouteRequest(body), request);
  const response = await runScadCur2ProviderRoute({ body, headers: { tenantId: binding.tenantId,
    customerId: binding.customerId, connectionId: CONNECTION, jobId: JOB }, signal: new AbortController().signal }, {
    loadBinding: async () => binding,
    assumeReadOnlySession: async (input) => { assumed = input; return { accountId: binding.accountId,
      partition: binding.partition, permissionPackVersion: binding.permissionPackVersion, credentials }; },
    readerFactory: () => ({ getManifest: async () => manifest,
      listManifestObjects: async () => ({ objects: [], nextToken: null }),
      readObjectRows: async () => ({ object: {}, rows: [], nextToken: null }) }),
  });
  assert.equal(response.requestId, request.requestId); assert.deepEqual(response.payload, manifest);
  assert.deepEqual((assumed as { sessionActions: readonly string[] }).sessionActions, SCAD_CUR2_PROVIDER_ACTIONS);
  assert.equal((assumed as { contractId: string }).contractId, "foundational-cur2-export-v1");
});

test("SCAD route rejects cross-tenant headers, weaker table settings, and oversized pages", async () => {
  const dependencies = { loadBinding: async () => binding,
    assumeReadOnlySession: async () => ({ accountId: binding.accountId, partition: binding.partition,
      permissionPackVersion: binding.permissionPackVersion, credentials }),
    readerFactory: () => ({ getManifest: async () => manifest,
      listManifestObjects: async () => ({ objects: Array.from({ length: 1001 }, () => ({})), nextToken: null }),
      readObjectRows: async () => ({ object: {}, rows: [], nextToken: null }) }) };
  await assert.rejects(runScadCur2ProviderRoute({ body: JSON.stringify(request), headers: { tenantId: "org_other",
    customerId: binding.customerId, connectionId: CONNECTION, jobId: JOB }, signal: new AbortController().signal }, dependencies),
  (error: unknown) => error instanceof ScadCur2ProviderAdapterError && error.code === "INVALID_REQUEST");
  const weak = { ...request, boundary: { ...request.boundary, tableConfiguration: {
    ...request.boundary.tableConfiguration, includeSplitCostAllocationData: "FALSE" as const } } };
  await assert.rejects(runScadCur2ProviderRoute({ body: JSON.stringify(weak), headers: { tenantId: binding.tenantId,
    customerId: binding.customerId, connectionId: CONNECTION, jobId: JOB }, signal: new AbortController().signal }, dependencies),
  (error: unknown) => error instanceof ScadCur2ProviderAdapterError && error.code === "INVALID_REQUEST");
  const list = { ...request, operation: { kind: "LIST_OBJECTS" as const,
    manifestSha256: "d".repeat(64), pageSize: 1000 as const, token: null } };
  await assert.rejects(runScadCur2ProviderRoute({ body: JSON.stringify(list), headers: { tenantId: binding.tenantId,
    customerId: binding.customerId, connectionId: CONNECTION, jobId: JOB }, signal: new AbortController().signal }, dependencies),
  (error: unknown) => error instanceof ScadCur2ProviderAdapterError && error.code === "PROVIDER_RESPONSE_INVALID");
  await assert.rejects(runScadCur2ProviderRoute({ body: JSON.stringify({ ...request, boundary: null }), headers: {
    tenantId: binding.tenantId, customerId: binding.customerId, connectionId: CONNECTION, jobId: JOB },
  signal: new AbortController().signal }, dependencies),
  (error: unknown) => error instanceof ScadCur2ProviderAdapterError && error.code === "INVALID_REQUEST");
});
