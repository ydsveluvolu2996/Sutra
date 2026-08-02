import assert from "node:assert/strict";
import test from "node:test";
import {
  GRAVITON_PROVIDER_BOUNDS,
  GRAVITON_PROVIDER_SESSION_ACTIONS,
  GravitonProviderAdapterError,
  collectGravitonProviderEvidence,
} from "../src/graviton-savings-provider-adapter.js";
import { parseGravitonProviderRouteRequest, runGravitonProviderRoute } from "../src/graviton-savings-provider-route.js";

const CONNECTION = `conn_${"a".repeat(32)}`, OTHER = `conn_${"b".repeat(32)}`;
const REQUEST = `gvrq_${"c".repeat(64)}`, WINDOW = "2026-08-02T00:00:00.000Z", NOW = Date.parse("2026-08-02T01:00:00.000Z");
const boundary = { scope: { orgId: "org_graviton", customerId: "customer_graviton", connectionId: CONNECTION },
  managementAccountId: "111122223333", partition: "aws" as const,
  accountIds: ["111122223333", "444455556666"], regions: ["us-east-1", "us-west-2"] };
const authority = { cur2: { generationId: "cur2_generation_1", contentSha256: "1".repeat(64) },
  pricing: { catalogVersion: "aws-pricing-2026-08", contentSha256: "2".repeat(64) },
  compatibility: { policyVersion: "compat-2026-08", contentSha256: "3".repeat(64) },
  workloadAttestations: { setId: "workload_set_1", contentSha256: "4".repeat(64) },
  licenseAttestations: { setId: "license_set_1", contentSha256: "5".repeat(64) } };
function request() { return { schemaVersion: "sutra.graviton-provider-request.v1", requestKey: REQUEST,
  scheduledWindow: WINDOW, boundary, accountTargets: [{ accountId: "111122223333", connectionId: CONNECTION },
    { accountId: "444455556666", connectionId: OTHER }],
  services: ["EC2_AND_AUTO_SCALING", "RDS_AND_AURORA", "OPENSEARCH", "ELASTICACHE"],
  operations: GRAVITON_PROVIDER_SESSION_ACTIONS,
  recommendationPolicy: { computeOptimizerAccepted: true, managedServiceInventoryPricingAcceptedOnlyWithAllCompatibilityDimensions: true,
    inferCompatibilityFromFamilyName: false, inferSavingsWithoutPeriodMatchedCur2AndPricing: false },
  evidenceAuthority: structuredClone(authority), credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS", bounds: GRAVITON_PROVIDER_BOUNDS,
  deadlineAtIso: "2026-08-02T01:15:00.000Z" }; }
function capture() { return { schemaVersion: "sutra.graviton-savings.capture.v1", scope: boundary.scope,
  managementAccountId: boundary.managementAccountId, partition: boundary.partition,
  accountIds: boundary.accountIds, regions: boundary.regions, collectionId: "collection_graviton_1",
  startedAt: "2026-08-02T00:59:00.000Z", completedAt: "2026-08-02T01:00:00.000Z",
  recommendations: [], inventory: [], instanceMetadata: [], compatibility: [], costs: [], pricing: [], realizations: [] }; }
const headers = { tenantId: boundary.scope.orgId, customerId: boundary.scope.customerId,
  connectionId: CONNECTION, requestId: REQUEST };

test("strict route binds tenant headers, exact actions and target account sessions", async () => {
  const sessions: unknown[] = [];
  const result = await runGravitonProviderRoute({ body: JSON.stringify(request()), headers, signal: new AbortController().signal }, {
    now: () => NOW,
    assumeReadOnlySession: async (input) => { sessions.push(input); return { accountId: input.expectedAccountId,
      partition: input.partition, credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", sessionToken: "token", expiration: new Date("2026-08-02T02:00:00.000Z") } }; },
    readerFactory: () => ({ collect: async ({ sessionForTarget, signal }) => {
      await sessionForTarget({ accountId: "111122223333", region: "us-east-1" }, signal);
      await sessionForTarget({ accountId: "444455556666", region: "us-west-2" }, signal);
      return capture();
    } }),
  });
  assert.equal(result.requestKey, REQUEST); assert.equal(sessions.length, 2);
  assert.equal((sessions[1] as { connectionId: string }).connectionId, OTHER);
  assert.deepEqual((sessions[0] as { sessionActions: unknown }).sessionActions, GRAVITON_PROVIDER_SESSION_ACTIONS);
});

test("route rejects account substitution, authority tampering and response scope changes", async () => {
  const substituted = request(); substituted.accountTargets[1] = { accountId: "999900001111", connectionId: OTHER };
  assert.throws(() => parseGravitonProviderRouteRequest(JSON.stringify(substituted)),
    (error) => error instanceof GravitonProviderAdapterError && error.code === "INVALID_REQUEST");
  const tampered = request(); tampered.evidenceAuthority.cur2.contentSha256 = "x".repeat(64);
  assert.throws(() => parseGravitonProviderRouteRequest(JSON.stringify(tampered)),
    (error) => error instanceof GravitonProviderAdapterError && error.code === "INVALID_REQUEST");
  await assert.rejects(runGravitonProviderRoute({ body: JSON.stringify(request()), headers, signal: new AbortController().signal }, {
    now: () => NOW, assumeReadOnlySession: async (input) => ({ accountId: input.expectedAccountId, partition: input.partition,
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", sessionToken: "token", expiration: new Date("2026-08-02T02:00:00.000Z") } }),
    readerFactory: () => ({ collect: async () => ({ ...capture(), scope: { ...boundary.scope, orgId: "org_attacker" } }) }),
  }), (error) => error instanceof GravitonProviderAdapterError
    && new Set(["INVALID_REQUEST", "PROVIDER_RESPONSE_INVALID"]).has(error.code));
});

test("reader cannot ask for an unpinned account or Region", async () => {
  await assert.rejects(runGravitonProviderRoute({ body: JSON.stringify(request()), headers, signal: new AbortController().signal }, {
    now: () => NOW, assumeReadOnlySession: async (input) => ({ accountId: input.expectedAccountId, partition: input.partition,
      credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", sessionToken: "token", expiration: new Date("2026-08-02T02:00:00.000Z") } }),
    readerFactory: () => ({ collect: async ({ sessionForTarget, signal }) => {
      await sessionForTarget({ accountId: "111122223333", region: "eu-central-1" }, signal); return capture();
    } }),
  }), (error) => error instanceof GravitonProviderAdapterError
    && new Set(["INVALID_REQUEST", "PROVIDER_RESPONSE_INVALID"]).has(error.code));
});

test("adapter deadline terminates a reader that ignores AbortSignal", async () => {
  const controller = new AbortController(); queueMicrotask(() => controller.abort());
  await assert.rejects(collectGravitonProviderEvidence({ request: parseGravitonProviderRouteRequest(JSON.stringify(request())),
    reader: { collect: async () => new Promise(() => undefined) },
    sessionForTarget: async () => { throw new Error("must not assume"); }, signal: controller.signal }),
  (error) => error instanceof GravitonProviderAdapterError && error.code === "ABORTED");
});
