/**
 * Pure trust-boundary and organization projection for authoritative AWS
 * Budgets evidence. The credential-owning collector is intentionally outside
 * this module. It must return a tenant-pinned, bounded capture through the
 * authenticated broker; this file accepts no credentials and keeps no cache.
 */
import type {
  FinopsOrganizationTaxonomy,
  FinopsTaxonomyAssignment,
} from "./finops-cost-intelligence.ts";
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const CAPTURE_ID = /^awsbudgets_[a-f0-9]{64}$/u;
const SAFE_TOKEN = /^[A-Za-z0-9+/=_.:-]{1,4096}$/u;
const SAFE_TEXT = /^[^\0\r\n]{1,256}$/u;
const BUDGET_NAME = /^(?!.*(?:<script>|<\/script>|\/action\/))[^:\\\0\r\n]{1,100}$/iu;
const DECIMAL = /^-?(?:0|[1-9]\d{0,23})(?:\.\d{1,6})?$/u;
const CURRENCY = /^[A-Z]{3}$/u;

export const AWS_BUDGETS_COLLECTION_BOUNDS = Object.freeze({
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
} as const);

/** API calls. Most are authorized by budgets:ViewBudget, not same-name IAM actions. */
export const AWS_BUDGETS_READ_API_OPERATIONS = Object.freeze([
  "DescribeBudgets",
  "DescribeBudgetPerformanceHistory",
  "DescribeNotificationsForBudget",
  "DescribeSubscribersForNotification",
  "DescribeBudgetActionsForBudget",
  "ListTagsForResource",
] as const);

/** Current IAM actions required by the capture contract. */
export const AWS_BUDGETS_READ_IAM_ACTIONS = Object.freeze([
  "aws-portal:ViewBilling",
  "budgets:ViewBudget",
  "budgets:DescribeBudgetActionsForBudget",
] as const);

/** Current service-authorization dependency for billing-view backed reads. */
export const AWS_BUDGETS_DEPENDENT_IAM_ACTIONS = Object.freeze([
  "billing:GetBillingViewData",
] as const);

/** Required only when AWS Organizations is the hierarchy evidence source. */
export const AWS_BUDGETS_ORGANIZATION_READ_IAM_ACTIONS = Object.freeze([
  "organizations:DescribeOrganization",
  "organizations:ListAccounts",
  "organizations:ListRoots",
  "organizations:ListOrganizationalUnitsForParent",
  "organizations:ListParents",
] as const);

export type AwsBudgetOperation =
  typeof AWS_BUDGETS_READ_API_OPERATIONS[number];
export type AwsBudgetOperationState =
  | "SUCCEEDED"
  | "PARTIAL"
  | "ACCESS_DENIED"
  | "UNAVAILABLE";
export type AwsBudgetFailureCode =
  | "ACCESS_DENIED"
  | "EXPIRED_TOKEN"
  | "THROTTLED"
  | "TIMEOUT"
  | "BOUND_REACHED"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";
export type AwsBudgetType =
  | "COST"
  | "USAGE"
  | "RI_UTILIZATION"
  | "RI_COVERAGE"
  | "SAVINGS_PLANS_UTILIZATION"
  | "SAVINGS_PLANS_COVERAGE";
export type AwsBudgetTimeUnit =
  | "DAILY"
  | "MONTHLY"
  | "QUARTERLY"
  | "ANNUALLY"
  | "CUSTOM";

export interface AwsBudgetsScope extends FinopsSourceScope {
  readonly accountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
}

export interface AwsBudgetOperationCoverage {
  readonly operation: AwsBudgetOperation;
  readonly state: AwsBudgetOperationState;
  readonly recordCount: number;
  readonly failureCode: AwsBudgetFailureCode | null;
}

export interface AwsBudgetSpend {
  readonly amount: string;
  readonly unit: string;
}

export interface AwsBudgetCostTypes {
  readonly includeCredit: boolean;
  readonly includeDiscount: boolean;
  readonly includeOtherSubscription: boolean;
  readonly includeRecurring: boolean;
  readonly includeRefund: boolean;
  readonly includeSubscription: boolean;
  readonly includeSupport: boolean;
  readonly includeTax: boolean;
  readonly includeUpfront: boolean;
  readonly useAmortized: boolean;
  readonly useBlended: boolean;
}

export interface AwsBudgetDefinitionRecord {
  readonly budgetName: string;
  readonly budgetType: AwsBudgetType;
  readonly timeUnit: AwsBudgetTimeUnit;
  readonly timePeriod: { readonly start: string; readonly end: string };
  readonly budgetLimit: AwsBudgetSpend | null;
  readonly plannedBudgetLimits: Readonly<Record<string, AwsBudgetSpend>>;
  readonly calculatedSpend: {
    readonly actualSpend: AwsBudgetSpend | null;
    readonly forecastedSpend: AwsBudgetSpend | null;
  };
  readonly costFilters: Readonly<Record<string, readonly string[]>>;
  readonly costTypes: AwsBudgetCostTypes;
  readonly metrics: readonly string[];
  readonly lastUpdatedAt: string | null;
}

export interface AwsBudgetHistoryRecord {
  readonly timePeriod: { readonly start: string; readonly end: string };
  readonly budgetedAmount: AwsBudgetSpend;
  readonly actualAmount: AwsBudgetSpend | null;
  readonly forecastedAmount: AwsBudgetSpend | null;
}

export interface AwsBudgetNotificationRecord {
  readonly comparisonOperator: "GREATER_THAN" | "LESS_THAN" | "EQUAL_TO";
  readonly notificationType: "ACTUAL" | "FORECASTED";
  readonly threshold: string;
  readonly thresholdType: "PERCENTAGE" | "ABSOLUTE_VALUE";
}

export interface AwsBudgetSubscriberRecord {
  /** Addresses/ARNs never cross the broker boundary. */
  readonly subscriptionType: "EMAIL" | "SNS";
}

/** Minimized provider tag projection used by the CID budget hierarchy. */
export interface AwsBudgetLevelTagRecord {
  readonly key: "cid:budget-level";
  readonly value: string;
}

export interface AwsBudgetActionRecord {
  readonly actionId: string;
  readonly actionType: "APPLY_IAM_POLICY" | "APPLY_SCP_POLICY" | "RUN_SSM_DOCUMENTS";
  readonly approvalModel: "AUTOMATIC" | "MANUAL";
  readonly notificationType: "ACTUAL" | "FORECASTED";
  readonly status:
    | "STANDBY"
    | "PENDING"
    | "EXECUTION_IN_PROGRESS"
    | "EXECUTION_SUCCESS"
    | "EXECUTION_FAILURE"
    | "REVERSE_IN_PROGRESS"
    | "REVERSE_SUCCESS"
    | "REVERSE_FAILURE"
    | "RESET_IN_PROGRESS"
    | "RESET_FAILURE";
  readonly threshold: string;
  readonly thresholdType: "PERCENTAGE" | "ABSOLUTE_VALUE";
  readonly executionRolePresent: boolean;
  readonly targetedResourceCount: number;
}

interface AwsBudgetPageRequest {
  readonly accountId: string;
  readonly maxResults: 100;
  readonly nextToken: string | null;
}

export interface AwsBudgetPage<T> {
  readonly request: AwsBudgetPageRequest;
  readonly response: {
    readonly records: readonly T[];
    readonly nextToken: string | null;
  };
}

export interface AwsBudgetNamedSequence<T> {
  readonly budgetName: string;
  readonly pages: readonly AwsBudgetPage<T>[];
}

export interface AwsBudgetSubscriberSequence {
  readonly budgetName: string;
  readonly notification: AwsBudgetNotificationRecord;
  readonly pages: readonly AwsBudgetPage<AwsBudgetSubscriberRecord>[];
}

export interface AwsBudgetsCapture {
  readonly schemaVersion: "sutra.aws-budgets-organization.v1";
  readonly scope: AwsBudgetsScope;
  readonly captureId: string;
  readonly startedAtIso: string;
  readonly completedAtIso: string;
  readonly operationCoverage: readonly AwsBudgetOperationCoverage[];
  readonly budgetPages: readonly AwsBudgetPage<AwsBudgetDefinitionRecord>[];
  readonly historySequences: readonly AwsBudgetNamedSequence<AwsBudgetHistoryRecord>[];
  readonly notificationSequences: readonly AwsBudgetNamedSequence<AwsBudgetNotificationRecord>[];
  readonly subscriberSequences: readonly AwsBudgetSubscriberSequence[];
  readonly actionSequences: readonly AwsBudgetNamedSequence<AwsBudgetActionRecord>[];
  readonly tagSequences: readonly AwsBudgetNamedSequence<AwsBudgetLevelTagRecord>[];
}

export interface NormalizedAwsBudgetMoney {
  readonly amount: string;
  readonly amountMicros: string;
  readonly unit: string;
  readonly currency: string | null;
}

export interface NormalizedAwsBudgetHistory {
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly budgeted: NormalizedAwsBudgetMoney;
  readonly actual: NormalizedAwsBudgetMoney | null;
  readonly forecast: NormalizedAwsBudgetMoney | null;
}

export interface NormalizedAwsBudgetNotification {
  readonly comparisonOperator: AwsBudgetNotificationRecord["comparisonOperator"];
  readonly notificationType: AwsBudgetNotificationRecord["notificationType"];
  readonly threshold: string;
  readonly thresholdType: AwsBudgetNotificationRecord["thresholdType"];
  readonly subscriberCount: number | null;
  readonly subscriberTypes: readonly AwsBudgetSubscriberRecord["subscriptionType"][];
  readonly subscriberCoverage: "complete" | "partial" | "configuration_required";
}

export type NormalizedAwsBudgetAction = AwsBudgetActionRecord;

export interface NormalizedAwsBudget {
  readonly source: "AWS_BUDGETS";
  readonly accountId: string;
  readonly budgetName: string;
  readonly budgetType: AwsBudgetType;
  readonly timeUnit: AwsBudgetTimeUnit;
  readonly effectivePeriod: { readonly start: string; readonly end: string };
  readonly budgetLimit: NormalizedAwsBudgetMoney | null;
  readonly plannedBudgetLimits: readonly {
    readonly effectiveAt: string;
    readonly amount: NormalizedAwsBudgetMoney;
  }[];
  readonly actual: NormalizedAwsBudgetMoney | null;
  readonly forecast: NormalizedAwsBudgetMoney | null;
  readonly costFilters: readonly { readonly key: string; readonly values: readonly string[] }[];
  readonly costTypes: AwsBudgetCostTypes;
  readonly metrics: readonly string[];
  readonly lastUpdatedAt: string | null;
  readonly history: readonly NormalizedAwsBudgetHistory[];
  readonly notifications: readonly NormalizedAwsBudgetNotification[];
  readonly actions: readonly NormalizedAwsBudgetAction[];
  /** Exact value of the provider-side cid:budget-level tag, never inferred. */
  readonly hierarchyLevel: string | null;
  readonly coverage: {
    readonly history: "complete" | "partial" | "not_applicable" | "configuration_required";
    readonly notifications: "complete" | "partial" | "configuration_required";
    readonly subscribers: "complete" | "partial" | "configuration_required";
    readonly actions: "complete" | "partial" | "configuration_required";
    readonly hierarchyTag: "complete" | "partial" | "configuration_required";
    readonly actual: "available" | "unavailable";
    readonly forecast: "available" | "unavailable";
  };
}

export interface AwsBudgetsSnapshot {
  readonly schemaVersion: "sutra.aws-budgets-organization.v1";
  readonly scope: AwsBudgetsScope;
  readonly captureId: string;
  readonly observedAtIso: string;
  readonly dataThroughAt: string | null;
  readonly collectionState: "ready" | "partial" | "configuration_required" | "unavailable";
  readonly operationCoverage: readonly AwsBudgetOperationCoverage[];
  readonly budgets: readonly NormalizedAwsBudget[];
  readonly freshness: {
    readonly status: "fresh" | "stale" | "unknown";
    readonly ageSeconds: number | null;
    readonly staleAfterSeconds: number;
  };
  readonly limitations: readonly string[];
}

export interface AwsOrganizationHierarchyEvidence {
  readonly scope: FinopsSourceScope;
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

export interface AwsBudgetsDashboardQuery {
  readonly currencies?: readonly string[];
  readonly budgetTypes?: readonly AwsBudgetType[];
  readonly accountIds?: readonly string[];
  readonly budgetLevels?: readonly string[];
  readonly budgetStatuses?: readonly AwsBudgetHealthStatus[];
  readonly namePrefix?: string;
  readonly effectiveAtIso?: string;
  readonly page?: { readonly limit?: number; readonly cursor?: string };
}

export type AwsBudgetHealthStatus = "HEALTHY" | "UNHEALTHY" | "FORECASTED_UNHEALTHY" | "UNCLASSIFIED";

export interface AwsBudgetAccountMapping {
  readonly accountId: string;
  readonly accountName: string | null;
  readonly parentId: string | null;
  readonly ouPath: readonly string[];
  readonly company: string | null;
  readonly businessUnit: string | null;
  readonly environment: string | null;
  readonly costCenter: string | null;
  readonly owner: string | null;
  readonly coverage: "complete" | "missing_hierarchy" | "missing_taxonomy";
}

export interface AwsBudgetsDashboardBudget {
  readonly budget: NormalizedAwsBudget;
  readonly targeting: "organization_wide" | "linked_accounts" | "unresolved";
  readonly accountMappings: readonly AwsBudgetAccountMapping[];
  readonly unmappedAccountIds: readonly string[];
  readonly mappingCoverage: "complete" | "partial" | "configuration_required";
  readonly health: {
    readonly statuses: readonly AwsBudgetHealthStatus[];
    readonly actualComparisonAvailable: boolean;
    readonly forecastComparisonAvailable: boolean;
  };
}

export interface AwsBudgetsDashboard {
  readonly schemaVersion: "sutra.aws-budgets-dashboard.v1";
  readonly source: "AWS_BUDGETS";
  readonly state: "ready" | "partial" | "configuration_required" | "unavailable";
  readonly sourceEvidence: {
    readonly captureId: string;
    readonly observedAtIso: string;
    readonly dataThroughAt: string | null;
    readonly freshness: AwsBudgetsSnapshot["freshness"];
    readonly taxonomyEvidenceId: string | null;
    readonly hierarchyEvidenceId: string | null;
  };
  readonly coverage: {
    readonly totalAwsBudgets: number | null;
    readonly matchedAwsBudgets: number | null;
    readonly budgetsWithActual: number;
    readonly budgetsWithForecast: number;
    readonly organizationWideBudgets: number;
    readonly linkedAccountBudgets: number;
    readonly unresolvedBudgets: number;
    readonly mappedAccounts: number;
    readonly missingHierarchyAccounts: number;
    readonly missingTaxonomyAccounts: number;
    readonly currencies: readonly string[];
    readonly budgetLevels: readonly string[];
    readonly healthStatusCounts: Readonly<Record<AwsBudgetHealthStatus, number>>;
  };
  readonly budgets: readonly AwsBudgetsDashboardBudget[];
  readonly nextCursor: string | null;
  readonly internalSutraBudgets: {
    readonly source: "SUTRA_INTERNAL_BUDGETS";
    readonly included: false;
    readonly reason: string;
  };
  readonly limitations: readonly string[];
}

export class AwsBudgetsOrganizationError extends Error {
  public readonly code:
    | "INVALID_CAPTURE"
    | "SCOPE_MISMATCH"
    | "INVALID_PAGINATION"
    | "BOUND_EXCEEDED"
    | "DUPLICATE_CONFLICT"
    | "INVALID_QUERY"
    | "INVALID_DEPENDENCY"
    | "RESPONSE_BOUND_EXCEEDED";

  public constructor(code: AwsBudgetsOrganizationError["code"]) {
    super("AWS Budgets evidence could not be processed");
    this.name = "AwsBudgetsOrganizationError";
    this.code = code;
  }
}

function reject(code: AwsBudgetsOrganizationError["code"]): never {
  throw new AwsBudgetsOrganizationError(code);
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  const actual = Object.keys(value).sort(compareText);
  const expected = [...keys].sort(compareText);
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    reject("INVALID_CAPTURE");
  }
}

function encodedBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return reject("INVALID_CAPTURE");
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function exactScope(left: FinopsSourceScope, right: FinopsSourceScope): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function validScope(value: unknown): value is AwsBudgetsScope {
  if (!record(value)) return false;
  const keys = Object.keys(value).sort(compareText);
  if (keys.join("|") !== ["accountId", "connectionId", "customerId", "orgId", "partition"].join("|")) return false;
  return IDENTIFIER.test(String(value.orgId ?? ""))
    && IDENTIFIER.test(String(value.customerId ?? ""))
    && CONNECTION_ID.test(String(value.connectionId ?? ""))
    && ACCOUNT_ID.test(String(value.accountId ?? ""))
    && ["aws", "aws-us-gov", "aws-cn"].includes(String(value.partition ?? ""));
}

function iso(value: unknown, maximumEpoch = Number.POSITIVE_INFINITY): string {
  if (typeof value !== "string") reject("INVALID_CAPTURE");
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch) || epoch > maximumEpoch) reject("INVALID_CAPTURE");
  return new Date(epoch).toISOString();
}

function safeText(value: unknown, maximum = 256): string {
  if (
    typeof value !== "string"
    || value.length > maximum
    || !SAFE_TEXT.test(value)
  ) reject("INVALID_CAPTURE");
  return value;
}

function amountMicros(amount: unknown): { canonical: string; micros: string } {
  if (typeof amount !== "string" || !DECIMAL.test(amount)) reject("INVALID_CAPTURE");
  const negative = amount.startsWith("-");
  const unsigned = negative ? amount.slice(1) : amount;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const micros = BigInt(whole) * BigInt(1_000_000)
    + BigInt((fraction + "000000").slice(0, 6));
  const signed = negative ? -micros : micros;
  const canonical = `${negative && signed !== BigInt(0) ? "-" : ""}${BigInt(whole).toString()}${
    fraction.length > 0 ? `.${fraction.replace(/0+$/u, "") || "0"}` : ""
  }`;
  return { canonical, micros: signed.toString() };
}

function money(value: unknown): NormalizedAwsBudgetMoney {
  if (!record(value)) reject("INVALID_CAPTURE");
  exactKeys(value, ["amount", "unit"]);
  const normalized = amountMicros(value.amount);
  const unit = safeText(value.unit, 32);
  return {
    amount: normalized.canonical,
    amountMicros: normalized.micros,
    unit,
    currency: CURRENCY.test(unit) ? unit : null,
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (record(value)) {
    return `{${Object.keys(value).sort(compareText).map((key) =>
      `${JSON.stringify(key)}:${canonicalJson(value[key])}`
    ).join(",")}}`;
  }
  return JSON.stringify(value);
}

function insertUnique<T>(
  map: Map<string, { canonical: string; value: T }>,
  key: string,
  value: T,
): void {
  const canonical = canonicalJson(value);
  const existing = map.get(key);
  if (existing && existing.canonical !== canonical) reject("DUPLICATE_CONFLICT");
  if (!existing) map.set(key, { canonical, value });
}

function validatePageSequence<T>(
  pages: readonly AwsBudgetPage<T>[],
  scope: AwsBudgetsScope,
  maximumRecords: number,
  parse: (value: unknown) => T,
): { records: readonly T[]; exhausted: boolean } {
  if (!Array.isArray(pages) || pages.length > AWS_BUDGETS_COLLECTION_BOUNDS.maximumPages) {
    reject("BOUND_EXCEEDED");
  }
  let expectedToken: string | null = null;
  let count = 0;
  const tokens = new Set<string>();
  const output: T[] = [];
  for (const page of pages) {
    if (!record(page) || !record(page.request) || !record(page.response)) {
      reject("INVALID_CAPTURE");
    }
    exactKeys(page, ["request", "response"]);
    exactKeys(page.request, ["accountId", "maxResults", "nextToken"]);
    exactKeys(page.response, ["records", "nextToken"]);
    if (
      page.request.accountId !== scope.accountId
      || page.request.maxResults !== AWS_BUDGETS_COLLECTION_BOUNDS.apiPageSize
      || page.request.nextToken !== expectedToken
      || !Array.isArray(page.response.records)
      || page.response.records.length > AWS_BUDGETS_COLLECTION_BOUNDS.apiPageSize
    ) reject("INVALID_PAGINATION");
    const next = page.response.nextToken;
    if (next !== null && (typeof next !== "string" || !SAFE_TOKEN.test(next) || tokens.has(next))) {
      reject("INVALID_PAGINATION");
    }
    if (next !== null) tokens.add(next);
    count += page.response.records.length;
    if (count > maximumRecords) reject("BOUND_EXCEEDED");
    output.push(...page.response.records.map(parse));
    expectedToken = next;
  }
  return { records: output, exhausted: pages.length > 0 && expectedToken === null };
}

function parseCostTypes(value: unknown): AwsBudgetCostTypes {
  if (!record(value)) reject("INVALID_CAPTURE");
  const keys: readonly (keyof AwsBudgetCostTypes)[] = [
    "includeCredit", "includeDiscount", "includeOtherSubscription",
    "includeRecurring", "includeRefund", "includeSubscription",
    "includeSupport", "includeTax", "includeUpfront", "useAmortized",
    "useBlended",
  ];
  if (Object.keys(value).length !== keys.length) reject("INVALID_CAPTURE");
  const output = {} as Record<keyof AwsBudgetCostTypes, boolean>;
  for (const key of keys) {
    if (typeof value[key] !== "boolean") reject("INVALID_CAPTURE");
    output[key] = value[key];
  }
  return output;
}

function parseFilters(value: unknown): readonly { key: string; values: readonly string[] }[] {
  if (!record(value)) reject("INVALID_CAPTURE");
  const entries = Object.entries(value);
  if (entries.length > AWS_BUDGETS_COLLECTION_BOUNDS.maximumCostFilterKeys) {
    reject("BOUND_EXCEEDED");
  }
  return entries.map(([key, rawValues]) => {
    safeText(key, 128);
    if (
      !Array.isArray(rawValues)
      || rawValues.length > AWS_BUDGETS_COLLECTION_BOUNDS.maximumCostFilterValuesPerKey
    ) reject("BOUND_EXCEEDED");
    const values = rawValues.map((item) => safeText(item, 256)).sort(compareText);
    if (new Set(values).size !== values.length) reject("DUPLICATE_CONFLICT");
    return { key, values };
  }).sort((left, right) => compareText(left.key, right.key));
}

function parseBudget(value: unknown): NormalizedAwsBudget {
  if (!record(value) || !BUDGET_NAME.test(String(value.budgetName ?? ""))) {
    reject("INVALID_CAPTURE");
  }
  exactKeys(value, [
    "budgetName", "budgetType", "timeUnit", "timePeriod", "budgetLimit",
    "plannedBudgetLimits", "calculatedSpend", "costFilters", "costTypes",
    "metrics", "lastUpdatedAt",
  ]);
  const types: readonly AwsBudgetType[] = [
    "COST", "USAGE", "RI_UTILIZATION", "RI_COVERAGE",
    "SAVINGS_PLANS_UTILIZATION", "SAVINGS_PLANS_COVERAGE",
  ];
  const units: readonly AwsBudgetTimeUnit[] = ["DAILY", "MONTHLY", "QUARTERLY", "ANNUALLY", "CUSTOM"];
  if (!types.includes(value.budgetType as AwsBudgetType) || !units.includes(value.timeUnit as AwsBudgetTimeUnit)) {
    reject("INVALID_CAPTURE");
  }
  if (!record(value.timePeriod) || !record(value.calculatedSpend)) reject("INVALID_CAPTURE");
  exactKeys(value.timePeriod, ["start", "end"]);
  exactKeys(value.calculatedSpend, ["actualSpend", "forecastedSpend"]);
  const start = iso(value.timePeriod.start);
  const end = iso(value.timePeriod.end);
  if (Date.parse(start) >= Date.parse(end)) reject("INVALID_CAPTURE");
  const filters = parseFilters(value.costFilters);
  const planned = value.plannedBudgetLimits;
  if (!record(planned) || Object.keys(planned).length > 120) reject("BOUND_EXCEEDED");
  const plannedBudgetLimits = Object.entries(planned).map(([key, spend]) => ({
    effectiveAt: iso(key),
    amount: money(spend),
  })).sort((left, right) => compareText(left.effectiveAt, right.effectiveAt));
  if (value.budgetLimit === null && plannedBudgetLimits.length === 0) reject("INVALID_CAPTURE");
  if (!Array.isArray(value.metrics) || value.metrics.length > 10) reject("INVALID_CAPTURE");
  const metrics = value.metrics.map((item) => safeText(item, 64)).sort(compareText);
  if (new Set(metrics).size !== metrics.length) reject("DUPLICATE_CONFLICT");
  return {
    source: "AWS_BUDGETS",
    accountId: "",
    budgetName: String(value.budgetName),
    budgetType: value.budgetType as AwsBudgetType,
    timeUnit: value.timeUnit as AwsBudgetTimeUnit,
    effectivePeriod: { start, end },
    budgetLimit: value.budgetLimit === null ? null : money(value.budgetLimit),
    plannedBudgetLimits,
    actual: value.calculatedSpend.actualSpend === null ? null : money(value.calculatedSpend.actualSpend),
    forecast: value.calculatedSpend.forecastedSpend === null ? null : money(value.calculatedSpend.forecastedSpend),
    costFilters: filters,
    costTypes: parseCostTypes(value.costTypes),
    metrics,
    lastUpdatedAt: value.lastUpdatedAt === null ? null : iso(value.lastUpdatedAt),
    history: [],
    notifications: [],
    actions: [],
    hierarchyLevel: null,
    coverage: {
      history: "configuration_required",
      notifications: "configuration_required",
      subscribers: "configuration_required",
      actions: "configuration_required",
      hierarchyTag: "configuration_required",
      actual: value.calculatedSpend.actualSpend === null ? "unavailable" : "available",
      forecast: value.calculatedSpend.forecastedSpend === null ? "unavailable" : "available",
    },
  };
}

function parseHistory(value: unknown): NormalizedAwsBudgetHistory {
  if (!record(value) || !record(value.timePeriod)) reject("INVALID_CAPTURE");
  exactKeys(value, ["timePeriod", "budgetedAmount", "actualAmount", "forecastedAmount"]);
  exactKeys(value.timePeriod, ["start", "end"]);
  const periodStart = iso(value.timePeriod.start);
  const periodEnd = iso(value.timePeriod.end);
  if (Date.parse(periodStart) >= Date.parse(periodEnd)) reject("INVALID_CAPTURE");
  return {
    periodStart,
    periodEnd,
    budgeted: money(value.budgetedAmount),
    actual: value.actualAmount === null ? null : money(value.actualAmount),
    forecast: value.forecastedAmount === null ? null : money(value.forecastedAmount),
  };
}

function parseNotification(value: unknown): AwsBudgetNotificationRecord {
  if (!record(value)) reject("INVALID_CAPTURE");
  exactKeys(value, ["comparisonOperator", "notificationType", "threshold", "thresholdType"]);
  const operators = ["GREATER_THAN", "LESS_THAN", "EQUAL_TO"];
  const types = ["ACTUAL", "FORECASTED"];
  const thresholdTypes = ["PERCENTAGE", "ABSOLUTE_VALUE"];
  if (
    !operators.includes(String(value.comparisonOperator))
    || !types.includes(String(value.notificationType))
    || !thresholdTypes.includes(String(value.thresholdType))
  ) reject("INVALID_CAPTURE");
  const threshold = amountMicros(value.threshold).canonical;
  return {
    comparisonOperator: value.comparisonOperator as AwsBudgetNotificationRecord["comparisonOperator"],
    notificationType: value.notificationType as AwsBudgetNotificationRecord["notificationType"],
    threshold,
    thresholdType: value.thresholdType as AwsBudgetNotificationRecord["thresholdType"],
  };
}

function notificationKey(value: AwsBudgetNotificationRecord): string {
  return [value.notificationType, value.comparisonOperator, value.thresholdType, value.threshold].join("|");
}

function parseSubscriber(value: unknown): AwsBudgetSubscriberRecord {
  if (!record(value) || !["EMAIL", "SNS"].includes(String(value.subscriptionType))) {
    reject("INVALID_CAPTURE");
  }
  if (Object.keys(value).some((key) => key !== "subscriptionType")) reject("INVALID_CAPTURE");
  return { subscriptionType: value.subscriptionType as "EMAIL" | "SNS" };
}

function parseBudgetLevelTag(value: unknown): AwsBudgetLevelTagRecord {
  if (!record(value)) reject("INVALID_CAPTURE");
  exactKeys(value, ["key", "value"]);
  if (value.key !== "cid:budget-level") reject("INVALID_CAPTURE");
  return { key: "cid:budget-level", value: safeText(value.value, 128) };
}

function parseAction(value: unknown): NormalizedAwsBudgetAction {
  if (!record(value) || !IDENTIFIER.test(String(value.actionId ?? ""))) reject("INVALID_CAPTURE");
  exactKeys(value, [
    "actionId", "actionType", "approvalModel", "notificationType", "status",
    "threshold", "thresholdType", "executionRolePresent",
    "targetedResourceCount",
  ]);
  const actionTypes = ["APPLY_IAM_POLICY", "APPLY_SCP_POLICY", "RUN_SSM_DOCUMENTS"];
  const statuses = [
    "STANDBY", "PENDING", "EXECUTION_IN_PROGRESS", "EXECUTION_SUCCESS",
    "EXECUTION_FAILURE", "REVERSE_IN_PROGRESS", "REVERSE_SUCCESS",
    "REVERSE_FAILURE", "RESET_IN_PROGRESS", "RESET_FAILURE",
  ];
  if (
    !actionTypes.includes(String(value.actionType))
    || !["AUTOMATIC", "MANUAL"].includes(String(value.approvalModel))
    || !["ACTUAL", "FORECASTED"].includes(String(value.notificationType))
    || !statuses.includes(String(value.status))
    || !["PERCENTAGE", "ABSOLUTE_VALUE"].includes(String(value.thresholdType))
    || typeof value.executionRolePresent !== "boolean"
    || !Number.isSafeInteger(value.targetedResourceCount)
    || Number(value.targetedResourceCount) < 0
    || Number(value.targetedResourceCount) > 100_000
  ) reject("INVALID_CAPTURE");
  return {
    actionId: String(value.actionId),
    actionType: value.actionType as NormalizedAwsBudgetAction["actionType"],
    approvalModel: value.approvalModel as NormalizedAwsBudgetAction["approvalModel"],
    notificationType: value.notificationType as NormalizedAwsBudgetAction["notificationType"],
    status: value.status as NormalizedAwsBudgetAction["status"],
    threshold: amountMicros(value.threshold).canonical,
    thresholdType: value.thresholdType as NormalizedAwsBudgetAction["thresholdType"],
    executionRolePresent: value.executionRolePresent,
    targetedResourceCount: Number(value.targetedResourceCount),
  };
}

function operationState(
  coverage: ReadonlyMap<AwsBudgetOperation, AwsBudgetOperationCoverage>,
  operation: AwsBudgetOperation,
): AwsBudgetOperationState {
  return coverage.get(operation)?.state ?? reject("INVALID_CAPTURE");
}

function coverageForSequence(
  state: AwsBudgetOperationState,
  exists: boolean,
  exhausted: boolean,
): "complete" | "partial" | "configuration_required" {
  if (state === "ACCESS_DENIED" || state === "UNAVAILABLE") return "configuration_required";
  if (!exists || !exhausted || state === "PARTIAL") return "partial";
  return "complete";
}

function parseNamedSequences<T>(
  sequences: readonly AwsBudgetNamedSequence<T>[],
  scope: AwsBudgetsScope,
  budgets: ReadonlySet<string>,
  maximum: number,
  parse: (value: unknown) => T,
  key: (value: T) => string,
): Map<string, { values: readonly T[]; exhausted: boolean }> {
  if (!Array.isArray(sequences) || sequences.length > budgets.size) reject("BOUND_EXCEEDED");
  const output = new Map<string, { values: readonly T[]; exhausted: boolean }>();
  let total = 0;
  for (const sequence of sequences) {
    if (!record(sequence)) reject("INVALID_CAPTURE");
    exactKeys(sequence, ["budgetName", "pages"]);
    const budgetName = String(sequence.budgetName ?? "");
    if (!BUDGET_NAME.test(budgetName) || !budgets.has(budgetName) || !Array.isArray(sequence.pages)) {
      reject("INVALID_CAPTURE");
    }
    const page = validatePageSequence(
      sequence.pages as readonly AwsBudgetPage<T>[],
      scope,
      maximum,
      parse,
    );
    total += page.records.length;
    if (total > maximum) reject("BOUND_EXCEEDED");
    const unique = new Map<string, { canonical: string; value: T }>();
    for (const item of page.records) insertUnique(unique, key(item), item);
    const value = {
      values: [...unique.values()].map((entry) => entry.value).sort((left, right) =>
        compareText(key(left), key(right))),
      exhausted: page.exhausted,
    };
    const existing = output.get(budgetName);
    if (existing && canonicalJson(existing) !== canonicalJson(value)) reject("DUPLICATE_CONFLICT");
    output.set(budgetName, value);
  }
  return output;
}

export function normalizeAwsBudgetsCapture(
  value: unknown,
  expectedScope: AwsBudgetsScope,
  nowEpochMs: number = Date.now(),
): AwsBudgetsSnapshot {
  if (!record(value) || !validScope(expectedScope) || !validScope(value.scope)) {
    reject("INVALID_CAPTURE");
  }
  exactKeys(value, [
    "schemaVersion", "scope", "captureId", "startedAtIso", "completedAtIso",
    "operationCoverage", "budgetPages", "historySequences",
    "notificationSequences", "subscriberSequences", "actionSequences", "tagSequences",
  ]);
  if (
    !exactScope(value.scope, expectedScope)
    || value.scope.accountId !== expectedScope.accountId
    || value.scope.partition !== expectedScope.partition
  ) reject("SCOPE_MISMATCH");
  if (
    value.schemaVersion !== "sutra.aws-budgets-organization.v1"
    || !CAPTURE_ID.test(String(value.captureId ?? ""))
    || !Number.isFinite(nowEpochMs)
  ) reject("INVALID_CAPTURE");
  if (encodedBytes(value) > AWS_BUDGETS_COLLECTION_BOUNDS.maximumCaptureBytes) reject("BOUND_EXCEEDED");
  const completedAtIso = iso(value.completedAtIso, nowEpochMs + 5 * 60 * 1_000);
  const startedAtIso = iso(value.startedAtIso, Date.parse(completedAtIso));
  if (Date.parse(completedAtIso) - Date.parse(startedAtIso) > 30 * 60 * 1_000) reject("BOUND_EXCEEDED");
  if (!Array.isArray(value.operationCoverage) || value.operationCoverage.length !== AWS_BUDGETS_READ_API_OPERATIONS.length) {
    reject("INVALID_CAPTURE");
  }
  const coverage = new Map<AwsBudgetOperation, AwsBudgetOperationCoverage>();
  for (const raw of value.operationCoverage) {
    if (!record(raw)
      || !AWS_BUDGETS_READ_API_OPERATIONS.includes(raw.operation as AwsBudgetOperation)
      || !["SUCCEEDED", "PARTIAL", "ACCESS_DENIED", "UNAVAILABLE"].includes(String(raw.state))
      || !Number.isSafeInteger(raw.recordCount)
      || Number(raw.recordCount) < 0
      || Number(raw.recordCount) > 100_000
      || (raw.failureCode !== null && ![
        "ACCESS_DENIED", "EXPIRED_TOKEN", "THROTTLED", "TIMEOUT",
        "BOUND_REACHED", "PROVIDER_UNAVAILABLE", "UNKNOWN",
      ].includes(String(raw.failureCode)))
    ) reject("INVALID_CAPTURE");
    exactKeys(raw, ["operation", "state", "recordCount", "failureCode"]);
    if (coverage.has(raw.operation as AwsBudgetOperation)) reject("DUPLICATE_CONFLICT");
    if ((raw.state === "SUCCEEDED") !== (raw.failureCode === null)) reject("INVALID_CAPTURE");
    coverage.set(raw.operation as AwsBudgetOperation, {
      operation: raw.operation as AwsBudgetOperation,
      state: raw.state as AwsBudgetOperationState,
      recordCount: Number(raw.recordCount),
      failureCode: raw.failureCode as AwsBudgetFailureCode | null,
    });
  }
  const budgetPages = validatePageSequence<NormalizedAwsBudget>(
    value.budgetPages as readonly AwsBudgetPage<NormalizedAwsBudget>[],
    expectedScope,
    AWS_BUDGETS_COLLECTION_BOUNDS.maximumBudgets,
    parseBudget,
  );
  const budgetMap = new Map<string, { canonical: string; value: NormalizedAwsBudget }>();
  for (const item of budgetPages.records) insertUnique(budgetMap, item.budgetName, item);
  const describeState = operationState(coverage, "DescribeBudgets");
  if (
    coverage.get("DescribeBudgets")?.recordCount !== budgetMap.size
    || (describeState === "SUCCEEDED" && !budgetPages.exhausted)
    || ((describeState === "ACCESS_DENIED" || describeState === "UNAVAILABLE") && budgetMap.size > 0)
  ) reject("INVALID_CAPTURE");
  const names = new Set(budgetMap.keys());
  const histories = parseNamedSequences<NormalizedAwsBudgetHistory>(
    (value.historySequences as readonly AwsBudgetNamedSequence<NormalizedAwsBudgetHistory>[]) ?? [],
    expectedScope,
    names,
    AWS_BUDGETS_COLLECTION_BOUNDS.maximumHistoryRecords,
    parseHistory,
    (item) => `${item.periodStart}|${item.periodEnd}`,
  );
  const notifications = parseNamedSequences(
    (value.notificationSequences as readonly AwsBudgetNamedSequence<AwsBudgetNotificationRecord>[]) ?? [],
    expectedScope,
    names,
    AWS_BUDGETS_COLLECTION_BOUNDS.maximumNotifications,
    parseNotification,
    notificationKey,
  );
  const actions = parseNamedSequences(
    (value.actionSequences as readonly AwsBudgetNamedSequence<AwsBudgetActionRecord>[]) ?? [],
    expectedScope,
    names,
    AWS_BUDGETS_COLLECTION_BOUNDS.maximumActions,
    parseAction,
    (item) => item.actionId,
  );
  const tags = parseNamedSequences(
    (value.tagSequences as readonly AwsBudgetNamedSequence<AwsBudgetLevelTagRecord>[]) ?? [],
    expectedScope,
    names,
    AWS_BUDGETS_COLLECTION_BOUNDS.maximumBudgetLevelTags,
    parseBudgetLevelTag,
    (item) => item.key,
  );
  if (!Array.isArray(value.subscriberSequences) || value.subscriberSequences.length > AWS_BUDGETS_COLLECTION_BOUNDS.maximumNotifications) {
    reject("BOUND_EXCEEDED");
  }
  const subscribers = new Map<string, { values: readonly AwsBudgetSubscriberRecord[]; exhausted: boolean }>();
  let subscriberCount = 0;
  for (const sequence of value.subscriberSequences as readonly AwsBudgetSubscriberSequence[]) {
    if (!record(sequence)) reject("INVALID_CAPTURE");
    exactKeys(sequence, ["budgetName", "notification", "pages"]);
    if (!names.has(sequence.budgetName)) reject("INVALID_CAPTURE");
    const parsedNotification = parseNotification(sequence.notification);
    const notificationRecords = notifications.get(sequence.budgetName)?.values ?? [];
    if (!notificationRecords.some((item) => notificationKey(item) === notificationKey(parsedNotification))) reject("INVALID_CAPTURE");
    const page = validatePageSequence(
      sequence.pages,
      expectedScope,
      AWS_BUDGETS_COLLECTION_BOUNDS.maximumSubscribers,
      parseSubscriber,
    );
    subscriberCount += page.records.length;
    if (subscriberCount > AWS_BUDGETS_COLLECTION_BOUNDS.maximumSubscribers) reject("BOUND_EXCEEDED");
    const mapKey = `${sequence.budgetName}|${notificationKey(parsedNotification)}`;
    const result = { values: page.records, exhausted: page.exhausted };
    const existing = subscribers.get(mapKey);
    if (existing && canonicalJson(existing) !== canonicalJson(result)) reject("DUPLICATE_CONFLICT");
    subscribers.set(mapKey, result);
  }
  const operationCounts: Readonly<Record<Exclude<AwsBudgetOperation, "DescribeBudgets">, number>> = {
    DescribeBudgetPerformanceHistory: [...histories.values()].reduce((sum, item) => sum + item.values.length, 0),
    DescribeNotificationsForBudget: [...notifications.values()].reduce((sum, item) => sum + item.values.length, 0),
    DescribeSubscribersForNotification: subscriberCount,
    DescribeBudgetActionsForBudget: [...actions.values()].reduce((sum, item) => sum + item.values.length, 0),
    ListTagsForResource: [...tags.values()].reduce((sum, item) => sum + item.values.length, 0),
  };
  for (const [operation, count] of Object.entries(operationCounts) as [Exclude<AwsBudgetOperation, "DescribeBudgets">, number][]) {
    if (coverage.get(operation)?.recordCount !== count) reject("INVALID_CAPTURE");
  }
  const historyState = operationState(coverage, "DescribeBudgetPerformanceHistory");
  const notificationState = operationState(coverage, "DescribeNotificationsForBudget");
  const subscriberState = operationState(coverage, "DescribeSubscribersForNotification");
  const actionState = operationState(coverage, "DescribeBudgetActionsForBudget");
  const tagState = operationState(coverage, "ListTagsForResource");
  const normalizedBudgets = [...budgetMap.values()].map(({ value: budget }) => {
    const history = histories.get(budget.budgetName);
    const notification = notifications.get(budget.budgetName);
    const action = actions.get(budget.budgetName);
    const tag = tags.get(budget.budgetName);
    const normalizedNotifications = (notification?.values ?? []).map((item) => {
      const subscriber = subscribers.get(`${budget.budgetName}|${notificationKey(item)}`);
      return {
        ...item,
        subscriberCount: subscriber ? subscriber.values.length : null,
        subscriberTypes: subscriber
          ? [...new Set(subscriber.values.map((entry) => entry.subscriptionType))].sort(compareText)
          : [],
        subscriberCoverage: coverageForSequence(subscriberState, Boolean(subscriber), subscriber?.exhausted ?? false),
      } satisfies NormalizedAwsBudgetNotification;
    });
    const maximumHistory = budget.timeUnit === "DAILY"
      ? AWS_BUDGETS_COLLECTION_BOUNDS.maximumDailyHistoryPerBudget
      : budget.timeUnit === "MONTHLY"
      ? AWS_BUDGETS_COLLECTION_BOUNDS.maximumMonthlyHistoryPerBudget
      : budget.timeUnit === "QUARTERLY"
      ? AWS_BUDGETS_COLLECTION_BOUNDS.maximumQuarterlyHistoryPerBudget
      : 0;
    if ((history?.values.length ?? 0) > maximumHistory) reject("BOUND_EXCEEDED");
    const expectedUnits = [
      budget.budgetLimit,
      ...budget.plannedBudgetLimits.map((item) => item.amount),
      budget.actual,
      budget.forecast,
      ...(history?.values ?? []).flatMap((item) => [
        item.budgeted,
        item.actual,
        item.forecast,
      ]),
    ].filter((item): item is NormalizedAwsBudgetMoney => item !== null);
    if (new Set(expectedUnits.map((item) => item.unit)).size > 1) reject("INVALID_CAPTURE");
    return {
      ...budget,
      accountId: expectedScope.accountId,
      history: history?.values ?? [],
      notifications: normalizedNotifications,
      actions: action?.values ?? [],
      hierarchyLevel: tag?.values[0]?.value ?? null,
      coverage: {
        history: ["ANNUALLY", "CUSTOM"].includes(budget.timeUnit)
          ? "not_applicable" as const
          : coverageForSequence(historyState, Boolean(history), history?.exhausted ?? false),
        notifications: coverageForSequence(notificationState, Boolean(notification), notification?.exhausted ?? false),
        subscribers: normalizedNotifications.length === 0
          ? coverageForSequence(subscriberState, subscriberState === "SUCCEEDED", subscriberState === "SUCCEEDED")
          : normalizedNotifications.every((item) => item.subscriberCoverage === "complete")
          ? "complete" as const
          : normalizedNotifications.some((item) => item.subscriberCoverage === "configuration_required")
          ? "configuration_required" as const
          : "partial" as const,
        actions: coverageForSequence(actionState, Boolean(action), action?.exhausted ?? false),
        hierarchyTag: coverageForSequence(tagState, Boolean(tag), tag?.exhausted ?? false),
        actual: budget.actual === null ? "unavailable" as const : "available" as const,
        forecast: budget.forecast === null ? "unavailable" as const : "available" as const,
      },
    };
  }).sort((left, right) => compareText(left.budgetName, right.budgetName));
  const secondaryPartial = [...coverage.values()].some((item) => item.state !== "SUCCEEDED");
  const missingCostEvidence = normalizedBudgets.some((item) => item.actual === null || item.forecast === null);
  const missingBudgetHierarchy = normalizedBudgets.some((item) => item.hierarchyLevel === null);
  const collectionState: AwsBudgetsSnapshot["collectionState"] =
    describeState === "ACCESS_DENIED" ? "configuration_required"
    : describeState === "UNAVAILABLE" ? "unavailable"
    : describeState === "PARTIAL" || secondaryPartial || missingCostEvidence || missingBudgetHierarchy ? "partial"
    : "ready";
  const providerUpdates = normalizedBudgets.map((item) => item.lastUpdatedAt)
    .filter((item): item is string => item !== null).sort(compareText);
  const dataThroughAt = providerUpdates.length === normalizedBudgets.length && providerUpdates.length > 0
    ? providerUpdates[0]!
    : null;
  const ageSeconds = dataThroughAt === null ? null : Math.floor((nowEpochMs - Date.parse(dataThroughAt)) / 1_000);
  const staleAfterSeconds = AWS_BUDGETS_COLLECTION_BOUNDS.sourceFreshnessSlaHours * 60 * 60;
  return {
    schemaVersion: "sutra.aws-budgets-organization.v1",
    scope: { ...expectedScope },
    captureId: String(value.captureId),
    observedAtIso: completedAtIso,
    dataThroughAt,
    collectionState,
    operationCoverage: AWS_BUDGETS_READ_API_OPERATIONS.map((operation) => coverage.get(operation)!),
    budgets: normalizedBudgets,
    freshness: {
      status: ageSeconds === null ? "unknown" : ageSeconds > staleAfterSeconds ? "stale" : "fresh",
      ageSeconds,
      staleAfterSeconds,
    },
    limitations: [
      "AWS Budgets status is updated several times per day and is not real-time billing evidence.",
      "AWS Budgets and Sutra internal budgets remain separate sources and are never silently merged.",
      "The dashboard hierarchy uses only the exact provider cid:budget-level tag; missing tags are never inferred.",
      "Missing access, taxonomy, hierarchy, actual, or forecast evidence is reported as partial or configuration-required, never as zero.",
    ],
  };
}

export function awsBudgetsOrganizationSourceEvidence(
  snapshot: AwsBudgetsSnapshot,
): FinopsSourceEvidence {
  if (!record(snapshot) || !validScope(snapshot.scope)) reject("INVALID_CAPTURE");
  const enumeration = snapshot.operationCoverage.find((item) =>
    item.operation === "DescribeBudgets"
  );
  if (!enumeration) reject("INVALID_CAPTURE");
  const deliveryObserved = enumeration.state === "SUCCEEDED" || enumeration.state === "PARTIAL";
  const complete = snapshot.collectionState === "ready";
  return {
    scope: {
      orgId: snapshot.scope.orgId,
      customerId: snapshot.scope.customerId,
      connectionId: snapshot.scope.connectionId,
    },
    sourceId: "aws_budgets",
    configured: enumeration.state !== "ACCESS_DENIED",
    deliveryObserved,
    lastAttemptAt: snapshot.observedAtIso,
    lastAttemptOutcome: complete
      ? "succeeded"
      : snapshot.collectionState === "partial" ? "partial" : "failed",
    lastSuccessAt: complete ? snapshot.observedAtIso : null,
    dataThroughAt: snapshot.dataThroughAt,
    coverage: {
      assessment: complete
        ? "complete"
        : snapshot.collectionState === "partial" ? "partial" : "unknown",
      acceptedRecords: deliveryObserved ? snapshot.budgets.length : null,
      expectedRecords: enumeration.state === "SUCCEEDED" ? snapshot.budgets.length : null,
      rejectedRecords: null,
    },
    lastError: snapshot.collectionState === "configuration_required"
      || snapshot.collectionState === "unavailable"
      ? {
        code: snapshot.collectionState === "configuration_required"
          ? "AWS_BUDGETS_ACCESS_REQUIRED"
          : "AWS_BUDGETS_UNAVAILABLE",
        message: "The AWS Budgets source could not be collected.",
        at: snapshot.observedAtIso,
      }
      : null,
    evidenceBasis:
      "Bounded tenant-pinned AWS Budgets definitions, calculated-spend, performance-history, notification, subscriber-summary, and action-metadata capture.",
    limitations: snapshot.limitations,
  };
}

function validateHierarchy(
  hierarchy: AwsOrganizationHierarchyEvidence | null,
  scope: FinopsSourceScope,
  nowEpochMs: number,
): Map<string, AwsOrganizationHierarchyEvidence["accounts"][number]> | null {
  if (hierarchy === null) return null;
  if (!exactScope(hierarchy.scope, scope)
    || !IDENTIFIER.test(hierarchy.sourceEvidenceId)
    || !["complete", "partial", "configuration_required", "unavailable"].includes(hierarchy.state)
    || hierarchy.accounts.length > AWS_BUDGETS_COLLECTION_BOUNDS.maximumHierarchyAccounts
  ) reject("INVALID_DEPENDENCY");
  iso(hierarchy.observedAtIso, nowEpochMs + 5 * 60 * 1_000);
  const map = new Map<string, AwsOrganizationHierarchyEvidence["accounts"][number]>();
  for (const account of hierarchy.accounts) {
    if (!ACCOUNT_ID.test(account.accountId)
      || !SAFE_TEXT.test(account.accountName)
      || !IDENTIFIER.test(account.parentId)
      || account.ouPath.length > 20
      || account.ouPath.some((part) => !SAFE_TEXT.test(part))
    ) reject("INVALID_DEPENDENCY");
    const existing = map.get(account.accountId);
    if (existing && canonicalJson(existing) !== canonicalJson(account)) reject("DUPLICATE_CONFLICT");
    map.set(account.accountId, account);
  }
  if ((hierarchy.state === "configuration_required" || hierarchy.state === "unavailable") && map.size > 0) {
    reject("INVALID_DEPENDENCY");
  }
  return map;
}

function validateTaxonomy(
  taxonomy: FinopsOrganizationTaxonomy | null,
  scope: FinopsSourceScope,
  nowEpochMs: number,
): Map<string, FinopsTaxonomyAssignment> | null {
  if (taxonomy === null) return null;
  if (!exactScope({
    orgId: taxonomy.scope.organizationId,
    customerId: taxonomy.scope.customerId,
    connectionId: taxonomy.scope.connectionId,
  }, scope)
    || !IDENTIFIER.test(taxonomy.evidence.sourceEvidenceId)
    || taxonomy.assignments.length > AWS_BUDGETS_COLLECTION_BOUNDS.maximumTaxonomyAssignments
  ) reject("INVALID_DEPENDENCY");
  iso(taxonomy.evidence.observedAtIso, nowEpochMs + 5 * 60 * 1_000);
  const map = new Map<string, FinopsTaxonomyAssignment>();
  for (const assignment of taxonomy.assignments) {
    if (!ACCOUNT_ID.test(assignment.accountId)) reject("INVALID_DEPENDENCY");
    for (const item of [
      assignment.company,
      assignment.businessUnit,
      assignment.environment,
      assignment.costCenter,
      assignment.owner,
    ]) {
      if (item !== undefined && item !== null && (
        typeof item !== "string" || item.length > 256 || !SAFE_TEXT.test(item)
      )) reject("INVALID_DEPENDENCY");
    }
    const existing = map.get(assignment.accountId);
    if (existing && canonicalJson(existing) !== canonicalJson(assignment)) reject("DUPLICATE_CONFLICT");
    map.set(assignment.accountId, assignment);
  }
  return map;
}

function parseQuery(value: unknown): Required<Pick<AwsBudgetsDashboardQuery, "currencies" | "budgetTypes" | "accountIds" | "budgetLevels" | "budgetStatuses">> & {
  namePrefix: string | null;
  effectiveAtIso: string | null;
  limit: number;
  offset: number;
} {
  if (value === undefined) value = {};
  if (!record(value)) reject("INVALID_QUERY");
  if (Object.keys(value).some((key) => ![
    "currencies", "budgetTypes", "accountIds", "budgetLevels", "budgetStatuses", "namePrefix",
    "effectiveAtIso", "page",
  ].includes(key))) reject("INVALID_QUERY");
  const currencies = value.currencies ?? [];
  const budgetTypes = value.budgetTypes ?? [];
  const accountIds = value.accountIds ?? [];
  const budgetLevels = value.budgetLevels ?? [];
  const budgetStatuses = value.budgetStatuses ?? [];
  if (!Array.isArray(currencies) || currencies.length > 20 || currencies.some((item) => !CURRENCY.test(String(item)))) reject("INVALID_QUERY");
  const knownTypes: readonly string[] = ["COST", "USAGE", "RI_UTILIZATION", "RI_COVERAGE", "SAVINGS_PLANS_UTILIZATION", "SAVINGS_PLANS_COVERAGE"];
  if (!Array.isArray(budgetTypes) || budgetTypes.length > knownTypes.length || budgetTypes.some((item) => !knownTypes.includes(String(item)))) reject("INVALID_QUERY");
  if (!Array.isArray(accountIds)
    || accountIds.length > AWS_BUDGETS_COLLECTION_BOUNDS.maximumQueryAccountFilters
    || accountIds.some((item) => !ACCOUNT_ID.test(String(item)))
  ) reject("INVALID_QUERY");
  if (!Array.isArray(budgetLevels) || budgetLevels.length > 100
    || budgetLevels.some((item) => typeof item !== "string" || !SAFE_TEXT.test(item))) reject("INVALID_QUERY");
  const knownStatuses: readonly string[] = ["HEALTHY", "UNHEALTHY", "FORECASTED_UNHEALTHY", "UNCLASSIFIED"];
  if (!Array.isArray(budgetStatuses) || budgetStatuses.length > knownStatuses.length
    || budgetStatuses.some((item) => !knownStatuses.includes(String(item)))) reject("INVALID_QUERY");
  for (const items of [currencies, budgetTypes, accountIds, budgetLevels, budgetStatuses]) {
    if (new Set(items).size !== items.length) reject("INVALID_QUERY");
  }
  const namePrefix = value.namePrefix === undefined ? null : safeText(value.namePrefix, 100);
  const effectiveAtIso = value.effectiveAtIso === undefined ? null : iso(value.effectiveAtIso);
  const page = value.page ?? {};
  if (!record(page)) reject("INVALID_QUERY");
  if (Object.keys(page).some((key) => !["limit", "cursor"].includes(key))) reject("INVALID_QUERY");
  const limit = page.limit ?? 50;
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > AWS_BUDGETS_COLLECTION_BOUNDS.maximumQueryPageSize) reject("INVALID_QUERY");
  let offset = 0;
  if (page.cursor !== undefined) {
    const match = /^v1:(0|[1-9]\d{0,8})$/u.exec(String(page.cursor));
    if (!match) reject("INVALID_QUERY");
    offset = Number(match[1]);
  }
  return {
    currencies: [...currencies] as string[],
    budgetTypes: [...budgetTypes] as AwsBudgetType[],
    accountIds: [...accountIds] as string[],
    budgetLevels: [...budgetLevels] as string[],
    budgetStatuses: [...budgetStatuses] as AwsBudgetHealthStatus[],
    namePrefix,
    effectiveAtIso,
    limit: Number(limit),
    offset,
  };
}

function budgetHealth(budget: NormalizedAwsBudget): AwsBudgetsDashboardBudget["health"] {
  const limit = budget.budgetLimit;
  const actual = budget.actual;
  const forecast = budget.forecast;
  const actualAvailable = limit !== null && actual !== null && limit.currency === actual.currency;
  const forecastAvailable = limit !== null && forecast !== null && limit.currency === forecast.currency;
  const statuses: AwsBudgetHealthStatus[] = [];
  if (actualAvailable && BigInt(actual.amountMicros) < BigInt(limit.amountMicros)) statuses.push("HEALTHY");
  if (actualAvailable && BigInt(actual.amountMicros) > BigInt(limit.amountMicros)) statuses.push("UNHEALTHY");
  if (actualAvailable && forecastAvailable
    && BigInt(actual.amountMicros) < BigInt(limit.amountMicros)
    && BigInt(forecast.amountMicros) > BigInt(limit.amountMicros)) statuses.push("FORECASTED_UNHEALTHY");
  if (statuses.length === 0) statuses.push("UNCLASSIFIED");
  return { statuses, actualComparisonAvailable: actualAvailable, forecastComparisonAvailable: forecastAvailable };
}

function linkedAccounts(budget: NormalizedAwsBudget): readonly string[] | null {
  const filter = budget.costFilters.find((item) => item.key === "LinkedAccount");
  if (!filter) return null;
  if (filter.values.some((value) => !ACCOUNT_ID.test(value))) return [];
  return filter.values;
}

function mapping(
  accountId: string,
  hierarchy: ReadonlyMap<string, AwsOrganizationHierarchyEvidence["accounts"][number]> | null,
  taxonomy: ReadonlyMap<string, FinopsTaxonomyAssignment> | null,
): AwsBudgetAccountMapping {
  const organization = hierarchy?.get(accountId);
  const assignment = taxonomy?.get(accountId);
  return {
    accountId,
    accountName: organization?.accountName ?? null,
    parentId: organization?.parentId ?? null,
    ouPath: organization?.ouPath ?? [],
    company: assignment?.company ?? null,
    businessUnit: assignment?.businessUnit ?? null,
    environment: assignment?.environment ?? null,
    costCenter: assignment?.costCenter ?? null,
    owner: assignment?.owner ?? null,
    coverage: !organization ? "missing_hierarchy" : !assignment ? "missing_taxonomy" : "complete",
  };
}

export function buildAwsBudgetsOrganizationDashboard(input: {
  readonly snapshot: AwsBudgetsSnapshot;
  readonly taxonomy: FinopsOrganizationTaxonomy | null;
  readonly hierarchy: AwsOrganizationHierarchyEvidence | null;
  readonly query?: AwsBudgetsDashboardQuery;
  readonly nowEpochMs?: number;
}): AwsBudgetsDashboard {
  if (!record(input) || !record(input.snapshot) || !validScope(input.snapshot.scope)) reject("INVALID_DEPENDENCY");
  const nowEpochMs = input.nowEpochMs ?? Date.now();
  if (!Number.isFinite(nowEpochMs)) reject("INVALID_QUERY");
  const hierarchy = validateHierarchy(input.hierarchy, input.snapshot.scope, nowEpochMs);
  const taxonomy = validateTaxonomy(input.taxonomy, input.snapshot.scope, nowEpochMs);
  const query = parseQuery(input.query);
  const accountQueryBlocked = query.accountIds.length > 0 && hierarchy === null;
  const budgetEnumerationComplete = input.snapshot.operationCoverage.find((item) =>
    item.operation === "DescribeBudgets"
  )?.state === "SUCCEEDED";
  const hierarchyAccountIds = hierarchy ? [...hierarchy.keys()].sort(compareText) : [];
  const all = input.snapshot.budgets.map((budget): AwsBudgetsDashboardBudget => {
    const targeted = linkedAccounts(budget);
    const targetIds = targeted === null ? hierarchyAccountIds : targeted;
    const accountMappings = targetIds.map((accountId) => mapping(accountId, hierarchy, taxonomy));
    const unmappedAccountIds = accountMappings.filter((item) => item.coverage === "missing_hierarchy")
      .map((item) => item.accountId);
    const targeting = targeted === null
      ? "organization_wide" as const
      : targeted.length === 0 ? "unresolved" as const : "linked_accounts" as const;
    const mappingCoverage = hierarchy === null || targeting === "unresolved"
      ? "configuration_required" as const
      : accountMappings.every((item) => item.coverage === "complete")
      ? "complete" as const
      : "partial" as const;
    return { budget, targeting, accountMappings, unmappedAccountIds, mappingCoverage, health: budgetHealth(budget) };
  });
  const filtered = all.filter((item) => {
    const budget = item.budget;
    const currencies = [budget.budgetLimit, budget.actual, budget.forecast]
      .filter((value): value is NormalizedAwsBudgetMoney => value !== null)
      .map((value) => value.currency).filter((value): value is string => value !== null);
    return (query.currencies.length === 0 || query.currencies.some((currency) => currencies.includes(currency)))
      && (query.budgetTypes.length === 0 || query.budgetTypes.includes(budget.budgetType))
      && (query.accountIds.length === 0 || query.accountIds.some((accountId) => item.accountMappings.some((entry) => entry.accountId === accountId)))
      && (query.budgetLevels.length === 0 || (budget.hierarchyLevel !== null && query.budgetLevels.includes(budget.hierarchyLevel)))
      && (query.budgetStatuses.length === 0 || query.budgetStatuses.some((status) => item.health.statuses.includes(status)))
      && (query.namePrefix === null || budget.budgetName.startsWith(query.namePrefix))
      && (query.effectiveAtIso === null || (
        Date.parse(budget.effectivePeriod.start) <= Date.parse(query.effectiveAtIso)
        && Date.parse(query.effectiveAtIso) < Date.parse(budget.effectivePeriod.end)
      ));
  });
  if (query.offset > filtered.length) reject("INVALID_QUERY");
  const page = filtered.slice(query.offset, query.offset + query.limit);
  const hasMore = query.offset + page.length < filtered.length;
  const missingHierarchyAccounts = new Set(page.flatMap((item) => item.accountMappings
    .filter((entry) => entry.coverage === "missing_hierarchy").map((entry) => entry.accountId)));
  const missingTaxonomyAccounts = new Set(page.flatMap((item) => item.accountMappings
    .filter((entry) => entry.coverage === "missing_taxonomy").map((entry) => entry.accountId)));
  const state: AwsBudgetsDashboard["state"] = input.snapshot.collectionState === "unavailable"
    ? "unavailable"
    : input.snapshot.collectionState === "configuration_required" || hierarchy === null
    ? "configuration_required"
    : input.snapshot.collectionState === "partial"
      || input.hierarchy?.state !== "complete"
      || taxonomy === null
      || page.some((item) => item.mappingCoverage !== "complete")
    ? "partial"
    : "ready";
  const dashboard: AwsBudgetsDashboard = {
    schemaVersion: "sutra.aws-budgets-dashboard.v1",
    source: "AWS_BUDGETS",
    state,
    sourceEvidence: {
      captureId: input.snapshot.captureId,
      observedAtIso: input.snapshot.observedAtIso,
      dataThroughAt: input.snapshot.dataThroughAt,
      freshness: input.snapshot.freshness,
      taxonomyEvidenceId: input.taxonomy?.evidence.sourceEvidenceId ?? null,
      hierarchyEvidenceId: input.hierarchy?.sourceEvidenceId ?? null,
    },
    coverage: {
      totalAwsBudgets: budgetEnumerationComplete ? input.snapshot.budgets.length : null,
      matchedAwsBudgets: accountQueryBlocked || !budgetEnumerationComplete
        ? null : filtered.length,
      budgetsWithActual: page.filter((item) => item.budget.actual !== null).length,
      budgetsWithForecast: page.filter((item) => item.budget.forecast !== null).length,
      organizationWideBudgets: page.filter((item) => item.targeting === "organization_wide").length,
      linkedAccountBudgets: page.filter((item) => item.targeting === "linked_accounts").length,
      unresolvedBudgets: page.filter((item) => item.targeting === "unresolved").length,
      mappedAccounts: new Set(page.flatMap((item) => item.accountMappings
        .filter((entry) => entry.coverage !== "missing_hierarchy").map((entry) => entry.accountId))).size,
      missingHierarchyAccounts: missingHierarchyAccounts.size,
      missingTaxonomyAccounts: missingTaxonomyAccounts.size,
      currencies: [...new Set(page.flatMap((item) => [
        item.budget.budgetLimit?.currency,
        item.budget.actual?.currency,
        item.budget.forecast?.currency,
      ].filter((value): value is string => value !== null && value !== undefined)))].sort(compareText),
      budgetLevels: [...new Set(page.map((item) => item.budget.hierarchyLevel)
        .filter((value): value is string => value !== null))].sort(compareText),
      healthStatusCounts: {
        HEALTHY: page.filter((item) => item.health.statuses.includes("HEALTHY")).length,
        UNHEALTHY: page.filter((item) => item.health.statuses.includes("UNHEALTHY")).length,
        FORECASTED_UNHEALTHY: page.filter((item) => item.health.statuses.includes("FORECASTED_UNHEALTHY")).length,
        UNCLASSIFIED: page.filter((item) => item.health.statuses.includes("UNCLASSIFIED")).length,
      },
    },
    budgets: page,
    nextCursor: hasMore ? `v1:${query.offset + page.length}` : null,
    internalSutraBudgets: {
      source: "SUTRA_INTERNAL_BUDGETS",
      included: false,
      reason: "Sutra-authored budgets use a separate repository and evidence lineage; they are not AWS Budgets records.",
    },
    limitations: [
      ...input.snapshot.limitations,
      "Organization-wide targeting is projected only when hierarchy evidence is available.",
      "Business ownership is projected only from the canonical, tenant-scoped Sutra taxonomy snapshot.",
      "Budget actions are read-only metadata; this engine never executes, creates, or updates an action.",
      "Budget grouping uses the exact AWS Budgets cid:budget-level tag value and never a name-based hierarchy guess.",
    ],
  };
  if (encodedBytes(dashboard) > AWS_BUDGETS_COLLECTION_BOUNDS.maximumDashboardBytes) reject("RESPONSE_BOUND_EXCEEDED");
  return dashboard;
}
