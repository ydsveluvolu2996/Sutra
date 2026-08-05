/** Strict authenticated route boundary for the ADV-09 AWS Support provider. */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";
import {
  AWS_SUPPORT_CASES_PROVIDER_BOUNDS,
  AWS_SUPPORT_CASES_PROVIDER_SESSION_ACTIONS,
  AwsSupportCasesProviderAdapterError,
  collectAwsSupportCasesProviderEvidence,
  type AwsSupportCasesProviderClient,
  type AwsSupportCasesProviderPartition,
  type AwsSupportCasesProviderRequest,
} from "./aws-support-cases-provider-adapter.js";
import { createAwsSupportCasesProviderClient } from
  "./aws-support-cases-provider-client.js";
import { AWS_SUPPORT_CASES_PERMISSION_ACTIONS } from
  "./aws-support-cases-permission-contract.js";

export const AWS_SUPPORT_CASES_PROVIDER_ROUTE = "/v1/finops/aws-support-cases/collect";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const JOB_ID = /^supportjob_[a-f0-9]{32}$/u;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

const READ_OPERATIONS = AWS_SUPPORT_CASES_PERMISSION_ACTIONS;
const LIMITS = Object.freeze({
  casePageSize: 100,
  communicationPageSize: 100,
  maximumRequestsPerSecondPerAccount: 4,
  maximumConcurrency: 2,
  maximumDurationMs: 900_000,
  maximumBytes: 67_108_864,
  maximumCasePages: 10_000,
  maximumCommunicationPages: 50_000,
  maximumCases: 50_000,
  maximumCommunications: 250_000,
});

export interface AwsSupportCasesProviderRouteHeaders {
  readonly tenantId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly jobId: string;
}

export interface AwsSupportCasesProviderRouteDependencies {
  /** A server-owned key from KMS/Secrets Manager; never request or tenant data. */
  readonly evidenceKey: Uint8Array;
  readonly assumeReadOnlySession: (input: {
    readonly tenantId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly jobId: string;
    readonly expectedAccountId: string;
    readonly partition: AwsSupportCasesProviderPartition;
    readonly sessionActions: typeof AWS_SUPPORT_CASES_PROVIDER_SESSION_ACTIONS;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly accountId: string;
    readonly partition: AwsSupportCasesProviderPartition;
    readonly credentials: AwsTemporaryCredentials;
  }>;
  readonly clientFactory?: (input: {
    readonly partition: AwsSupportCasesProviderPartition;
    readonly credentials: AwsTemporaryCredentials;
  }) => AwsSupportCasesProviderClient;
  readonly now?: () => number;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AwsSupportCasesProviderAdapterError("INVALID_REQUEST");
  }
  const item = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(item).sort()) !== JSON.stringify([...keys].sort())) {
    throw new AwsSupportCasesProviderAdapterError("INVALID_REQUEST");
  }
  return item;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function canonicalIso(value: unknown): value is string {
  return typeof value === "string" && ISO.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(Date.parse(value)).toISOString() === value;
}

function parseWindow(value: unknown): AwsSupportCasesProviderRequest["window"] {
  const window = exact(value, ["mode", "afterTime", "beforeTime", "priorWatermark", "nextWatermark"]);
  const prior = window.priorWatermark;
  if (!new Set(["INITIAL", "INCREMENTAL"]).has(String(window.mode))
    || !canonicalIso(window.afterTime) || !canonicalIso(window.beforeTime)
    || !canonicalIso(window.nextWatermark)
    || (prior !== null && !canonicalIso(prior))
    || Date.parse(window.afterTime) >= Date.parse(window.beforeTime)
    || window.nextWatermark !== window.beforeTime
    || (window.mode === "INITIAL" && prior !== null)
    || (window.mode === "INCREMENTAL" && prior === null)) {
    throw new AwsSupportCasesProviderAdapterError("INVALID_REQUEST");
  }
  return window as unknown as AwsSupportCasesProviderRequest["window"];
}

export function parseAwsSupportCasesProviderRouteRequest(body: string): AwsSupportCasesProviderRequest {
  if (Buffer.byteLength(body, "utf8") > 64 * 1_024) {
    throw new AwsSupportCasesProviderAdapterError("BOUND_REACHED");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch {
    throw new AwsSupportCasesProviderAdapterError("INVALID_REQUEST");
  }
  const value = exact(parsed, [
    "tenantId", "customerId", "parentConnectionId", "partition", "endpointRegion",
    "jobId", "window", "intendedAccounts", "readOperations", "entitlementProbe",
    "credentials", "sanitizeBeforeBroker", "includeRawSubjects", "includeRawCommunications",
    "includeContactIdentifiers", "includeAttachmentMetadata", "includeProviderMessages",
    "includeRawPaginationTokens", "limits",
  ]);
  const accounts = value.intendedAccounts;
  const partition = value.partition;
  if (typeof value.tenantId !== "string" || !IDENTIFIER.test(value.tenantId)
    || typeof value.customerId !== "string" || !IDENTIFIER.test(value.customerId)
    || typeof value.parentConnectionId !== "string" || !CONNECTION_ID.test(value.parentConnectionId)
    || (partition !== "aws" && partition !== "aws-us-gov")
    || value.endpointRegion !== (partition === "aws" ? "us-east-1" : "us-gov-west-1")
    || typeof value.jobId !== "string" || !JOB_ID.test(value.jobId)
    || !Array.isArray(accounts) || accounts.length < 1
    || accounts.length > AWS_SUPPORT_CASES_PROVIDER_BOUNDS.maximumAccounts
    || !same(value.readOperations, READ_OPERATIONS)
    || value.entitlementProbe !== "DESCRIBE_CASES_AUTHORIZATION_OUTCOME"
    || value.credentials !== "SERVER_OWNED_TRUST_ROLE_SESSIONS"
    || value.sanitizeBeforeBroker !== true
    || value.includeRawSubjects !== false || value.includeRawCommunications !== false
    || value.includeContactIdentifiers !== false || value.includeAttachmentMetadata !== false
    || value.includeProviderMessages !== false || value.includeRawPaginationTokens !== false
    || !same(value.limits, LIMITS)) {
    throw new AwsSupportCasesProviderAdapterError("INVALID_REQUEST");
  }
  const intendedAccounts = accounts.map((raw) => {
    const account = exact(raw, ["accountId", "connectionId"]);
    if (typeof account.accountId !== "string" || !ACCOUNT_ID.test(account.accountId)
      || typeof account.connectionId !== "string" || !CONNECTION_ID.test(account.connectionId)) {
      throw new AwsSupportCasesProviderAdapterError("INVALID_REQUEST");
    }
    return { accountId: account.accountId, connectionId: account.connectionId };
  });
  if (!same(intendedAccounts, [...intendedAccounts].sort((left, right) => left.accountId.localeCompare(right.accountId)))
    || new Set(intendedAccounts.map((item) => item.accountId)).size !== intendedAccounts.length
    || new Set(intendedAccounts.map((item) => item.connectionId)).size !== intendedAccounts.length) {
    throw new AwsSupportCasesProviderAdapterError("INVALID_REQUEST");
  }
  return Object.freeze({
    tenantId: value.tenantId,
    customerId: value.customerId,
    parentConnectionId: value.parentConnectionId,
    partition,
    endpointRegion: value.endpointRegion as "us-east-1" | "us-gov-west-1",
    jobId: value.jobId,
    window: parseWindow(value.window),
    intendedAccounts,
  });
}

export async function runAwsSupportCasesProviderRoute(input: {
  readonly body: string;
  readonly headers: AwsSupportCasesProviderRouteHeaders;
  readonly signal: AbortSignal;
}, dependencies: AwsSupportCasesProviderRouteDependencies): Promise<{
  readonly schemaVersion: "sutra.aws-support-cases-broker-response.v1";
  readonly jobId: string;
  readonly requestBodySha256: string;
  readonly capture: Awaited<ReturnType<typeof collectAwsSupportCasesProviderEvidence>>;
}> {
  const request = parseAwsSupportCasesProviderRouteRequest(input.body);
  if (!(input.signal instanceof AbortSignal) || input.signal.aborted
    || input.headers.tenantId !== request.tenantId
    || input.headers.customerId !== request.customerId
    || input.headers.connectionId !== request.parentConnectionId
    || input.headers.jobId !== request.jobId
    || !(dependencies.evidenceKey instanceof Uint8Array)
    || dependencies.evidenceKey.byteLength < 32 || dependencies.evidenceKey.byteLength > 64) {
    throw new AwsSupportCasesProviderAdapterError("INVALID_REQUEST");
  }
  const clientFactory = dependencies.clientFactory ?? createAwsSupportCasesProviderClient;
  const capture = await collectAwsSupportCasesProviderEvidence({
    request,
    evidenceKey: dependencies.evidenceKey,
    signal: input.signal,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
    clientForAccount: async (account, signal) => {
      if (!request.intendedAccounts.some((item) => same(item, account)) || signal.aborted) {
        throw new AwsSupportCasesProviderAdapterError("INVALID_REQUEST");
      }
      const session = await dependencies.assumeReadOnlySession({
        tenantId: request.tenantId,
        customerId: request.customerId,
        connectionId: account.connectionId,
        jobId: request.jobId,
        expectedAccountId: account.accountId,
        partition: request.partition,
        sessionActions: AWS_SUPPORT_CASES_PROVIDER_SESSION_ACTIONS,
        signal,
      });
      if (session.accountId !== account.accountId || session.partition !== request.partition) {
        throw new AwsSupportCasesProviderAdapterError("INVALID_REQUEST");
      }
      return clientFactory({ partition: session.partition, credentials: session.credentials });
    },
  });
  return Object.freeze({
    schemaVersion: "sutra.aws-support-cases-broker-response.v1",
    jobId: request.jobId,
    requestBodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"),
    capture,
  });
}
