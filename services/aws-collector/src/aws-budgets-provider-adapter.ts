/**
 * Credential-owning, read-only AWS adapter for ADV-08.
 *
 * Only minimized provider evidence crosses this boundary. Subscriber addresses,
 * action role ARNs/policy IDs, credentials and raw AWS diagnostics are discarded.
 */
import { createHash } from "node:crypto";
import {
  BudgetsClient,
  DescribeBudgetActionsForBudgetCommand,
  DescribeBudgetPerformanceHistoryCommand,
  DescribeBudgetsCommand,
  DescribeNotificationsForBudgetCommand,
  DescribeSubscribersForNotificationCommand,
  ListTagsForResourceCommand,
  type Action,
  type Budget,
  type Notification,
  type Spend,
} from "@aws-sdk/client-budgets";
import {
  DescribeOrganizationCommand,
  ListAccountsCommand,
  ListOrganizationalUnitsForParentCommand,
  ListParentsCommand,
  ListRootsCommand,
  OrganizationsClient,
} from "@aws-sdk/client-organizations";
import type { AwsTemporaryCredentials } from "./types.js";

const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,256}$/u;
const BUDGET_NAME = /^(?!.*(?:<script>|<\/script>|\/action\/))[^:\\\0\r\n]{1,100}$/iu;
const TOKEN = /^[A-Za-z0-9+/=_.:-]{1,4096}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const MAXIMUM_CAPTURE_BYTES = 12 * 1_024 * 1_024;

export const AWS_BUDGETS_PROVIDER_BOUNDS = Object.freeze({
  apiPageSize: 100,
  maximumPages: 5_000,
  maximumBudgets: 1_000,
  maximumHistoryRecords: 20_000,
  maximumNotifications: 5_000,
  maximumSubscribers: 50_000,
  maximumActions: 10_000,
  maximumHierarchyAccounts: 10_000,
  maximumDurationMs: 5 * 60 * 1_000,
  maximumCaptureBytes: MAXIMUM_CAPTURE_BYTES,
});

export const AWS_BUDGETS_PROVIDER_SESSION_ACTIONS = Object.freeze([
  "sts:GetCallerIdentity",
  "aws-portal:ViewBilling",
  "billing:GetBillingViewData",
  "budgets:ViewBudget",
  "budgets:DescribeBudgetActionsForBudget",
  "organizations:DescribeOrganization",
  "organizations:ListAccounts",
  "organizations:ListRoots",
  "organizations:ListOrganizationalUnitsForParent",
  "organizations:ListParents",
] as const);

export type AwsBudgetsProviderPartition = "aws" | "aws-us-gov" | "aws-cn";

export interface AwsBudgetsProviderScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsBudgetsProviderPartition;
}

type Page<T> = {
  readonly request: { readonly accountId: string; readonly maxResults: 100; readonly nextToken: string | null };
  readonly response: { readonly records: readonly T[]; readonly nextToken: string | null };
};

type CoverageState = "SUCCEEDED" | "PARTIAL" | "ACCESS_DENIED" | "UNAVAILABLE";
type FailureCode = "ACCESS_DENIED" | "EXPIRED_TOKEN" | "THROTTLED" | "TIMEOUT" | "BOUND_REACHED" | "PROVIDER_UNAVAILABLE" | "UNKNOWN";

interface Coverage {
  readonly operation: string;
  state: CoverageState;
  recordCount: number;
  failureCode: FailureCode | null;
}

export interface AwsBudgetsProviderCapture {
  readonly schemaVersion: "sutra.aws-budgets-organization.v1";
  readonly scope: AwsBudgetsProviderScope;
  readonly captureId: string;
  readonly startedAtIso: string;
  readonly completedAtIso: string;
  readonly operationCoverage: readonly Coverage[];
  readonly budgetPages: readonly Page<unknown>[];
  readonly historySequences: readonly { readonly budgetName: string; readonly pages: readonly Page<unknown>[] }[];
  readonly notificationSequences: readonly { readonly budgetName: string; readonly pages: readonly Page<unknown>[] }[];
  readonly subscriberSequences: readonly { readonly budgetName: string; readonly notification: unknown; readonly pages: readonly Page<unknown>[] }[];
  readonly actionSequences: readonly { readonly budgetName: string; readonly pages: readonly Page<unknown>[] }[];
  readonly tagSequences: readonly { readonly budgetName: string; readonly pages: readonly Page<unknown>[] }[];
}

export interface AwsBudgetsProviderHierarchy {
  readonly scope: Pick<AwsBudgetsProviderScope, "orgId" | "customerId" | "connectionId">;
  readonly sourceEvidenceId: string;
  readonly observedAtIso: string;
  readonly state: "complete" | "partial" | "configuration_required" | "unavailable";
  readonly accounts: readonly {
    readonly accountId: string;
    readonly accountName: string;
    readonly parentId: string;
    readonly ouPath: readonly string[];
  }[];
}

export interface AwsBudgetsProviderClients {
  readonly budgets: BudgetsClient;
  readonly organizations: OrganizationsClient;
}

export class AwsBudgetsProviderAdapterError extends Error {
  public readonly code: "INVALID_REQUEST" | "PROVIDER_RESPONSE_INVALID" | "BOUND_REACHED" | "ABORTED";

  public constructor(code: AwsBudgetsProviderAdapterError["code"]) {
    super("AWS Budgets provider collection did not complete");
    this.name = "AwsBudgetsProviderAdapterError";
    this.code = code;
  }
}

function reject(code: AwsBudgetsProviderAdapterError["code"]): never {
  throw new AwsBudgetsProviderAdapterError(code);
}

function validScope(scope: AwsBudgetsProviderScope): boolean {
  return IDENTIFIER.test(scope.orgId) && IDENTIFIER.test(scope.customerId)
    && CONNECTION_ID.test(scope.connectionId) && ACCOUNT_ID.test(scope.accountId)
    && ["aws", "aws-us-gov", "aws-cn"].includes(scope.partition);
}

function text(value: unknown, maximum = 256): string {
  if (typeof value !== "string" || value.length > maximum || !SAFE_TEXT.test(value)) {
    return reject("PROVIDER_RESPONSE_INVALID");
  }
  return value;
}

function budgetName(value: unknown): string {
  if (typeof value !== "string" || !BUDGET_NAME.test(value)) {
    return reject("PROVIDER_RESPONSE_INVALID");
  }
  return value;
}

function token(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !TOKEN.test(value)) return reject("PROVIDER_RESPONSE_INVALID");
  return value;
}

function nextPageToken(value: unknown, requested: string | null, seen: Set<string>): string | null {
  const returned = token(value);
  if (returned !== null && (returned === requested || seen.has(returned))) {
    return reject("PROVIDER_RESPONSE_INVALID");
  }
  if (returned !== null) seen.add(returned);
  return returned;
}

function iso(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) {
    return reject("PROVIDER_RESPONSE_INVALID");
  }
  return value.toISOString();
}

function spend(value: Spend | undefined): { readonly amount: string; readonly unit: string } | null {
  if (value === undefined) return null;
  const amount = text(value.Amount, 32);
  if (!/^-?(?:0|[1-9]\d{0,23})(?:\.\d{1,6})?$/u.test(amount)) {
    return reject("PROVIDER_RESPONSE_INVALID");
  }
  return { amount, unit: text(value.Unit, 32) };
}

function finiteDecimal(value: unknown): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return reject("PROVIDER_RESPONSE_INVALID");
  const result = String(value);
  if (!/^-?(?:0|[1-9]\d{0,23})(?:\.\d{1,6})?$/u.test(result)) {
    return reject("PROVIDER_RESPONSE_INVALID");
  }
  return result;
}

function providerCostTypes(value: Budget["CostTypes"]): Record<string, boolean> {
  return {
    includeCredit: value?.IncludeCredit ?? true,
    includeDiscount: value?.IncludeDiscount ?? true,
    includeOtherSubscription: value?.IncludeOtherSubscription ?? true,
    includeRecurring: value?.IncludeRecurring ?? true,
    includeRefund: value?.IncludeRefund ?? true,
    includeSubscription: value?.IncludeSubscription ?? true,
    includeSupport: value?.IncludeSupport ?? true,
    includeTax: value?.IncludeTax ?? true,
    includeUpfront: value?.IncludeUpfront ?? true,
    useAmortized: value?.UseAmortized ?? false,
    useBlended: value?.UseBlended ?? false,
  };
}

function providerBudget(value: Budget): Record<string, unknown> {
  const name = budgetName(value.BudgetName);
  if (!value.TimePeriod?.Start || !value.TimePeriod.End || !value.BudgetType || !value.TimeUnit) {
    return reject("PROVIDER_RESPONSE_INVALID");
  }
  const planned: Record<string, ReturnType<typeof spend>> = {};
  for (const [epochSeconds, amount] of Object.entries(value.PlannedBudgetLimits ?? {})) {
    if (!/^(?:0|[1-9]\d{0,11})$/u.test(epochSeconds)) return reject("PROVIDER_RESPONSE_INVALID");
    const at = new Date(Number(epochSeconds) * 1_000);
    if (!Number.isFinite(at.getTime())) return reject("PROVIDER_RESPONSE_INVALID");
    planned[at.toISOString()] = spend(amount);
  }
  const costFilters: Record<string, readonly string[]> = {};
  for (const [key, raw] of Object.entries(value.CostFilters ?? {})) {
    text(key, 128);
    if (!Array.isArray(raw) || raw.length > 100) return reject("BOUND_REACHED");
    costFilters[key] = [...new Set(raw.map((item) => text(item, 256)))].sort();
  }
  return {
    budgetName: name,
    budgetType: value.BudgetType,
    timeUnit: value.TimeUnit,
    timePeriod: { start: iso(value.TimePeriod.Start), end: iso(value.TimePeriod.End) },
    budgetLimit: spend(value.BudgetLimit),
    plannedBudgetLimits: planned,
    calculatedSpend: {
      actualSpend: spend(value.CalculatedSpend?.ActualSpend),
      forecastedSpend: spend(value.CalculatedSpend?.ForecastedSpend),
    },
    costFilters,
    costTypes: providerCostTypes(value.CostTypes),
    metrics: [...new Set((value.Metrics ?? []).map((item) => text(item, 64)))].sort(),
    lastUpdatedAt: value.LastUpdatedTime === undefined ? null : iso(value.LastUpdatedTime),
  };
}

function providerNotification(value: Notification): Record<string, unknown> {
  if (!value.ComparisonOperator || !value.NotificationType || value.Threshold === undefined) {
    return reject("PROVIDER_RESPONSE_INVALID");
  }
  return {
    comparisonOperator: value.ComparisonOperator,
    notificationType: value.NotificationType,
    threshold: finiteDecimal(value.Threshold),
    thresholdType: value.ThresholdType ?? "PERCENTAGE",
  };
}

function providerAction(value: Action): Record<string, unknown> {
  if (!value.ActionId || !value.ActionType || !value.ApprovalModel || !value.NotificationType
    || !value.Status || value.ActionThreshold?.ActionThresholdValue === undefined
    || !value.ActionThreshold.ActionThresholdType) return reject("PROVIDER_RESPONSE_INVALID");
  const targetedResourceCount = value.ActionType === "APPLY_IAM_POLICY"
    ? (value.Definition?.IamActionDefinition?.Roles?.length ?? 0)
      + (value.Definition?.IamActionDefinition?.Groups?.length ?? 0)
      + (value.Definition?.IamActionDefinition?.Users?.length ?? 0)
    : value.ActionType === "APPLY_SCP_POLICY"
      ? value.Definition?.ScpActionDefinition?.TargetIds?.length ?? 0
      : value.Definition?.SsmActionDefinition?.InstanceIds?.length ?? 0;
  return {
    actionId: text(value.ActionId, 255),
    actionType: value.ActionType,
    approvalModel: value.ApprovalModel,
    notificationType: value.NotificationType,
    status: value.Status,
    threshold: finiteDecimal(value.ActionThreshold.ActionThresholdValue),
    thresholdType: value.ActionThreshold.ActionThresholdType,
    executionRolePresent: typeof value.ExecutionRoleArn === "string" && value.ExecutionRoleArn.length > 0,
    targetedResourceCount,
  };
}

function errorName(error: unknown): string {
  return typeof error === "object" && error !== null && "name" in error
    ? String((error as { readonly name: unknown }).name) : "";
}

function failure(error: unknown, signal: AbortSignal): FailureCode {
  if (signal.aborted) return "TIMEOUT";
  const name = errorName(error);
  if (/accessdenied|unauthorized|notauthorized/iu.test(name)) return "ACCESS_DENIED";
  if (/expiredtoken|invalidclienttoken/iu.test(name)) return "EXPIRED_TOKEN";
  if (/throttl|requestlimit|toomanyrequest/iu.test(name)) return "THROTTLED";
  if (/timeout|abort/iu.test(name)) return "TIMEOUT";
  if (/serviceunavailable|internalerror|network|socket/iu.test(name)) return "PROVIDER_UNAVAILABLE";
  if (error instanceof AwsBudgetsProviderAdapterError && error.code === "BOUND_REACHED") return "BOUND_REACHED";
  return "UNKNOWN";
}

function coverageState(code: FailureCode, accepted: number): CoverageState {
  if (code === "ACCESS_DENIED") return "ACCESS_DENIED";
  return accepted > 0 ? "PARTIAL" : "UNAVAILABLE";
}

function markFailure(item: Coverage, error: unknown, signal: AbortSignal): void {
  const code = failure(error, signal);
  item.state = coverageState(code, item.recordCount);
  item.failureCode = code;
}

function assertBudget(scope: AwsBudgetsProviderScope, count: number, pages: number, signal: AbortSignal): void {
  if (signal.aborted) return reject("ABORTED");
  if (count > AWS_BUDGETS_PROVIDER_BOUNDS.maximumBudgets
    || pages > AWS_BUDGETS_PROVIDER_BOUNDS.maximumPages) return reject("BOUND_REACHED");
  if (!validScope(scope)) return reject("INVALID_REQUEST");
}

function pageRequest(accountId: string, nextToken: string | null) {
  return { accountId, maxResults: 100 as const, nextToken };
}

function budgetControlRegion(partition: AwsBudgetsProviderPartition): string {
  if (partition === "aws-us-gov") return "us-gov-west-1";
  if (partition === "aws-cn") return "cn-northwest-1";
  return "us-east-1";
}

export function createAwsBudgetsProviderClients(input: {
  readonly partition: AwsBudgetsProviderPartition;
  readonly credentials: AwsTemporaryCredentials;
}): AwsBudgetsProviderClients {
  const region = budgetControlRegion(input.partition);
  const configuration = {
    region,
    retryMode: "standard" as const,
    maxAttempts: 4,
    requestHandler: { connectionTimeout: 5_000, requestTimeout: 10_000 },
    credentials: input.credentials,
  };
  return {
    budgets: new BudgetsClient(configuration),
    organizations: new OrganizationsClient(configuration),
  };
}

async function collectBudgets(input: {
  readonly scope: AwsBudgetsProviderScope;
  readonly client: BudgetsClient;
  readonly signal: AbortSignal;
}): Promise<Omit<AwsBudgetsProviderCapture, "schemaVersion" | "scope" | "captureId" | "startedAtIso" | "completedAtIso">> {
  const operations = [
    "DescribeBudgets", "DescribeBudgetPerformanceHistory", "DescribeNotificationsForBudget",
    "DescribeSubscribersForNotification", "DescribeBudgetActionsForBudget", "ListTagsForResource",
  ].map((operation): Coverage => ({ operation, state: "SUCCEEDED", recordCount: 0, failureCode: null }));
  const byOperation = new Map(operations.map((item) => [item.operation, item] as const));
  const budgetPages: Page<unknown>[] = [];
  const budgets: { readonly name: string; readonly raw: Budget }[] = [];
  let nextToken: string | null = null;
  const seenTokens = new Set<string>();
  try {
    do {
      assertBudget(input.scope, budgets.length, budgetPages.length, input.signal);
      const output = await input.client.send(new DescribeBudgetsCommand({
        AccountId: input.scope.accountId,
        MaxResults: 100,
        ...(nextToken === null ? {} : { NextToken: nextToken }),
      }), { abortSignal: input.signal });
      const records = (output.Budgets ?? []).map((raw) => {
        const normalized = providerBudget(raw);
        return { raw, name: normalized.budgetName as string, normalized };
      });
      const returned = nextPageToken(output.NextToken, nextToken, seenTokens);
      const pageNames = new Set<string>();
      for (const item of records) {
        if (pageNames.has(item.name) || budgets.some((existing) => existing.name === item.name)) {
          reject("PROVIDER_RESPONSE_INVALID");
        }
        pageNames.add(item.name);
      }
      budgetPages.push({
        request: pageRequest(input.scope.accountId, nextToken),
        response: { records: records.map((item) => item.normalized), nextToken: returned },
      });
      for (const item of records) {
        budgets.push({ name: item.name, raw: item.raw });
      }
      byOperation.get("DescribeBudgets")!.recordCount = budgets.length;
      nextToken = returned;
    } while (nextToken !== null);
  } catch (error) {
    markFailure(byOperation.get("DescribeBudgets")!, error, input.signal);
  }
  if (byOperation.get("DescribeBudgets")!.state === "ACCESS_DENIED"
    || byOperation.get("DescribeBudgets")!.state === "UNAVAILABLE") {
    for (const operation of operations.slice(1)) {
      operation.state = byOperation.get("DescribeBudgets")!.state;
      operation.failureCode = byOperation.get("DescribeBudgets")!.failureCode;
    }
    return { operationCoverage: operations, budgetPages, historySequences: [], notificationSequences: [], subscriberSequences: [], actionSequences: [], tagSequences: [] };
  }

  const historySequences: { budgetName: string; pages: Page<unknown>[] }[] = [];
  const notificationSequences: { budgetName: string; pages: Page<unknown>[] }[] = [];
  const subscriberSequences: { budgetName: string; notification: unknown; pages: Page<unknown>[] }[] = [];
  const actionSequences: { budgetName: string; pages: Page<unknown>[] }[] = [];
  const tagSequences: { budgetName: string; pages: Page<unknown>[] }[] = [];
  let totalPages = budgetPages.length;

  for (const budget of budgets) {
    const historyPages: Page<unknown>[] = [];
    nextToken = null;
    let sequenceTokens = new Set<string>();
    if (budget.raw.TimeUnit !== "ANNUALLY" && budget.raw.TimeUnit !== "CUSTOM") {
      try {
        do {
          assertBudget(input.scope, budgets.length, ++totalPages, input.signal);
          const output = await input.client.send(new DescribeBudgetPerformanceHistoryCommand({
            AccountId: input.scope.accountId, BudgetName: budget.name, MaxResults: 100,
            ...(nextToken === null ? {} : { NextToken: nextToken }),
          }), { abortSignal: input.signal });
          const records = (output.BudgetPerformanceHistory?.BudgetedAndActualAmountsList ?? []).map((item) => {
            if (!item.TimePeriod?.Start || !item.TimePeriod.End || !item.BudgetedAmount) {
              return reject("PROVIDER_RESPONSE_INVALID");
            }
            return {
              timePeriod: { start: iso(item.TimePeriod.Start), end: iso(item.TimePeriod.End) },
              budgetedAmount: spend(item.BudgetedAmount),
              actualAmount: spend(item.ActualAmount),
              forecastedAmount: null,
            };
          });
          const returned = nextPageToken(output.NextToken, nextToken, sequenceTokens);
          historyPages.push({ request: pageRequest(input.scope.accountId, nextToken), response: { records, nextToken: returned } });
          byOperation.get("DescribeBudgetPerformanceHistory")!.recordCount += records.length;
          if (byOperation.get("DescribeBudgetPerformanceHistory")!.recordCount
            > AWS_BUDGETS_PROVIDER_BOUNDS.maximumHistoryRecords) reject("BOUND_REACHED");
          nextToken = returned;
        } while (nextToken !== null);
      } catch (error) { markFailure(byOperation.get("DescribeBudgetPerformanceHistory")!, error, input.signal); }
    }
    historySequences.push({ budgetName: budget.name, pages: historyPages });

    const notificationPages: Page<unknown>[] = [];
    const notifications: { raw: Notification; normalized: unknown }[] = [];
    nextToken = null;
    sequenceTokens = new Set<string>();
    try {
      do {
        assertBudget(input.scope, budgets.length, ++totalPages, input.signal);
        const output = await input.client.send(new DescribeNotificationsForBudgetCommand({
          AccountId: input.scope.accountId, BudgetName: budget.name, MaxResults: 100,
          ...(nextToken === null ? {} : { NextToken: nextToken }),
        }), { abortSignal: input.signal });
        const records = (output.Notifications ?? []).map((raw) => ({ raw, normalized: providerNotification(raw) }));
        const returned = nextPageToken(output.NextToken, nextToken, sequenceTokens);
        notificationPages.push({ request: pageRequest(input.scope.accountId, nextToken), response: { records: records.map((item) => item.normalized), nextToken: returned } });
        notifications.push(...records);
        byOperation.get("DescribeNotificationsForBudget")!.recordCount += records.length;
        if (byOperation.get("DescribeNotificationsForBudget")!.recordCount > AWS_BUDGETS_PROVIDER_BOUNDS.maximumNotifications) reject("BOUND_REACHED");
        nextToken = returned;
      } while (nextToken !== null);
    } catch (error) { markFailure(byOperation.get("DescribeNotificationsForBudget")!, error, input.signal); }
    notificationSequences.push({ budgetName: budget.name, pages: notificationPages });

    for (const notification of notifications) {
      const pages: Page<unknown>[] = [];
      nextToken = null;
      sequenceTokens = new Set<string>();
      try {
        do {
          assertBudget(input.scope, budgets.length, ++totalPages, input.signal);
          const output = await input.client.send(new DescribeSubscribersForNotificationCommand({
            AccountId: input.scope.accountId, BudgetName: budget.name,
            Notification: notification.raw, MaxResults: 100,
            ...(nextToken === null ? {} : { NextToken: nextToken }),
          }), { abortSignal: input.signal });
          const records = (output.Subscribers ?? []).map((item) => {
            if (item.SubscriptionType !== "EMAIL" && item.SubscriptionType !== "SNS") {
              return reject("PROVIDER_RESPONSE_INVALID");
            }
            return { subscriptionType: item.SubscriptionType };
          });
          const returned = nextPageToken(output.NextToken, nextToken, sequenceTokens);
          pages.push({ request: pageRequest(input.scope.accountId, nextToken), response: { records, nextToken: returned } });
          byOperation.get("DescribeSubscribersForNotification")!.recordCount += records.length;
          if (byOperation.get("DescribeSubscribersForNotification")!.recordCount > AWS_BUDGETS_PROVIDER_BOUNDS.maximumSubscribers) reject("BOUND_REACHED");
          nextToken = returned;
        } while (nextToken !== null);
      } catch (error) { markFailure(byOperation.get("DescribeSubscribersForNotification")!, error, input.signal); }
      subscriberSequences.push({ budgetName: budget.name, notification: notification.normalized, pages });
    }

    const actionPages: Page<unknown>[] = [];
    nextToken = null;
    sequenceTokens = new Set<string>();
    try {
      do {
        assertBudget(input.scope, budgets.length, ++totalPages, input.signal);
        const output = await input.client.send(new DescribeBudgetActionsForBudgetCommand({
          AccountId: input.scope.accountId, BudgetName: budget.name, MaxResults: 100,
          ...(nextToken === null ? {} : { NextToken: nextToken }),
        }), { abortSignal: input.signal });
        const records = (output.Actions ?? []).map(providerAction);
        const returned = nextPageToken(output.NextToken, nextToken, sequenceTokens);
        actionPages.push({ request: pageRequest(input.scope.accountId, nextToken), response: { records, nextToken: returned } });
        byOperation.get("DescribeBudgetActionsForBudget")!.recordCount += records.length;
        if (byOperation.get("DescribeBudgetActionsForBudget")!.recordCount > AWS_BUDGETS_PROVIDER_BOUNDS.maximumActions) reject("BOUND_REACHED");
        nextToken = returned;
      } while (nextToken !== null);
    } catch (error) { markFailure(byOperation.get("DescribeBudgetActionsForBudget")!, error, input.signal); }
    actionSequences.push({ budgetName: budget.name, pages: actionPages });

    const tagPages: Page<unknown>[] = [];
    try {
      assertBudget(input.scope, budgets.length, ++totalPages, input.signal);
      const resourceArn = `arn:${input.scope.partition}:budgets::${input.scope.accountId}:budget/${budget.name}`;
      const output = await input.client.send(new ListTagsForResourceCommand({ ResourceARN: resourceArn }), { abortSignal: input.signal });
      const records = (output.ResourceTags ?? [])
        .filter((item) => item.Key === "cid:budget-level")
        .map((item) => ({ key: "cid:budget-level", value: text(item.Value, 128) }));
      if (records.length > 1) reject("PROVIDER_RESPONSE_INVALID");
      tagPages.push({ request: pageRequest(input.scope.accountId, null), response: { records, nextToken: null } });
      byOperation.get("ListTagsForResource")!.recordCount += records.length;
    } catch (error) { markFailure(byOperation.get("ListTagsForResource")!, error, input.signal); }
    tagSequences.push({ budgetName: budget.name, pages: tagPages });
  }
  return { operationCoverage: operations, budgetPages, historySequences, notificationSequences, subscriberSequences, actionSequences, tagSequences };
}

async function collectHierarchy(input: {
  readonly scope: AwsBudgetsProviderScope;
  readonly client: OrganizationsClient;
  readonly signal: AbortSignal;
  readonly observedAtIso: string;
}): Promise<AwsBudgetsProviderHierarchy> {
  const basicScope = { orgId: input.scope.orgId, customerId: input.scope.customerId, connectionId: input.scope.connectionId };
  const accounts: { accountId: string; accountName: string; parentId: string; ouPath: readonly string[] }[] = [];
  let state: AwsBudgetsProviderHierarchy["state"] = "complete";
  try {
    const organization = await input.client.send(new DescribeOrganizationCommand({}), { abortSignal: input.signal });
    if (!organization.Organization?.Id || !/^o-[a-z0-9]{10,32}$/u.test(organization.Organization.Id)) reject("PROVIDER_RESPONSE_INVALID");
    let organizationPages = 0;
    const rootIds: string[] = [];
    let rootToken: string | null = null;
    const rootTokens = new Set<string>();
    do {
      if (++organizationPages > AWS_BUDGETS_PROVIDER_BOUNDS.maximumPages) reject("BOUND_REACHED");
      const roots = await input.client.send(new ListRootsCommand({
        ...(rootToken === null ? {} : { NextToken: rootToken }),
      }), { abortSignal: input.signal });
      for (const root of roots.Roots ?? []) {
        if (!root.Id || rootIds.includes(root.Id)) reject("PROVIDER_RESPONSE_INVALID");
        rootIds.push(root.Id);
      }
      rootToken = nextPageToken(roots.NextToken, rootToken, rootTokens);
    } while (rootToken !== null);
    if (rootIds.length !== 1) reject("PROVIDER_RESPONSE_INVALID");
    const rootId = rootIds[0]!;
    const ouNames = new Map<string, string>();
    const ouPaths = new Map<string, readonly string[]>();
    const queue: { id: string; path: readonly string[] }[] = [{ id: rootId, path: [] }];
    while (queue.length > 0) {
      const parent = queue.shift()!;
      let nextToken: string | undefined;
      const seen = new Set<string>();
      do {
        if (++organizationPages > AWS_BUDGETS_PROVIDER_BOUNDS.maximumPages) reject("BOUND_REACHED");
        const output = await input.client.send(new ListOrganizationalUnitsForParentCommand({
          ParentId: parent.id, ...(nextToken === undefined ? {} : { NextToken: nextToken }),
        }), { abortSignal: input.signal });
        for (const unit of output.OrganizationalUnits ?? []) {
          if (!unit.Id || !/^ou-[a-z0-9]{4,32}-[a-z0-9]{8,32}$/u.test(unit.Id) || ouNames.has(unit.Id)) {
            reject("PROVIDER_RESPONSE_INVALID");
          }
          const name = text(unit.Name, 128);
          const path = [...parent.path, name];
          ouNames.set(unit.Id, name); ouPaths.set(unit.Id, path); queue.push({ id: unit.Id, path });
        }
        nextToken = nextPageToken(output.NextToken, nextToken ?? null, seen) ?? undefined;
      } while (nextToken !== undefined);
    }
    const listed: { id: string; name: string }[] = [];
    let accountToken: string | undefined;
    const accountTokens = new Set<string>();
    do {
      if (++organizationPages > AWS_BUDGETS_PROVIDER_BOUNDS.maximumPages) reject("BOUND_REACHED");
      const output = await input.client.send(new ListAccountsCommand({
        ...(accountToken === undefined ? {} : { NextToken: accountToken }),
      }), { abortSignal: input.signal });
      for (const account of output.Accounts ?? []) {
        if (!account.Id || !ACCOUNT_ID.test(account.Id) || listed.some((item) => item.id === account.Id)) reject("PROVIDER_RESPONSE_INVALID");
        listed.push({ id: account.Id, name: text(account.Name, 128) });
      }
      if (listed.length > AWS_BUDGETS_PROVIDER_BOUNDS.maximumHierarchyAccounts) reject("BOUND_REACHED");
      accountToken = nextPageToken(output.NextToken, accountToken ?? null, accountTokens) ?? undefined;
    } while (accountToken !== undefined);
    for (const account of listed) {
      const parentIds: string[] = [];
      let parentToken: string | null = null;
      const parentTokens = new Set<string>();
      do {
        if (++organizationPages > AWS_BUDGETS_PROVIDER_BOUNDS.maximumPages) reject("BOUND_REACHED");
        const output = await input.client.send(new ListParentsCommand({
          ChildId: account.id,
          ...(parentToken === null ? {} : { NextToken: parentToken }),
        }), { abortSignal: input.signal });
        for (const parent of output.Parents ?? []) {
          if (!parent.Id || parentIds.includes(parent.Id)) reject("PROVIDER_RESPONSE_INVALID");
          parentIds.push(parent.Id);
        }
        parentToken = nextPageToken(output.NextToken, parentToken, parentTokens);
      } while (parentToken !== null);
      if (parentIds.length !== 1) reject("PROVIDER_RESPONSE_INVALID");
      const parentId = parentIds[0]!;
      if (parentId !== rootId && !ouPaths.has(parentId)) reject("PROVIDER_RESPONSE_INVALID");
      accounts.push({ accountId: account.id, accountName: account.name, parentId, ouPath: ouPaths.get(parentId) ?? [] });
    }
  } catch (error) {
    const code = failure(error, input.signal);
    if (code === "ACCESS_DENIED") state = "configuration_required";
    else if (accounts.length > 0) state = "partial";
    else state = "unavailable";
    if (input.signal.aborted) state = "unavailable";
    if (state !== "partial") accounts.length = 0;
  }
  const evidenceBody = JSON.stringify({ schemaVersion: "sutra.aws-budgets-hierarchy.v1", scope: basicScope, observedAtIso: input.observedAtIso, state, accounts });
  return {
    scope: basicScope,
    sourceEvidenceId: `awshierarchy_${createHash("sha256").update(evidenceBody).digest("hex")}`,
    observedAtIso: input.observedAtIso,
    state,
    accounts: accounts.sort((left, right) => left.accountId.localeCompare(right.accountId)),
  };
}

export async function collectAwsBudgetsProviderEvidence(input: {
  readonly scope: AwsBudgetsProviderScope;
  readonly clients: AwsBudgetsProviderClients;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}): Promise<{ readonly capture: AwsBudgetsProviderCapture; readonly hierarchy: AwsBudgetsProviderHierarchy }> {
  if (!validScope(input.scope)) reject("INVALID_REQUEST");
  const now = input.now ?? Date.now;
  const startedAt = now();
  if (!Number.isSafeInteger(startedAt) || startedAt < 0) reject("INVALID_REQUEST");
  const timeout = AbortSignal.timeout(AWS_BUDGETS_PROVIDER_BOUNDS.maximumDurationMs);
  const signal = input.signal === undefined ? timeout : AbortSignal.any([input.signal, timeout]);
  const budgets = await collectBudgets({ scope: input.scope, client: input.clients.budgets, signal });
  const completedAt = now();
  if (!Number.isSafeInteger(completedAt) || completedAt < startedAt
    || completedAt - startedAt > AWS_BUDGETS_PROVIDER_BOUNDS.maximumDurationMs) reject("ABORTED");
  const completedAtIso = new Date(completedAt).toISOString();
  const withoutId = {
    schemaVersion: "sutra.aws-budgets-organization.v1" as const,
    scope: Object.freeze({ ...input.scope }),
    startedAtIso: new Date(startedAt).toISOString(),
    completedAtIso,
    ...budgets,
  };
  const captureId = `awsbudgets_${createHash("sha256").update(JSON.stringify(withoutId)).digest("hex")}`;
  const capture = Object.freeze({ ...withoutId, captureId });
  if (Buffer.byteLength(JSON.stringify(capture), "utf8") > MAXIMUM_CAPTURE_BYTES) reject("BOUND_REACHED");
  const hierarchy = await collectHierarchy({
    scope: input.scope, client: input.clients.organizations, signal, observedAtIso: completedAtIso,
  });
  return { capture, hierarchy };
}
