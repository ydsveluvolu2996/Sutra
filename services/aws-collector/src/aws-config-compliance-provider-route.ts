/** Strict authenticated route for the ADD-12 credential-owning Config collector. */
import { createHash } from "node:crypto";
import {
  AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS,
  AWS_CONFIG_COMPLIANCE_PROVIDER_SESSION_ACTIONS,
  AwsConfigComplianceProviderError,
  collectAwsConfigComplianceProviderEvidence,
  type AwsConfigComplianceProviderReader,
  type AwsConfigComplianceProviderRequest,
  type AwsConfigComplianceProviderTarget,
} from "./aws-config-compliance-provider-adapter.js";
import type { AwsTemporaryCredentials } from "./types.js";

export const AWS_CONFIG_COMPLIANCE_PROVIDER_ROUTE = "/v1/finops/aws-config-compliance/collect";
const REQUEST_BYTES = 2 * 1_024 * 1_024;
const REQUEST = /^acr_[a-f0-9]{64}$/u;

export interface AwsConfigComplianceProviderRouteHeaders {
  readonly tenantId: string; readonly customerId: string;
  readonly connectionId: string; readonly requestId: string;
}
export interface AwsConfigComplianceProviderRouteDependencies {
  readonly assumeReadOnlySession: (input: {
    readonly tenantId: string; readonly customerId: string; readonly connectionId: string;
    readonly expectedAccountId: string; readonly partition: "aws" | "aws-us-gov" | "aws-cn";
    readonly region: string; readonly requestId: string;
    readonly sessionActions: typeof AWS_CONFIG_COMPLIANCE_PROVIDER_SESSION_ACTIONS;
    readonly signal: AbortSignal;
  }) => Promise<{ readonly accountId: string; readonly partition: "aws" | "aws-us-gov" | "aws-cn";
    readonly credentials: AwsTemporaryCredentials }>;
  readonly readerFactory: (input: {
    readonly request: AwsConfigComplianceProviderRequest;
    readonly sessionForTarget: (target: AwsConfigComplianceProviderTarget,
      signal: AbortSignal) => Promise<AwsTemporaryCredentials>;
  }) => AwsConfigComplianceProviderReader;
  readonly now?: () => number;
}
function reject(code: AwsConfigComplianceProviderError["code"] = "INVALID_REQUEST"): never {
  throw new AwsConfigComplianceProviderError(code);
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject();
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) reject();
  return record;
}
function same(a: unknown, b: unknown): boolean { return JSON.stringify(a) === JSON.stringify(b); }

export function parseAwsConfigComplianceProviderRouteRequest(body: string): AwsConfigComplianceProviderRequest {
  if (Buffer.byteLength(body, "utf8") > REQUEST_BYTES) reject("BOUND_REACHED");
  let parsed: unknown; try { parsed = JSON.parse(body); } catch { reject(); }
  const value = exact(parsed, ["schemaVersion", "requestId", "scheduledWindow", "scope",
    "expectedCoverage", "targets", "operations", "inventoryQuery", "activity", "cur2",
    "credentials", "deadlineAtIso", "bounds"]);
  exact(value.scope, ["orgId", "customerId", "connectionId", "partition", "aggregatorAccountId",
    "aggregatorRegion", "aggregatorName", "aggregatorArn"]);
  exact(value.expectedCoverage, ["awsOrganizationId", "accountsEvidenceId", "accountsObservedAt",
    "activeAccountIds", "expectedRegions"]);
  exact(value.operations, ["central", "fanout"]);
  if (!Array.isArray(value.targets)) reject();
  for (const target of value.targets) exact(target, ["accountId", "region", "connectionId"]);
  if (value.schemaVersion !== "sutra.aws-config-compliance-provider-request.v1"
    || typeof value.requestId !== "string" || !REQUEST.test(value.requestId)
    || !same(value.bounds, AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS)) reject();
  return value as unknown as AwsConfigComplianceProviderRequest;
}

export async function runAwsConfigComplianceProviderRoute(input: {
  readonly body: string; readonly headers: AwsConfigComplianceProviderRouteHeaders;
  readonly signal: AbortSignal;
}, dependencies: AwsConfigComplianceProviderRouteDependencies): Promise<{
  readonly schemaVersion: "sutra.aws-config-compliance-provider-response.v1";
  readonly requestId: string; readonly requestBodySha256: string;
  readonly capture: Readonly<Record<string, unknown>>;
}> {
  const request = parseAwsConfigComplianceProviderRouteRequest(input.body);
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted
    || input.headers.tenantId !== request.scope.orgId
    || input.headers.customerId !== request.scope.customerId
    || input.headers.connectionId !== request.scope.connectionId
    || input.headers.requestId !== request.requestId) reject();
  const now = dependencies.now?.() ?? Date.now(); const remaining = Date.parse(request.deadlineAtIso) - now;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(remaining)
    || remaining < 1 || remaining > AWS_CONFIG_COMPLIANCE_PROVIDER_BOUNDS.maximumDurationMs) reject();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(remaining)]);
  const sessionForTarget = async (target: AwsConfigComplianceProviderTarget, targetSignal: AbortSignal) => {
    if (!request.targets.some((candidate) => same(candidate, target)) || targetSignal.aborted) reject();
    const session = await dependencies.assumeReadOnlySession({ tenantId: request.scope.orgId,
      customerId: request.scope.customerId, connectionId: target.connectionId,
      expectedAccountId: target.accountId, partition: request.scope.partition, region: target.region,
      requestId: request.requestId, sessionActions: AWS_CONFIG_COMPLIANCE_PROVIDER_SESSION_ACTIONS,
      signal: targetSignal });
    if (session.accountId !== target.accountId || session.partition !== request.scope.partition) reject();
    return session.credentials;
  };
  const reader = dependencies.readerFactory({ request, sessionForTarget });
  const capture = await collectAwsConfigComplianceProviderEvidence({ request, reader, signal,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }) });
  return Object.freeze({ schemaVersion: "sutra.aws-config-compliance-provider-response.v1",
    requestId: request.requestId,
    requestBodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"), capture });
}
