/** Strict signed-route boundary for the ADV-08 AWS Budgets provider adapter. */
import { createHash } from "node:crypto";
import type { AwsTemporaryCredentials } from "./types.js";
import {
  AWS_BUDGETS_PROVIDER_BOUNDS,
  AWS_BUDGETS_PROVIDER_SESSION_ACTIONS,
  AwsBudgetsProviderAdapterError,
  collectAwsBudgetsProviderEvidence,
  createAwsBudgetsProviderClients,
  type AwsBudgetsProviderClients,
  type AwsBudgetsProviderPartition,
  type AwsBudgetsProviderScope,
} from "./aws-budgets-provider-adapter.js";

export const AWS_BUDGETS_PROVIDER_ROUTE = "/v1/finops/aws-budgets/collect";
const REQUEST_ID = /^abr_[a-f0-9]{64}$/u;
const JOB_ID = /^job_[a-f0-9]{32}$/u;
const WINDOW = /^\d{4}-\d{2}-\d{2}T\d{2}:00:00\.000Z$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;

const BUDGET_OPERATIONS = Object.freeze([
  "DescribeBudgets", "DescribeBudgetPerformanceHistory", "DescribeNotificationsForBudget",
  "DescribeSubscribersForNotification", "DescribeBudgetActionsForBudget", "ListTagsForResource",
] as const);
const ORGANIZATION_OPERATIONS = Object.freeze([
  "organizations:DescribeOrganization", "organizations:ListAccounts", "organizations:ListRoots",
  "organizations:ListOrganizationalUnitsForParent", "organizations:ListParents",
] as const);
const COLLECTION_BOUNDS = Object.freeze({
  apiPageSize: 100,
  maximumPages: 5_000,
  maximumBudgets: 1_000,
  maximumHistoryRecords: 20_000,
  maximumDailyHistoryPerBudget: 60,
  maximumMonthlyHistoryPerBudget: 13,
  maximumQuarterlyHistoryPerBudget: 4,
  maximumNotifications: 5_000,
  maximumSubscribers: 50_000,
  maximumActions: 10_000,
  maximumBudgetLevelTags: 1_000,
  maximumCostFilterKeys: 50,
  maximumCostFilterValuesPerKey: 100,
  maximumTextCharacters: 256,
  maximumCaptureBytes: 12 * 1_024 * 1_024,
  maximumDashboardBytes: 4 * 1_024 * 1_024,
  maximumQueryPageSize: 100,
  maximumQueryAccountFilters: 100,
  maximumHierarchyAccounts: 10_000,
  maximumTaxonomyAssignments: 10_000,
  sourceFreshnessSlaHours: 24,
});

export interface AwsBudgetsProviderRouteRequest {
  readonly schemaVersion: "sutra.aws-budgets-durable-request.v1";
  readonly requestId: string;
  readonly jobId: string;
  readonly scheduledWindow: string;
  readonly scope: AwsBudgetsProviderScope;
  readonly budgetOperations: typeof BUDGET_OPERATIONS;
  readonly organizationOperations: typeof ORGANIZATION_OPERATIONS;
  readonly hierarchyTagKey: "cid:budget-level";
  readonly bounds: typeof COLLECTION_BOUNDS;
  readonly maximumDurationMs: 300_000;
}

export interface AwsBudgetsProviderRouteHeaders {
  readonly tenantId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly jobId: string;
}

export interface AwsBudgetsProviderRouteDependencies {
  /** Must use an inline STS intersection containing exactly sessionActions. */
  readonly assumeReadOnlySession: (input: {
    readonly tenantId: string;
    readonly customerId: string;
    readonly connectionId: string;
    readonly jobId: string;
    readonly expectedAccountId: string;
    readonly partition: AwsBudgetsProviderPartition;
    readonly sessionActions: typeof AWS_BUDGETS_PROVIDER_SESSION_ACTIONS;
    readonly signal: AbortSignal;
  }) => Promise<{
    readonly accountId: string;
    readonly partition: AwsBudgetsProviderPartition;
    readonly credentials: AwsTemporaryCredentials;
  }>;
  readonly clientFactory?: (input: {
    readonly partition: AwsBudgetsProviderPartition;
    readonly credentials: AwsTemporaryCredentials;
  }) => AwsBudgetsProviderClients;
  readonly now?: () => number;
}

function exact(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new AwsBudgetsProviderAdapterError("INVALID_REQUEST");
  }
  const record = value as Record<string, unknown>;
  if (JSON.stringify(Object.keys(record).sort()) !== JSON.stringify([...keys].sort())) {
    throw new AwsBudgetsProviderAdapterError("INVALID_REQUEST");
  }
  return record;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function parseScope(value: unknown): AwsBudgetsProviderScope {
  const scope = exact(value, ["orgId", "customerId", "connectionId", "accountId", "partition"]);
  if (typeof scope.orgId !== "string" || !IDENTIFIER.test(scope.orgId)
    || typeof scope.customerId !== "string" || !IDENTIFIER.test(scope.customerId)
    || typeof scope.connectionId !== "string" || !CONNECTION_ID.test(scope.connectionId)
    || typeof scope.accountId !== "string" || !ACCOUNT_ID.test(scope.accountId)
    || !["aws", "aws-us-gov", "aws-cn"].includes(String(scope.partition))) {
    throw new AwsBudgetsProviderAdapterError("INVALID_REQUEST");
  }
  return scope as unknown as AwsBudgetsProviderScope;
}

export function parseAwsBudgetsProviderRouteRequest(body: string): AwsBudgetsProviderRouteRequest {
  if (Buffer.byteLength(body, "utf8") > 64 * 1_024) {
    throw new AwsBudgetsProviderAdapterError("BOUND_REACHED");
  }
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { throw new AwsBudgetsProviderAdapterError("INVALID_REQUEST"); }
  const value = exact(parsed, [
    "schemaVersion", "requestId", "jobId", "scheduledWindow", "scope",
    "budgetOperations", "organizationOperations", "hierarchyTagKey", "bounds",
    "maximumDurationMs",
  ]);
  const scope = parseScope(value.scope);
  if (value.schemaVersion !== "sutra.aws-budgets-durable-request.v1"
    || typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)
    || typeof value.jobId !== "string" || !JOB_ID.test(value.jobId)
    || typeof value.scheduledWindow !== "string" || !WINDOW.test(value.scheduledWindow)
    || new Date(Date.parse(value.scheduledWindow)).toISOString() !== value.scheduledWindow
    || !sameJson(value.budgetOperations, BUDGET_OPERATIONS)
    || !sameJson(value.organizationOperations, ORGANIZATION_OPERATIONS)
    || value.hierarchyTagKey !== "cid:budget-level"
    || !sameJson(value.bounds, COLLECTION_BOUNDS)
    || value.maximumDurationMs !== AWS_BUDGETS_PROVIDER_BOUNDS.maximumDurationMs) {
    throw new AwsBudgetsProviderAdapterError("INVALID_REQUEST");
  }
  return { ...value, scope } as unknown as AwsBudgetsProviderRouteRequest;
}

function sameHeaders(request: AwsBudgetsProviderRouteRequest, headers: AwsBudgetsProviderRouteHeaders): boolean {
  return headers.tenantId === request.scope.orgId
    && headers.customerId === request.scope.customerId
    && headers.connectionId === request.scope.connectionId
    && headers.jobId === request.jobId;
}

export async function runAwsBudgetsProviderRoute(input: {
  readonly body: string;
  readonly headers: AwsBudgetsProviderRouteHeaders;
  readonly signal: AbortSignal;
}, dependencies: AwsBudgetsProviderRouteDependencies): Promise<{
  readonly schemaVersion: "sutra.aws-budgets-durable-response.v1";
  readonly requestId: string;
  readonly requestBodySha256: string;
  readonly capture: Awaited<ReturnType<typeof collectAwsBudgetsProviderEvidence>>["capture"];
  readonly hierarchy: Awaited<ReturnType<typeof collectAwsBudgetsProviderEvidence>>["hierarchy"];
}> {
  const request = parseAwsBudgetsProviderRouteRequest(input.body);
  if (!sameHeaders(request, input.headers) || input.signal.aborted) {
    throw new AwsBudgetsProviderAdapterError("INVALID_REQUEST");
  }
  const session = await dependencies.assumeReadOnlySession({
    tenantId: request.scope.orgId,
    customerId: request.scope.customerId,
    connectionId: request.scope.connectionId,
    jobId: request.jobId,
    expectedAccountId: request.scope.accountId,
    partition: request.scope.partition,
    sessionActions: AWS_BUDGETS_PROVIDER_SESSION_ACTIONS,
    signal: input.signal,
  });
  if (session.accountId !== request.scope.accountId || session.partition !== request.scope.partition) {
    throw new AwsBudgetsProviderAdapterError("INVALID_REQUEST");
  }
  const clients = (dependencies.clientFactory ?? createAwsBudgetsProviderClients)({
    partition: session.partition,
    credentials: session.credentials,
  });
  const evidence = await collectAwsBudgetsProviderEvidence({
    scope: request.scope,
    clients,
    signal: input.signal,
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  return Object.freeze({
    schemaVersion: "sutra.aws-budgets-durable-response.v1",
    requestId: request.requestId,
    requestBodySha256: createHash("sha256").update(input.body, "utf8").digest("hex"),
    capture: evidence.capture,
    hierarchy: evidence.hierarchy,
  });
}
