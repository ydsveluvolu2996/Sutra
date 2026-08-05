/** Strict same-tenant route for the credential-owning CORA provider. */
import { createHash } from "node:crypto";
import {
  CORA_PROVIDER_BOUNDS, CORA_PROVIDER_SESSION_ACTIONS, CoraProviderError,
  collectCoraProviderEvidence, type CoraProviderReader, type CoraProviderRequest,
} from "./cora-export-provider-adapter.js";
import type { AwsTemporaryCredentials } from "./types.js";

export const CORA_PROVIDER_ROUTE = "/v1/finops/cora/collect";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u; const CONNECTION = /^conn_[a-f0-9]{32}$/u; const REQUEST = /^corarq_[a-f0-9]{64}$/u;
export interface CoraProviderRouteHeaders { readonly tenantId: string; readonly customerId: string; readonly connectionId: string; readonly requestId: string; }
export interface CoraProviderContract { readonly request: Omit<CoraProviderRequest, "requestKey" | "scheduledWindow" | "deadlineAtIso">; }
export interface CoraProviderRouteDependencies {
  readonly resolveContract: (headers: CoraProviderRouteHeaders, signal: AbortSignal) => Promise<CoraProviderContract>;
  readonly assumeReadOnlySession: (input: { readonly tenantId: string; readonly customerId: string; readonly connectionId: string; readonly expectedAccountId: string; readonly partition: "aws" | "aws-cn" | "aws-us-gov"; readonly requestId: string; readonly sessionActions: typeof CORA_PROVIDER_SESSION_ACTIONS; readonly signal: AbortSignal }) => Promise<{ readonly accountId: string; readonly partition: "aws" | "aws-cn" | "aws-us-gov"; readonly credentials: AwsTemporaryCredentials }>;
  readonly readerFactory: (request: CoraProviderRequest) => CoraProviderReader;
  readonly now?: () => number;
}
function reject(): never { throw new CoraProviderError("INVALID_REQUEST"); }
function exact(value: unknown, keys: readonly string[]): Record<string, unknown> { if (typeof value !== "object" || value === null || Array.isArray(value)) reject(); const row = value as Record<string, unknown>; if (JSON.stringify(Object.keys(row).sort()) !== JSON.stringify([...keys].sort())) reject(); return row; }
function same(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }
export function parseCoraProviderRequest(body: string): CoraProviderRequest {
  if (Buffer.byteLength(body, "utf8") > 256 * 1_024) reject(); let parsed: unknown; try { parsed = JSON.parse(body); } catch { reject(); }
  const value = exact(parsed, ["schemaVersion", "requestKey", "scheduledWindow", "scope", "target", "expectedAccountIds", "expectedRegions", "operations", "manifestSelection", "rejectMutableLatestManifest", "acceptDirectApiRecommendationRows", "bounds", "deadlineAtIso", "credentials"]);
  exact(value.scope, ["orgId", "customerId", "connectionId", "partition", "managementAccountId", "awsOrganizationId"]);
  exact(value.target, ["exportArn", "exportName", "bucketName", "prefix", "partition", "tableName", "includeAllRecommendations", "filterJson", "fileVersioning", "refreshCadence", "fileFormat", "compression", "exportDefinitionSha256", "querySha256", "tableConfigurationsSha256"]);
  if (value.schemaVersion !== "sutra.cora-export-provider-request.v1" || typeof value.requestKey !== "string" || !REQUEST.test(value.requestKey)
    || typeof value.scheduledWindow !== "string" || !/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u.test(value.scheduledWindow)
    || !same(value.operations, CORA_PROVIDER_SESSION_ACTIONS.slice(1)) || !same(value.bounds, CORA_PROVIDER_BOUNDS)
    || value.manifestSelection !== "EXECUTION_SPECIFIC_ONLY" || value.rejectMutableLatestManifest !== true
    || value.acceptDirectApiRecommendationRows !== false || value.credentials !== "SERVER_OWNED_TRUST_ROLE_SESSION"
    || typeof value.deadlineAtIso !== "string" || !Number.isFinite(Date.parse(value.deadlineAtIso))) reject();
  return value as unknown as CoraProviderRequest;
}
export async function handleCoraProviderRoute(input: { readonly body: string; readonly headers: CoraProviderRouteHeaders; readonly signal: AbortSignal; readonly dependencies: CoraProviderRouteDependencies }) {
  const { headers } = input; if (!IDENTIFIER.test(headers.tenantId) || !IDENTIFIER.test(headers.customerId) || !CONNECTION.test(headers.connectionId) || !REQUEST.test(headers.requestId)) reject();
  const request = parseCoraProviderRequest(input.body); if (headers.requestId !== request.requestKey || request.scope.orgId !== headers.tenantId || request.scope.customerId !== headers.customerId || request.scope.connectionId !== headers.connectionId) reject();
  const now = input.dependencies.now?.() ?? Date.now(); if (!Number.isSafeInteger(now) || Date.parse(request.deadlineAtIso) <= now || Date.parse(request.deadlineAtIso) > now + CORA_PROVIDER_BOUNDS.maximumDurationMs + 5_000) reject();
  const contract = await input.dependencies.resolveContract(headers, input.signal);
  if (!same(contract.request, { ...request, requestKey: undefined, scheduledWindow: undefined, deadlineAtIso: undefined })) {
    const candidate = { ...request } as Record<string, unknown>; delete candidate.requestKey; delete candidate.scheduledWindow; delete candidate.deadlineAtIso;
    if (!same(contract.request, candidate)) reject();
  }
  const session = await input.dependencies.assumeReadOnlySession({ tenantId: headers.tenantId, customerId: headers.customerId, connectionId: headers.connectionId, expectedAccountId: request.scope.managementAccountId, partition: request.scope.partition, requestId: request.requestKey, sessionActions: CORA_PROVIDER_SESSION_ACTIONS, signal: input.signal });
  if (session.accountId !== request.scope.managementAccountId || session.partition !== request.scope.partition) reject();
  const materialization = await collectCoraProviderEvidence({ request, credentials: session.credentials, reader: input.dependencies.readerFactory(request), signal: input.signal, ...(input.dependencies.now === undefined ? {} : { now: input.dependencies.now }) });
  return { schemaVersion: "sutra.cora-export-provider-response.v1" as const, requestId: request.requestKey, requestBodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"), materialization };
}
