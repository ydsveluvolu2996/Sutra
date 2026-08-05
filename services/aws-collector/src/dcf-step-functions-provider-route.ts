/** Strict authenticated credential-owning route for ADV-12 DCF collection. */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";
import {
  DCF_PROVIDER_ACTIONS,
  DCF_PROVIDER_BOUNDS,
  DCF_PROVIDER_SESSION_ACTIONS,
  DcfProviderAdapterError,
  collectDcfProviderEvidence,
  type DcfProviderReader,
  type DcfProviderRequest,
} from "./dcf-step-functions-provider-adapter.js";

export const DCF_STEP_FUNCTIONS_PROVIDER_ROUTE = "/v1/finops/dcf-step-functions/collect";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const BOUNDARY = /^dcfb_[a-f0-9]{64}$/u;
const MACHINE = /^arn:(aws|aws-us-gov|aws-cn):states:([a-z0-9-]+):(\d{12}):stateMachine:([A-Za-z0-9._+-]{1,80})(?::([A-Za-z0-9._+-]{1,80}))?$/u;

export interface DcfProviderRouteHeaders {
  readonly tenantId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly boundaryId: string;
}
export interface DcfProviderRouteDependencies {
  readonly assumeReadOnlySession: (input: {
    readonly tenantId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly expectedAccountId: string;
    readonly partition: "aws" | "aws-us-gov" | "aws-cn";
    readonly region: string;
    readonly boundaryId: string;
    readonly sessionActions: typeof DCF_PROVIDER_SESSION_ACTIONS;
    readonly stateMachineArns: readonly string[];
    readonly signal: AbortSignal;
  }) => Promise<{ readonly accountId: string; readonly partition: "aws" | "aws-us-gov" | "aws-cn"; readonly credentials: AwsTemporaryCredentials }>;
  readonly readerFactory: (input: {
    readonly credentials: AwsTemporaryCredentials;
    readonly partition: "aws" | "aws-us-gov" | "aws-cn";
    readonly region: string;
  }) => DcfProviderReader;
  readonly now?: () => number;
}
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new DcfProviderAdapterError("INVALID_REQUEST");
  const result = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(result).sort()) !== JSON.stringify([...keys].sort())) throw new DcfProviderAdapterError("INVALID_REQUEST");
  return result;
}
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
function partitionRegion(partition: unknown, region: unknown): partition is "aws" | "aws-us-gov" | "aws-cn" {
  return typeof region === "string" && (partition === "aws-cn" ? /^cn-[a-z]+-\d$/u.test(region)
    : partition === "aws-us-gov" ? /^us-gov-[a-z]+-\d$/u.test(region)
      : partition === "aws" && /^(?!cn-|us-gov-)[a-z]{2}-[a-z]+-\d$/u.test(region));
}

export function parseDcfProviderRouteRequest(body: string): DcfProviderRequest {
  if (Buffer.byteLength(body, "utf8") < 2 || Buffer.byteLength(body, "utf8") > 1_048_576) throw new DcfProviderAdapterError("BOUND_REACHED");
  let parsed: unknown; try { parsed = JSON.parse(body); } catch { throw new DcfProviderAdapterError("INVALID_REQUEST"); }
  const request = exact(parsed, ["schemaVersion", "boundary", "operations", "bounds", "credentials", "includeRawInput", "includeRawOutput", "includeRawProviderErrors", "includeRawPaginationTokens", "deadlineAtIso"]);
  const boundary = exact(request.boundary, ["schemaVersion", "boundaryId", "binding", "scope", "schedulerRegistered", "modules"]);
  const scope = exact(boundary.scope, ["orgId", "customerId", "connectionId", "managementAccountId", "partition", "region"]);
  if (request.schemaVersion !== "sutra.dcf-step-functions-provider-request.v1"
    || boundary.schemaVersion !== "sutra.dcf-step-functions-boundary.v1"
    || typeof boundary.boundaryId !== "string" || !BOUNDARY.test(boundary.boundaryId)
    || boundary.binding !== "SERVER_RESOLVED_DCF_STACK" || boundary.schedulerRegistered !== true
    || typeof scope.orgId !== "string" || !IDENTIFIER.test(scope.orgId)
    || typeof scope.customerId !== "string" || !IDENTIFIER.test(scope.customerId)
    || typeof scope.connectionId !== "string" || !CONNECTION.test(scope.connectionId)
    || typeof scope.managementAccountId !== "string" || !ACCOUNT.test(scope.managementAccountId)
    || !partitionRegion(scope.partition, scope.region)
    || !same(request.operations, DCF_PROVIDER_ACTIONS) || !same(request.bounds, DCF_PROVIDER_BOUNDS)
    || request.credentials !== "SERVER_OWNED_TRUST_ROLE_SESSION" || request.includeRawInput !== false
    || request.includeRawOutput !== false || request.includeRawProviderErrors !== false
    || request.includeRawPaginationTokens !== false || typeof request.deadlineAtIso !== "string"
    || !Number.isFinite(Date.parse(request.deadlineAtIso))
    || new Date(Date.parse(request.deadlineAtIso)).toISOString() !== request.deadlineAtIso
    || !Array.isArray(boundary.modules) || boundary.modules.length < 1 || boundary.modules.length > 500) {
    throw new DcfProviderAdapterError("INVALID_REQUEST");
  }
  const modules = boundary.modules.map((raw) => {
    const moduleDefinition = exact(raw, ["moduleId", "moduleName", "sourceId", "enabled", "expectedCadenceMinutes", "stateMachineArn"]);
    const match = typeof moduleDefinition.stateMachineArn === "string" ? MACHINE.exec(moduleDefinition.stateMachineArn) : null;
    if (typeof moduleDefinition.moduleId !== "string" || !IDENTIFIER.test(moduleDefinition.moduleId)
      || typeof moduleDefinition.moduleName !== "string" || moduleDefinition.moduleName.length < 1 || moduleDefinition.moduleName.length > 256
      || /[\u0000-\u001f\u007f<>]/u.test(moduleDefinition.moduleName)
      || (moduleDefinition.sourceId !== null && (typeof moduleDefinition.sourceId !== "string" || !IDENTIFIER.test(moduleDefinition.sourceId)))
      || typeof moduleDefinition.enabled !== "boolean" || !Number.isSafeInteger(moduleDefinition.expectedCadenceMinutes)
      || Number(moduleDefinition.expectedCadenceMinutes) < 5 || Number(moduleDefinition.expectedCadenceMinutes) > 10_080
      || match === null || match[1] !== scope.partition || match[2] !== scope.region || match[3] !== scope.managementAccountId) {
      throw new DcfProviderAdapterError("INVALID_REQUEST");
    }
    return moduleDefinition;
  });
  const sortedModules = [...modules].sort((left, right) =>
    String(left.moduleId).localeCompare(String(right.moduleId)));
  if (!modules.some((module) => module.enabled === true)
    || new Set(modules.map((module) => module.moduleId)).size !== modules.length
    || new Set(modules.map((module) => module.stateMachineArn)).size !== modules.length
    || !same(modules, sortedModules)) {
    throw new DcfProviderAdapterError("INVALID_REQUEST");
  }
  return { ...request, boundary: { ...boundary, scope, modules } } as unknown as DcfProviderRequest;
}

export async function runDcfProviderRoute(input: {
  readonly body: string;
  readonly headers: DcfProviderRouteHeaders;
  readonly signal: AbortSignal;
}, dependencies: DcfProviderRouteDependencies): Promise<{
  readonly schemaVersion: "sutra.dcf-step-functions-broker-response.v1";
  readonly boundaryId: string;
  readonly requestBodySha256: string;
  readonly result: Awaited<ReturnType<typeof collectDcfProviderEvidence>>;
}> {
  const request = parseDcfProviderRouteRequest(input.body); const scope = request.boundary.scope;
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted
    || input.headers.tenantId !== scope.orgId || input.headers.customerId !== scope.customerId
    || input.headers.connectionId !== scope.connectionId || input.headers.boundaryId !== request.boundary.boundaryId) {
    throw new DcfProviderAdapterError("INVALID_REQUEST");
  }
  const current = dependencies.now?.() ?? Date.now(); const remaining = Date.parse(request.deadlineAtIso) - current;
  if (!Number.isSafeInteger(current) || current < 0 || !Number.isSafeInteger(remaining) || remaining < 1
    || remaining > DCF_PROVIDER_BOUNDS.maximumDurationMs) throw new DcfProviderAdapterError("INVALID_REQUEST");
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(remaining)]);
  const stateMachineArns = Object.freeze(
    request.boundary.modules.map((module) => module.stateMachineArn).sort(),
  );
  const session = await dependencies.assumeReadOnlySession({
    tenantId: scope.orgId, customerId: scope.customerId, connectionId: scope.connectionId,
    expectedAccountId: scope.managementAccountId, partition: scope.partition, region: scope.region,
    boundaryId: request.boundary.boundaryId, sessionActions: DCF_PROVIDER_SESSION_ACTIONS,
    stateMachineArns, signal,
  });
  if (session.accountId !== scope.managementAccountId || session.partition !== scope.partition) throw new DcfProviderAdapterError("INVALID_REQUEST");
  const reader = dependencies.readerFactory({ credentials: session.credentials, partition: session.partition, region: scope.region });
  const result = await collectDcfProviderEvidence({ request, reader, signal, ...(dependencies.now === undefined ? {} : { now: dependencies.now }) });
  return Object.freeze({
    schemaVersion: "sutra.dcf-step-functions-broker-response.v1",
    boundaryId: request.boundary.boundaryId,
    requestBodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"),
    result,
  });
}
