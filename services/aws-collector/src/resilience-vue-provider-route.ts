/** Exact signed-route payload boundary for ADV-10 ResilienceVue. */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";
import {
  RESILIENCE_VUE_PROVIDER_READ_ACTIONS,
  RESILIENCE_VUE_PROVIDER_SESSION_ACTIONS,
  ResilienceVueProviderAdapterError,
  collectResilienceVueProviderEvidence,
  type ResilienceVueProviderClientFactory,
  type ResilienceVueProviderRequest,
} from "./resilience-vue-provider-adapter.js";
import { createResilienceVueProviderClient } from "./resilience-vue-provider-client.js";

export const RESILIENCE_VUE_PROVIDER_ROUTE = "/v1/finops/resilience-vue/collect";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-[a-z0-9]+)+-\d$/u;
const REQUEST = /^rvr_[a-f0-9]{64}$/u;
const CAPTURE = /^resilience_[a-f0-9]{64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_BODY_BYTES = 64 * 1_024;

const PAGINATION = Object.freeze({ pageSize: 100, maximumPages: 20_000,
  rejectTokenReplay: true, requireExhaustionEvidence: true });
export const RESILIENCE_VUE_PROVIDER_BOUNDS = Object.freeze({ apiPageSize: 100, maximumConcurrency: 4,
  maximumDurationMs: 900_000, maximumCaptureBytes: 11 * 1_024 * 1_024,
  maximumPages: 20_000, maximumCaptureRecords: 500_000,
  maximumApplications: 1_000, maximumPolicies: 1_000, maximumAssessments: 20_000,
  maximumAssessmentHistoryPerApplication: 36, maximumComponentCompliances: 100_000,
  maximumRecommendations: 200_000, maximumResources: 200_000, maximumDrifts: 100_000,
  maximumTextCharacters: 8_192, maximumSuggestedChangesPerRecommendation: 50,
  maximumComponentsPerResource: 100, maximumDashboardInputBytes: 64 * 1_024 * 1_024,
  maximumDashboardApplications: 500, maximumDashboardRecommendations: 1_000,
  maximumDashboardResources: 2_000, maximumDashboardHistoryRecords: 5_000,
  sourceFreshnessSlaHours: 168 });

export interface ResilienceVueProviderRouteHeaders {
  readonly tenantId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly requestId: string;
}
export interface ResilienceVueProviderRouteDependencies {
  readonly assumeReadOnlySession: (input: {
    readonly tenantId: string; readonly customerId: string; readonly connectionId: string;
    readonly requestId: string; readonly expectedAccountId: string;
    readonly partition: "aws" | "aws-cn" | "aws-us-gov";
    readonly region: string;
    readonly sessionActions: typeof RESILIENCE_VUE_PROVIDER_SESSION_ACTIONS;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly accountId: string; readonly partition: "aws" | "aws-cn" | "aws-us-gov";
    readonly credentials: AwsTemporaryCredentials }>;
  readonly clientFactory?: ResilienceVueProviderClientFactory;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new ResilienceVueProviderAdapterError("INVALID_REQUEST");
  }
  return value as Record<string, unknown>;
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function canonicalIso(value: unknown): value is string {
  return typeof value === "string" && ISO.test(value) && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

export function parseResilienceVueProviderRouteRequest(body: string): ResilienceVueProviderRequest {
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    throw new ResilienceVueProviderAdapterError("BOUND_REACHED");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new ResilienceVueProviderAdapterError("INVALID_REQUEST"); }
  const value = exact(parsed, ["schemaVersion", "requestId", "expectedCaptureId", "scheduledWindow",
    "scope", "incrementalAfterIso", "credentials", "operations", "pagination", "bounds", "maximumDurationMs"]);
  const scope = exact(value.scope, ["orgId", "customerId", "connectionId", "accountId", "partition", "region"]);
  if (value.schemaVersion !== "sutra.resilience-vue-runtime-request.v1"
    || typeof value.requestId !== "string" || !REQUEST.test(value.requestId)
    || typeof value.expectedCaptureId !== "string" || !CAPTURE.test(value.expectedCaptureId)
    || typeof value.scheduledWindow !== "string" || !WINDOW.test(value.scheduledWindow)
    || new Date(Date.parse(value.scheduledWindow)).toISOString() !== value.scheduledWindow
    || (value.incrementalAfterIso !== null && !canonicalIso(value.incrementalAfterIso))
    || value.credentials !== "SERVER_OWNED_TRUST_ROLE_SESSION"
    || !same(value.operations, RESILIENCE_VUE_PROVIDER_READ_ACTIONS)
    || !same(value.pagination, PAGINATION) || !same(value.bounds, RESILIENCE_VUE_PROVIDER_BOUNDS)
    || value.maximumDurationMs !== 900_000
    || typeof scope.orgId !== "string" || !IDENTIFIER.test(scope.orgId)
    || typeof scope.customerId !== "string" || !IDENTIFIER.test(scope.customerId)
    || typeof scope.connectionId !== "string" || !CONNECTION.test(scope.connectionId)
    || typeof scope.accountId !== "string" || !ACCOUNT.test(scope.accountId)
    || !["aws", "aws-cn", "aws-us-gov"].includes(String(scope.partition))
    || typeof scope.region !== "string" || !REGION.test(scope.region)) {
    throw new ResilienceVueProviderAdapterError("INVALID_REQUEST");
  }
  return { ...value, scope } as unknown as ResilienceVueProviderRequest;
}

export async function runResilienceVueProviderRoute(input: {
  readonly body: string; readonly headers: ResilienceVueProviderRouteHeaders; readonly signal: AbortSignal;
}, dependencies: ResilienceVueProviderRouteDependencies): Promise<{
  readonly schemaVersion: "sutra.resilience-vue-broker-response.v1";
  readonly requestId: string; readonly requestBodySha256: string; readonly capture: unknown;
}> {
  const request = parseResilienceVueProviderRouteRequest(input.body);
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted
    || input.headers.tenantId !== request.scope.orgId
    || input.headers.customerId !== request.scope.customerId
    || input.headers.connectionId !== request.scope.connectionId
    || input.headers.requestId !== request.requestId) {
    throw new ResilienceVueProviderAdapterError("INVALID_REQUEST");
  }
  const session = await dependencies.assumeReadOnlySession({ tenantId: request.scope.orgId,
    customerId: request.scope.customerId, connectionId: request.scope.connectionId,
    requestId: request.requestId, expectedAccountId: request.scope.accountId,
    partition: request.scope.partition, region: request.scope.region,
    sessionActions: RESILIENCE_VUE_PROVIDER_SESSION_ACTIONS, signal: input.signal });
  if (session.accountId !== request.scope.accountId || session.partition !== request.scope.partition) {
    throw new ResilienceVueProviderAdapterError("INVALID_REQUEST");
  }
  const capture = await collectResilienceVueProviderEvidence({ request,
    client: (dependencies.clientFactory ?? createResilienceVueProviderClient)({ region: request.scope.region, partition: request.scope.partition,
      credentials: session.credentials }), signal: input.signal });
  return Object.freeze({ schemaVersion: "sutra.resilience-vue-broker-response.v1" as const,
    requestId: request.requestId,
    requestBodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"), capture });
}
