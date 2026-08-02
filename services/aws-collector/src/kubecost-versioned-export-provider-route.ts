/** Strict same-tenant signed route for the credential-owning ADD-06 reader. */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";
import {
  KUBECOST_PROVIDER_ACTIONS,
  KUBECOST_PROVIDER_CONDITIONAL_KMS_ACTIONS,
  KUBECOST_PROVIDER_BOUNDS,
  KubecostProviderAdapterError,
  collectKubecostVersionedExport,
  validateKubecostProviderRequest,
  type KubecostProviderBinding,
  type KubecostProviderReader,
  type KubecostProviderRequest,
} from "./kubecost-versioned-export-provider-adapter.js";

export const KUBECOST_VERSIONED_EXPORT_PROVIDER_ROUTE =
  "/v1/finops/kubecost/versioned-export" as const;
const MAXIMUM_REQUEST_BYTES = 130 * 1_024 * 1_024;
const REQUEST_KEYS = Object.freeze([
  "schemaVersion", "requestId", "jobId", "scheduledWindow", "scope", "destination",
  "activeCur2", "activeCur2Sha256", "exportContract", "runtimeReadActions",
  "versionedReadActions", "conditionalKmsActions", "exporterWriteActions", "bounds",
  "maximumDurationMs",
] as const);

export interface KubecostProviderRouteHeaders {
  readonly tenantId: string; readonly customerId: string; readonly connectionId: string;
  readonly jobId: string;
}
export interface KubecostProviderRouteDependencies {
  readonly now?: () => number;
  readonly loadBinding: (scope: {
    readonly tenantId: string; readonly customerId: string; readonly connectionId: string;
  }) => Promise<KubecostProviderBinding>;
  readonly assumeReadOnlySession: (input: {
    readonly tenantId: string; readonly customerId: string; readonly connectionId: string;
    readonly expectedAccountId: string; readonly partition: "aws" | "aws-us-gov" | "aws-cn";
    readonly region: string; readonly permissionPackVersion: KubecostProviderBinding["permissionPackVersion"];
    readonly bucket: string; readonly prefix: string; readonly kmsKeyArn: string | null;
    readonly sessionActions: readonly string[]; readonly signal: AbortSignal;
  }) => Promise<{
    readonly accountId: string; readonly partition: "aws" | "aws-us-gov" | "aws-cn";
    readonly permissionPackVersion: KubecostProviderBinding["permissionPackVersion"];
    readonly credentials: AwsTemporaryCredentials;
  }>;
  readonly readerFactory: (input: {
    readonly credentials: AwsTemporaryCredentials; readonly partition: "aws" | "aws-us-gov" | "aws-cn";
    readonly region: string;
  }) => KubecostProviderReader;
}

function invalid(): never { throw new KubecostProviderAdapterError("INVALID_REQUEST"); }
function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}
export function parseKubecostProviderRouteRequest(body: string): KubecostProviderRequest {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > MAXIMUM_REQUEST_BYTES) invalid();
  let parsed: unknown; try { parsed = JSON.parse(body); } catch { invalid(); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || !exactKeys(parsed as Record<string, unknown>, REQUEST_KEYS)) invalid();
  const request = parsed as Record<string, unknown>; const scope = request.scope; const destination = request.destination;
  if (request.schemaVersion !== "sutra.kubecost-versioned-runtime-request.v1"
    || typeof request.requestId !== "string" || !/^kur_[a-f0-9]{64}$/u.test(request.requestId)
    || typeof request.jobId !== "string" || !/^job_[a-f0-9]{32}$/u.test(request.jobId)
    || typeof scope !== "object" || scope === null || Array.isArray(scope)
    || typeof destination !== "object" || destination === null || Array.isArray(destination)) invalid();
  return parsed as KubecostProviderRequest;
}

export async function runKubecostProviderRoute(input: {
  readonly body: string; readonly headers: KubecostProviderRouteHeaders; readonly signal: AbortSignal;
}, dependencies: KubecostProviderRouteDependencies): Promise<{
  readonly schemaVersion: "sutra.kubecost-versioned-runtime-response.v1";
  readonly requestId: string; readonly requestBodySha256: string;
  readonly capture: Awaited<ReturnType<typeof collectKubecostVersionedExport>>;
}> {
  const request = parseKubecostProviderRouteRequest(input.body);
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted
    || input.headers.tenantId !== request.scope.orgId || input.headers.customerId !== request.scope.customerId
    || input.headers.connectionId !== request.scope.connectionId || input.headers.jobId !== request.jobId) invalid();
  const binding = await dependencies.loadBinding({
    tenantId: input.headers.tenantId, customerId: input.headers.customerId,
    connectionId: input.headers.connectionId,
  });
  validateKubecostProviderRequest(request, binding);
  const current = dependencies.now?.() ?? Date.now();
  if (!Number.isSafeInteger(current) || current < 0) invalid();
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(KUBECOST_PROVIDER_BOUNDS.maximumDurationMs)]);
  const actions = request.destination.kmsKeyArn === null
    ? KUBECOST_PROVIDER_ACTIONS
    : Object.freeze([...KUBECOST_PROVIDER_ACTIONS, ...KUBECOST_PROVIDER_CONDITIONAL_KMS_ACTIONS]);
  const session = await dependencies.assumeReadOnlySession({
    tenantId: request.scope.orgId, customerId: request.scope.customerId,
    connectionId: request.scope.connectionId, expectedAccountId: request.destination.expectedBucketOwner,
    partition: request.scope.partition, region: binding.bucketRegion,
    permissionPackVersion: binding.permissionPackVersion, bucket: request.destination.bucket,
    prefix: request.destination.prefix, kmsKeyArn: request.destination.kmsKeyArn,
    sessionActions: actions, signal,
  });
  if (session.accountId !== request.destination.expectedBucketOwner
    || session.partition !== request.scope.partition
    || session.permissionPackVersion !== binding.permissionPackVersion) invalid();
  const capture = await collectKubecostVersionedExport({
    request, binding, credentials: session.credentials,
    reader: dependencies.readerFactory({ credentials: session.credentials, partition: session.partition, region: binding.bucketRegion }),
    signal, ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  return Object.freeze({
    schemaVersion: "sutra.kubecost-versioned-runtime-response.v1",
    requestId: request.requestId,
    requestBodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"),
    capture,
  });
}
