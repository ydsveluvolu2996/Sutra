/** Strict authenticated collector route for ADV-04 Extended Support. */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";
import {
  EXTENDED_SUPPORT_PROVIDER_BOUNDS,
  EXTENDED_SUPPORT_PROVIDER_OPERATIONS,
  EXTENDED_SUPPORT_PROVIDER_SESSION_ACTIONS,
  ExtendedSupportProviderAdapterError,
  collectExtendedSupportProviderEvidence,
  type ExtendedSupportAwsReader,
  type ExtendedSupportProviderBoundary,
} from "./extended-support-provider-adapter.js";

export const EXTENDED_SUPPORT_PROVIDER_ROUTE = "/v1/finops/extended-support/collect";
const JOB = /^job_[a-f0-9]{32}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;

export interface ExtendedSupportProviderRouteRequest {
  readonly schemaVersion: "sutra.extended-support-collector-request.v1";
  readonly jobId: string;
  readonly scheduledWindow: string;
  readonly boundary: ExtendedSupportProviderBoundary;
  readonly operations: typeof EXTENDED_SUPPORT_PROVIDER_OPERATIONS;
  readonly bounds: Readonly<Record<string, number>>;
  readonly inventoryScope: "SERVER_PINNED_ACCOUNT_REGION_FANOUT";
  readonly lifecycleSource: "AUTHORITATIVE_AWS_API_OR_DOCUMENTATION";
  readonly pricingSource: "AWS_PRICE_LIST_OR_PUBLIC_PRICING";
  readonly actualCostSource: "ACTIVE_RECONCILED_CUR2_GENERATION";
  readonly deadlineAtIso: string;
}

export interface ExtendedSupportProviderRouteHeaders {
  readonly tenantId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly jobId: string;
}

export interface ExtendedSupportProviderRouteDependencies {
  /** Exact per-account sessions; credentials remain inside the reader factory. */
  readonly assumeReadOnlySession: (input: {
    readonly tenantId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly jobId: string;
    readonly expectedAccountId: string;
    readonly partition: ExtendedSupportProviderBoundary["partition"];
    readonly sessionActions: typeof EXTENDED_SUPPORT_PROVIDER_SESSION_ACTIONS;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly accountId: string;
    readonly partition: ExtendedSupportProviderBoundary["partition"];
    readonly credentials: AwsTemporaryCredentials;
  }>;
  readonly readerFactory: (input: {
    readonly boundary: ExtendedSupportProviderBoundary;
    readonly jobId: string;
    readonly sessionForAccount: (
      accountId: string,
      signal: AbortSignal,
    ) => Promise<AwsTemporaryCredentials>;
  }) => ExtendedSupportAwsReader;
  readonly now?: () => number;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ExtendedSupportProviderAdapterError("INVALID_REQUEST");
  }
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
    throw new ExtendedSupportProviderAdapterError("INVALID_REQUEST");
  }
  return record;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function boundary(value: unknown): ExtendedSupportProviderBoundary {
  const item = exact(value, [
    "scope", "managementAccountId", "partition", "accountIds", "regions",
  ]);
  const scope = exact(item.scope, ["orgId", "customerId", "connectionId"]);
  const accountIds = item.accountIds;
  const regions = item.regions;
  if (typeof scope.orgId !== "string" || !IDENTIFIER.test(scope.orgId)
    || typeof scope.customerId !== "string" || !IDENTIFIER.test(scope.customerId)
    || typeof scope.connectionId !== "string" || !CONNECTION.test(scope.connectionId)
    || typeof item.managementAccountId !== "string" || !ACCOUNT.test(item.managementAccountId)
    || !["aws", "aws-cn", "aws-us-gov"].includes(String(item.partition))
    || !Array.isArray(accountIds) || accountIds.length < 1
    || accountIds.length > EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumAccounts
    || !accountIds.every((entry) => typeof entry === "string" && ACCOUNT.test(entry))
    || !accountIds.includes(item.managementAccountId)
    || !same(accountIds, [...new Set(accountIds)].sort())
    || !Array.isArray(regions) || regions.length < 1
    || regions.length > EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumRegions
    || !regions.every((entry) => typeof entry === "string" && REGION.test(entry))
    || !same(regions, [...new Set(regions)].sort())) {
    throw new ExtendedSupportProviderAdapterError("INVALID_REQUEST");
  }
  return item as unknown as ExtendedSupportProviderBoundary;
}

export function parseExtendedSupportProviderRouteRequest(
  body: string,
): ExtendedSupportProviderRouteRequest {
  if (Buffer.byteLength(body, "utf8") > 64 * 1_024) {
    throw new ExtendedSupportProviderAdapterError("BOUND_REACHED");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch {
    throw new ExtendedSupportProviderAdapterError("INVALID_REQUEST");
  }
  const value = exact(parsed, [
    "schemaVersion", "jobId", "scheduledWindow", "boundary", "operations", "bounds",
    "inventoryScope", "lifecycleSource", "pricingSource", "actualCostSource", "deadlineAtIso",
  ]);
  const trustedBoundary = boundary(value.boundary);
  const deadline = typeof value.deadlineAtIso === "string" ? Date.parse(value.deadlineAtIso) : Number.NaN;
  if (value.schemaVersion !== "sutra.extended-support-collector-request.v1"
    || typeof value.jobId !== "string" || !JOB.test(value.jobId)
    || typeof value.scheduledWindow !== "string" || !WINDOW.test(value.scheduledWindow)
    || new Date(Date.parse(value.scheduledWindow)).toISOString() !== value.scheduledWindow
    || !same(value.operations, EXTENDED_SUPPORT_PROVIDER_OPERATIONS)
    || !same(value.bounds, {
      maximumCaptureBytes: 32 * 1_024 * 1_024,
      maximumOutputBytes: 8 * 1_024 * 1_024,
      maximumDurationMs: 15 * 60 * 1_000,
      maximumAccounts: 1_000,
      maximumRegions: 50,
      maximumObservations: 50_000,
      maximumHistoryPerResource: 24,
      maximumHistoryAgeDays: 400,
      maximumCurrentObservationAgeHours: 48,
      maximumAuthoritativeEvidenceAgeHours: 31 * 24,
      maximumCalendarEntries: 2_000,
      maximumRates: 10_000,
      maximumObservedCharges: 100_000,
      maximumResourcesInResponse: 5_000,
      maximumTextLength: 512,
      maximumUnitsPerHour: 100_000,
    })
    || value.inventoryScope !== "SERVER_PINNED_ACCOUNT_REGION_FANOUT"
    || value.lifecycleSource !== "AUTHORITATIVE_AWS_API_OR_DOCUMENTATION"
    || value.pricingSource !== "AWS_PRICE_LIST_OR_PUBLIC_PRICING"
    || value.actualCostSource !== "ACTIVE_RECONCILED_CUR2_GENERATION"
    || !Number.isFinite(deadline) || new Date(deadline).toISOString() !== value.deadlineAtIso) {
    throw new ExtendedSupportProviderAdapterError("INVALID_REQUEST");
  }
  return { ...value, boundary: trustedBoundary } as unknown as ExtendedSupportProviderRouteRequest;
}

export async function runExtendedSupportProviderRoute(input: {
  readonly body: string;
  readonly headers: ExtendedSupportProviderRouteHeaders;
  readonly signal: AbortSignal;
}, dependencies: ExtendedSupportProviderRouteDependencies): Promise<{
  readonly schemaVersion: "sutra.extended-support-provider-response.v1";
  readonly jobId: string;
  readonly requestBodySha256: string;
  readonly capture: Awaited<ReturnType<typeof collectExtendedSupportProviderEvidence>>;
}> {
  const request = parseExtendedSupportProviderRouteRequest(input.body);
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted
    || input.headers.tenantId !== request.boundary.scope.orgId
    || input.headers.customerId !== request.boundary.scope.customerId
    || input.headers.connectionId !== request.boundary.scope.connectionId
    || input.headers.jobId !== request.jobId) {
    throw new ExtendedSupportProviderAdapterError("INVALID_REQUEST");
  }
  const now = dependencies.now?.() ?? Date.now();
  const remainingMs = Date.parse(request.deadlineAtIso) - now;
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(remainingMs)
    || remainingMs < 1 || remainingMs > EXTENDED_SUPPORT_PROVIDER_BOUNDS.maximumDurationMs) {
    throw new ExtendedSupportProviderAdapterError("INVALID_REQUEST");
  }
  const signal = AbortSignal.any([input.signal, AbortSignal.timeout(remainingMs)]);
  const sessionForAccount = async (accountId: string, signal: AbortSignal) => {
    if (!request.boundary.accountIds.includes(accountId) || signal.aborted) {
      throw new ExtendedSupportProviderAdapterError("INVALID_REQUEST");
    }
    const session = await dependencies.assumeReadOnlySession({
      tenantId: request.boundary.scope.orgId,
      customerId: request.boundary.scope.customerId,
      connectionId: request.boundary.scope.connectionId,
      jobId: request.jobId,
      expectedAccountId: accountId,
      partition: request.boundary.partition,
      sessionActions: EXTENDED_SUPPORT_PROVIDER_SESSION_ACTIONS,
      signal,
    });
    if (session.accountId !== accountId || session.partition !== request.boundary.partition) {
      throw new ExtendedSupportProviderAdapterError("INVALID_REQUEST");
    }
    return session.credentials;
  };
  const reader = dependencies.readerFactory({
    boundary: request.boundary,
    jobId: request.jobId,
    sessionForAccount,
  });
  const capture = await collectExtendedSupportProviderEvidence({
    boundary: request.boundary,
    reader,
    signal,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  return Object.freeze({
    schemaVersion: "sutra.extended-support-provider-response.v1",
    jobId: request.jobId,
    requestBodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"),
    capture,
  });
}
