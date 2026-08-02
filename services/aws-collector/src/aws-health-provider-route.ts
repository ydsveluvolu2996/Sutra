/** Strict authenticated route boundary for the ADV-06 AWS Health provider. */
import { createHash } from "node:crypto";
import {
  AWS_HEALTH_PROVIDER_SESSION_ACTIONS,
  AWS_HEALTH_PROVIDER_BOUNDS,
  AwsHealthProviderAdapterError,
  collectAwsHealthProviderEvidence,
  type AwsHealthProviderReader,
  type AwsHealthProviderRequest,
  type AwsHealthProviderTarget,
} from "./aws-health-provider-adapter.js";
import type { AwsTemporaryCredentials } from "./types.js";

export const AWS_HEALTH_PROVIDER_ROUTE = "/v1/finops/aws-health/collect";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const ACCOUNT = /^\d{12}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const REQUEST = /^hrr_[a-f0-9]{64}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;

export interface AwsHealthProviderRouteHeaders {
  readonly tenantId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly requestId: string;
}

export interface AwsHealthProviderRouteDependencies {
  readonly assumeReadOnlySession: (input: {
    readonly tenantId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly expectedAccountId: string;
    readonly partition: "aws" | "aws-us-gov";
    readonly requestId: string;
    readonly sessionActions: typeof AWS_HEALTH_PROVIDER_SESSION_ACTIONS;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly accountId: string; readonly partition: "aws" | "aws-us-gov"; readonly credentials: AwsTemporaryCredentials }>;
  readonly readerFactory: (input: {
    readonly request: AwsHealthProviderRequest;
    readonly sessionForTarget: (target: AwsHealthProviderTarget, signal: AbortSignal) => Promise<AwsTemporaryCredentials>;
  }) => AwsHealthProviderReader;
  readonly now?: () => number;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new AwsHealthProviderAdapterError("INVALID_REQUEST");
  const result = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...keys].sort())) throw new AwsHealthProviderAdapterError("INVALID_REQUEST");
  return result;
}

function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

export function parseAwsHealthProviderRouteRequest(body: string): AwsHealthProviderRequest {
  if (Buffer.byteLength(body, "utf8") > 128 * 1_024) throw new AwsHealthProviderAdapterError("BOUND_REACHED");
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new AwsHealthProviderAdapterError("INVALID_REQUEST"); }
  const value = exact(parsed, [
    "schemaVersion", "requestId", "scheduledWindow", "scope", "candidateAccounts",
    "enabledObservedSince", "healthOperations", "configurationOperation",
    "prerequisiteOperations", "bounds", "locale", "unfilteredAvailableEvents",
    "credentials", "deadlineAtIso",
  ]);
  const scope = exact(value.scope, ["orgId", "customerId", "connectionId", "accountId", "partition", "endpointRegion"]);
  const partition = scope.partition;
  if (value.schemaVersion !== "sutra.aws-health-provider-request.v1"
    || typeof value.requestId !== "string" || !REQUEST.test(value.requestId)
    || typeof value.scheduledWindow !== "string" || !WINDOW.test(value.scheduledWindow)
    || typeof scope.orgId !== "string" || !IDENTIFIER.test(scope.orgId)
    || typeof scope.customerId !== "string" || !IDENTIFIER.test(scope.customerId)
    || typeof scope.connectionId !== "string" || !CONNECTION.test(scope.connectionId)
    || typeof scope.accountId !== "string" || !ACCOUNT.test(scope.accountId)
    || (partition !== "aws" && partition !== "aws-us-gov")
    || scope.endpointRegion !== (partition === "aws" ? "us-east-1" : "us-gov-west-1")
    || (value.enabledObservedSince !== null && (typeof value.enabledObservedSince !== "string" || !Number.isFinite(Date.parse(value.enabledObservedSince)) || new Date(Date.parse(value.enabledObservedSince)).toISOString() !== value.enabledObservedSince))
    || !same(value.healthOperations, [
      "health:DescribeAffectedAccountsForOrganization", "health:DescribeAffectedEntitiesForOrganization",
      "health:DescribeEventDetailsForOrganization", "health:DescribeEventsForOrganization",
    ])
    || value.configurationOperation !== "health:DescribeHealthServiceStatusForOrganization"
    || !same(value.prerequisiteOperations, ["organizations:DescribeOrganization", "organizations:ListDelegatedAdministrators"])
    || !same(value.bounds, AWS_HEALTH_PROVIDER_BOUNDS)
    || value.locale !== "en" || value.unfilteredAvailableEvents !== true
    || value.credentials !== "SERVER_OWNED_TRUST_ROLE_SESSIONS"
    || typeof value.deadlineAtIso !== "string" || !Number.isFinite(Date.parse(value.deadlineAtIso))
    || new Date(Date.parse(value.deadlineAtIso)).toISOString() !== value.deadlineAtIso) {
    throw new AwsHealthProviderAdapterError("INVALID_REQUEST");
  }
  if (!Array.isArray(value.candidateAccounts) || value.candidateAccounts.length < 1 || value.candidateAccounts.length > 200) {
    throw new AwsHealthProviderAdapterError("INVALID_REQUEST");
  }
  const candidateAccounts = value.candidateAccounts.map((raw) => {
    const target = exact(raw, ["accountId", "connectionId"]);
    if (typeof target.accountId !== "string" || !ACCOUNT.test(target.accountId)
      || typeof target.connectionId !== "string" || !CONNECTION.test(target.connectionId)) throw new AwsHealthProviderAdapterError("INVALID_REQUEST");
    return { accountId: target.accountId, connectionId: target.connectionId };
  });
  if (!same(candidateAccounts, [...candidateAccounts].sort((left, right) => left.accountId.localeCompare(right.accountId)))
    || new Set(candidateAccounts.map((target) => target.accountId)).size !== candidateAccounts.length
    || new Set(candidateAccounts.map((target) => target.connectionId)).size !== candidateAccounts.length
    || !candidateAccounts.some((target) => target.accountId === scope.accountId && target.connectionId === scope.connectionId)) {
    throw new AwsHealthProviderAdapterError("INVALID_REQUEST");
  }
  return { ...value, scope, candidateAccounts } as unknown as AwsHealthProviderRequest;
}

export async function runAwsHealthProviderRoute(input: {
  readonly body: string;
  readonly headers: AwsHealthProviderRouteHeaders;
  readonly signal: AbortSignal;
}, dependencies: AwsHealthProviderRouteDependencies): Promise<{
  readonly schemaVersion: "sutra.aws-health-provider-response.v1";
  readonly requestId: string;
  readonly requestBodySha256: string;
  readonly capture: Awaited<ReturnType<typeof collectAwsHealthProviderEvidence>>;
}> {
  const request = parseAwsHealthProviderRouteRequest(input.body);
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted
    || input.headers.tenantId !== request.scope.orgId
    || input.headers.customerId !== request.scope.customerId
    || input.headers.connectionId !== request.scope.connectionId
    || input.headers.requestId !== request.requestId) throw new AwsHealthProviderAdapterError("INVALID_REQUEST");
  const now = dependencies.now?.() ?? Date.now();
  const remaining = Date.parse(request.deadlineAtIso) - now;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(remaining) || remaining < 1
    || remaining > AWS_HEALTH_PROVIDER_BOUNDS.maximumDurationMs) throw new AwsHealthProviderAdapterError("INVALID_REQUEST");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(remaining)]);
  const sessionForTarget = async (target: AwsHealthProviderTarget, targetSignal: AbortSignal) => {
    if (!request.candidateAccounts.some((candidate) => same(candidate, target)) || targetSignal.aborted) throw new AwsHealthProviderAdapterError("INVALID_REQUEST");
    const session = await dependencies.assumeReadOnlySession({
      tenantId: request.scope.orgId, customerId: request.scope.customerId,
      connectionId: target.connectionId, expectedAccountId: target.accountId,
      partition: request.scope.partition, requestId: request.requestId,
      sessionActions: AWS_HEALTH_PROVIDER_SESSION_ACTIONS, signal: targetSignal,
    });
    if (session.accountId !== target.accountId || session.partition !== request.scope.partition) throw new AwsHealthProviderAdapterError("INVALID_REQUEST");
    return session.credentials;
  };
  const reader = dependencies.readerFactory({ request, sessionForTarget });
  const capture = await collectAwsHealthProviderEvidence({ request, reader, signal, ...(dependencies.now === undefined ? {} : { now: dependencies.now }) });
  return Object.freeze({
    schemaVersion: "sutra.aws-health-provider-response.v1",
    requestId: request.requestId,
    requestBodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"),
    capture,
  });
}
