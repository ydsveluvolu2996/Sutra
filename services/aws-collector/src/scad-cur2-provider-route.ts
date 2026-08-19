/** Strict same-tenant signed route for ADD-07 SCAD CUR2 provider operations. */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";
import { SCAD_CUR2_PROVIDER_ACTIONS, SCAD_CUR2_PROVIDER_BOUNDS, ScadCur2ProviderAdapterError,
  runScadCur2ProviderOperation, validateScadCur2ProviderRequest, type ScadCur2ProviderBinding,
  type ScadCur2ProviderReader, type ScadCur2ProviderRequest } from "./scad-cur2-provider-adapter.js";

export const SCAD_CUR2_PROVIDER_ROUTE = "/v1/finops/scad/cur2-provider" as const;
export interface ScadCur2ProviderRouteHeaders { readonly tenantId: string; readonly customerId: string;
  readonly connectionId: string; readonly jobId: string }
export interface ScadCur2ProviderRouteDependencies {
  readonly loadBinding: (scope: { readonly tenantId: string; readonly customerId: string;
    readonly connectionId: string }) => Promise<ScadCur2ProviderBinding>;
  readonly assumeReadOnlySession: (input: { readonly tenantId: string; readonly customerId: string;
    readonly connectionId: string; readonly expectedAccountId: string; readonly partition: "aws" | "aws-us-gov" | "aws-cn";
    readonly region: string; readonly permissionPackVersion: ScadCur2ProviderBinding["permissionPackVersion"];
    readonly contractId: "foundational-cur2-export-v1"; readonly bucket: string; readonly prefix: string;
    readonly sessionActions: typeof SCAD_CUR2_PROVIDER_ACTIONS; readonly signal: AbortSignal }) => Promise<{
      readonly accountId: string; readonly partition: "aws" | "aws-us-gov" | "aws-cn";
      readonly permissionPackVersion: ScadCur2ProviderBinding["permissionPackVersion"];
      readonly credentials: AwsTemporaryCredentials }>;
  readonly readerFactory: (input: { readonly credentials: AwsTemporaryCredentials;
    readonly partition: "aws" | "aws-us-gov" | "aws-cn"; readonly region: string }) => ScadCur2ProviderReader;
}
function invalid(): never { throw new ScadCur2ProviderAdapterError("INVALID_REQUEST"); }
export function parseScadCur2ProviderRouteRequest(body: string): ScadCur2ProviderRequest {
  if (typeof body !== "string" || Buffer.byteLength(body, "utf8") > SCAD_CUR2_PROVIDER_BOUNDS.maximumResponseBytes) invalid();
  let parsed: unknown; try { parsed = JSON.parse(body); } catch { invalid(); }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    || JSON.stringify(Object.keys(parsed).sort()) !== JSON.stringify(["boundary", "jobId", "operation", "requestId", "scheduledWindow", "schemaVersion"])) invalid();
  const boundary = (parsed as Readonly<Record<string, unknown>>).boundary;
  if (typeof boundary !== "object" || boundary === null || Array.isArray(boundary)) invalid();
  const scope = (boundary as Readonly<Record<string, unknown>>).scope;
  if (typeof scope !== "object" || scope === null || Array.isArray(scope)) invalid();
  return parsed as ScadCur2ProviderRequest;
}
export async function runScadCur2ProviderRoute(input: { readonly body: string;
  readonly headers: ScadCur2ProviderRouteHeaders; readonly signal: AbortSignal },
  dependencies: ScadCur2ProviderRouteDependencies): Promise<{ readonly schemaVersion: "sutra.scad-cur2-provider-response.v1";
    readonly requestId: string; readonly requestBodySha256: string; readonly payload: unknown }> {
  const request = parseScadCur2ProviderRouteRequest(input.body);
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted
    || input.headers.tenantId !== request.boundary.scope.orgId
    || input.headers.customerId !== request.boundary.scope.customerId
    || input.headers.connectionId !== request.boundary.scope.connectionId
    || input.headers.jobId !== request.jobId) invalid();
  const binding = await dependencies.loadBinding({ tenantId: input.headers.tenantId,
    customerId: input.headers.customerId, connectionId: input.headers.connectionId });
  validateScadCur2ProviderRequest(request, binding);
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(SCAD_CUR2_PROVIDER_BOUNDS.maximumDurationMs)]);
  const session = await dependencies.assumeReadOnlySession({ tenantId: binding.tenantId,
    customerId: binding.customerId, connectionId: binding.connectionId, expectedAccountId: binding.accountId,
    partition: binding.partition, region: binding.region, permissionPackVersion: binding.permissionPackVersion,
    contractId: binding.contractId, bucket: binding.bucket, prefix: binding.prefix,
    sessionActions: SCAD_CUR2_PROVIDER_ACTIONS, signal });
  if (session.accountId !== binding.accountId || session.partition !== binding.partition
    || session.permissionPackVersion !== binding.permissionPackVersion) invalid();
  const payload = await runScadCur2ProviderOperation({ request, binding, credentials: session.credentials,
    reader: dependencies.readerFactory({ credentials: session.credentials, partition: session.partition,
      region: binding.region }), signal });
  return Object.freeze({ schemaVersion: "sutra.scad-cur2-provider-response.v1" as const, requestId: request.requestId,
    requestBodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"), payload });
}
