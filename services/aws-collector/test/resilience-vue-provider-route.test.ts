import assert from "node:assert/strict";
import test from "node:test";
import {
  RESILIENCE_VUE_PROVIDER_READ_ACTIONS,
  RESILIENCE_VUE_PROVIDER_SESSION_ACTIONS,
  ResilienceVueProviderAdapterError,
} from "../src/resilience-vue-provider-adapter.js";
import {
  parseResilienceVueProviderRouteRequest,
  runResilienceVueProviderRoute,
} from "../src/resilience-vue-provider-route.js";
import { resilienceVueProviderSessionPolicy } from "../src/resilience-vue-session-policy.js";
import { ResilienceVueSdkProviderClient } from "../src/resilience-vue-provider-client.js";
import type { ResiliencehubClient } from "@aws-sdk/client-resiliencehub";

const request = {
  schemaVersion: "sutra.resilience-vue-runtime-request.v1",
  requestId: `rvr_${"a".repeat(64)}`,
  expectedCaptureId: `resilience_${"a".repeat(64)}`,
  scheduledWindow: "2026-08-02T00:00:00.000Z",
  scope: { orgId: "org_resilience", customerId: "customer_resilience",
    connectionId: `conn_${"b".repeat(32)}`, accountId: "111122223333",
    partition: "aws", region: "us-east-1" },
  incrementalAfterIso: null,
  credentials: "SERVER_OWNED_TRUST_ROLE_SESSION",
  operations: RESILIENCE_VUE_PROVIDER_READ_ACTIONS,
  pagination: { pageSize: 100, maximumPages: 20_000, rejectTokenReplay: true, requireExhaustionEvidence: true },
  bounds: { apiPageSize: 100, maximumConcurrency: 4, maximumDurationMs: 900_000,
    maximumCaptureBytes: 11 * 1_024 * 1_024, maximumPages: 20_000,
    maximumCaptureRecords: 500_000, maximumApplications: 1_000, maximumPolicies: 1_000,
    maximumAssessments: 20_000, maximumAssessmentHistoryPerApplication: 36,
    maximumComponentCompliances: 100_000, maximumRecommendations: 200_000,
    maximumResources: 200_000, maximumDrifts: 100_000, maximumTextCharacters: 8_192,
    maximumSuggestedChangesPerRecommendation: 50, maximumComponentsPerResource: 100,
    maximumDashboardInputBytes: 64 * 1_024 * 1_024, maximumDashboardApplications: 500,
    maximumDashboardRecommendations: 1_000, maximumDashboardResources: 2_000,
    maximumDashboardHistoryRecords: 5_000, sourceFreshnessSlaHours: 168 },
  maximumDurationMs: 900_000,
} as const;

function body(value: unknown = request): string { return JSON.stringify(value); }
function code(expected: ResilienceVueProviderAdapterError["code"]) {
  return (error: unknown) => error instanceof ResilienceVueProviderAdapterError && error.code === expected
    && error.message === "AWS Resilience Hub provider collection did not complete";
}

test("ADV-10 provider route accepts only the exact runtime contract", () => {
  assert.deepEqual(parseResilienceVueProviderRouteRequest(body()), request);
  for (const mutation of [
    { ...request, accountId: "000000000000" },
    { ...request, operations: [...request.operations, "resiliencehub:DeleteApp"] },
    { ...request, maximumDurationMs: 900_001 },
    { ...request, scope: { ...request.scope, accountId: "not-an-account" } },
    { ...request, extra: true },
  ]) assert.throws(() => parseResilienceVueProviderRouteRequest(body(mutation)), code("INVALID_REQUEST"));
});

test("ADV-10 provider route binds headers, STS scope, exact actions, and capture identity", async () => {
  const seen: unknown[] = [];
  const capture = { schemaVersion: "sutra.resilience-vue.v1", scope: request.scope,
    captureId: request.expectedCaptureId, startedAtIso: "2026-08-02T00:00:00.000Z",
    completedAtIso: "2026-08-02T00:00:01.000Z", execution: { concurrencyLimit: 4, observedPeakConcurrency: 1 },
    prerequisites: { serviceConfigured: true, readPermissionsValidated: true, collectorRegionEnabled: true },
    applications: { pages: [], exhausted: true }, applicationDetails: [],
    policies: { pages: [], exhausted: true }, policyDetails: [], assessmentHistories: [],
    assessmentEvidence: [], resourceInventories: [] };
  const result = await runResilienceVueProviderRoute({ body: body(), signal: new AbortController().signal,
    headers: { tenantId: request.scope.orgId, customerId: request.scope.customerId,
      connectionId: request.scope.connectionId, requestId: request.requestId } }, {
    assumeReadOnlySession: async (input) => { seen.push(input); return { accountId: request.scope.accountId,
      partition: "aws" as const, credentials: { accessKeyId: "AKIAEXAMPLE",
        secretAccessKey: "secret", sessionToken: "token", expiration: new Date("2026-08-02T01:00:00.000Z") } }; },
    clientFactory: () => ({ collect: async (providerRequest) => { seen.push(providerRequest); return capture; } }),
  });
  assert.equal(result.requestId, request.requestId);
  assert.equal(result.capture, capture);
  assert.deepEqual((seen[0] as { sessionActions: unknown }).sessionActions, RESILIENCE_VUE_PROVIDER_SESSION_ACTIONS);
  await assert.rejects(runResilienceVueProviderRoute({ body: body(), signal: new AbortController().signal,
    headers: { tenantId: "other", customerId: request.scope.customerId,
      connectionId: request.scope.connectionId, requestId: request.requestId } }, {
    assumeReadOnlySession: async () => { throw new Error("must-not-run"); },
    clientFactory: () => ({ collect: async () => capture }),
  }), code("INVALID_REQUEST"));
});

test("ADV-10 provider route rejects substituted STS identity and response scope", async () => {
  const common = { body: body(), signal: new AbortController().signal,
    headers: { tenantId: request.scope.orgId, customerId: request.scope.customerId,
      connectionId: request.scope.connectionId, requestId: request.requestId } };
  await assert.rejects(runResilienceVueProviderRoute(common, {
    assumeReadOnlySession: async () => ({ accountId: "000000000000", partition: "aws" as const,
      credentials: { accessKeyId: "x", secretAccessKey: "y", sessionToken: "z", expiration: new Date("2026-08-02T01:00:00.000Z") } }),
    clientFactory: () => ({ collect: async () => ({}) }),
  }), code("INVALID_REQUEST"));
});

test("ADV-10 STS policy contains the exact operation set and target ARNs", () => {
  const policy = JSON.parse(resilienceVueProviderSessionPolicy({ accountId: request.scope.accountId,
    partition: "aws", region: request.scope.region })) as { Statement: readonly { Action: readonly string[]; Resource: string | readonly string[] }[] };
  assert.deepEqual(policy.Statement.flatMap((statement) => statement.Action).sort(),
    [...RESILIENCE_VUE_PROVIDER_SESSION_ACTIONS].sort());
  assert.match(JSON.stringify(policy), /arn:aws:resiliencehub:us-east-1:111122223333:app\/\*/u);
  assert.throws(() => resilienceVueProviderSessionPolicy({ accountId: "invalid", partition: "aws",
    region: "us-east-1" }), /RESILIENCE_VUE_SESSION_SCOPE_INVALID/u);
});

test("ADV-10 default SDK client emits a schema-valid empty account capture", async () => {
  const operations: string[] = [];
  const client = new ResilienceVueSdkProviderClient({
    send: async (command: object) => {
      operations.push(command.constructor.name);
      if (command.constructor.name === "ListAppsCommand") return { appSummaries: [] };
      if (command.constructor.name === "ListResiliencyPoliciesCommand") {
        return { resiliencyPolicies: [] };
      }
      throw new Error("unexpected command");
    },
  } as unknown as ResiliencehubClient);
  const capture = await client.collect(request, new AbortController().signal) as {
    readonly schemaVersion: string;
    readonly captureId: string;
    readonly scope: unknown;
    readonly applications: { readonly exhausted: boolean };
    readonly policies: { readonly exhausted: boolean };
  };
  assert.deepEqual(operations, ["ListAppsCommand", "ListResiliencyPoliciesCommand"]);
  assert.equal(capture.schemaVersion, "sutra.resilience-vue.v1");
  assert.equal(capture.captureId, request.expectedCaptureId);
  assert.deepEqual(capture.scope, request.scope);
  assert.equal(capture.applications.exhausted, true);
  assert.equal(capture.policies.exhausted, true);
});
