/**
 * Tenant-scoped normalization and dashboard projection for the AWS Trusted
 * Advisor Public API organization recommendation operations.
 *
 * Important source boundary: the organization operations modeled here expose
 * Trusted Advisor Priority recommendations. They do not prove collection of
 * every standard Trusted Advisor check or of the legacy organizational-view
 * report. Callers must persist the returned evidence beside the snapshot and
 * must not replace the explicit limitations with broader coverage claims.
 *
 * This module is deliberately pure:
 * - it accepts no AWS or web credentials;
 * - it performs no network or database I/O;
 * - the caller supplies the authoritative server-derived tenant scope;
 * - every capture, page, record, byte, and elapsed-time dimension is bounded;
 * - pagination must be a continuous, replay-free chain;
 * - duplicates are deterministic and conflicting duplicates fail closed.
 */
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CAPTURE_ID = /^tac_[a-f0-9]{64}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const RECOMMENDATION_ARN =
  /^arn:[\w-]+:trustedadvisor:::organization-recommendation\/[\w-]+$/u;
const ACCOUNT_RECOMMENDATION_ARN =
  /^arn:[\w-]+:trustedadvisor::(\d{12}):recommendation\/[\w-]+$/u;
const RESOURCE_ARN =
  /^arn:[\w-]+:trustedadvisor::(\d{12}):recommendation-resource\/[\w-]+\/[\w-]+$/u;
const CHECK_ARN = /^arn:[\w-]+:trustedadvisor:::check\/[\w-]+$/u;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS = Object.freeze({
  apiPageSize: 200,
  maximumDurationMs: 15 * 60 * 1_000,
  maximumCaptureBytes: 32 * 1_024 * 1_024,
  maximumPages: 20_000,
  maximumRecommendations: 5_000,
  maximumAccountLifecycles: 50_000,
  maximumResources: 100_000,
  maximumMetadataEntriesPerResource: 100,
  maximumDashboardInputBytes: 64 * 1_024 * 1_024,
  maximumDashboardHistoryRecords: 250_000,
  maximumDashboardRecommendations: 200,
  maximumDashboardAccounts: 200,
  maximumDashboardResources: 200,
  maximumHistorySnapshots: 36,
} as const);

export const TRUSTED_ADVISOR_ORGANIZATION_API_OPERATIONS = Object.freeze([
  "trustedadvisor:GetOrganizationRecommendation",
  "trustedadvisor:ListOrganizationRecommendationAccounts",
  "trustedadvisor:ListOrganizationRecommendationResources",
  "trustedadvisor:ListOrganizationRecommendations",
] as const);

export type TrustedAdvisorPillar =
  | "cost_optimizing"
  | "performance"
  | "security"
  | "service_limits"
  | "fault_tolerance"
  | "operational_excellence";

export type TrustedAdvisorRecommendationSource =
  | "aws_config"
  | "compute_optimizer"
  | "cost_explorer"
  | "lse"
  | "manual"
  | "pse"
  | "rds"
  | "resilience"
  | "resilience_hub"
  | "security_hub"
  | "stir"
  | "ta_check"
  | "well_architected"
  | "cost_optimization_hub";

export type TrustedAdvisorStatus = "ok" | "warning" | "error";
export type TrustedAdvisorRecommendationType = "standard" | "priority";
export type TrustedAdvisorLifecycleStage =
  | "in_progress"
  | "pending_response"
  | "dismissed"
  | "resolved";
export type TrustedAdvisorExclusionStatus = "excluded" | "included";
export type TrustedAdvisorUpdateReasonCode =
  | "non_critical_account"
  | "temporary_account"
  | "valid_business_case"
  | "other_methods_available"
  | "low_priority"
  | "not_applicable"
  | "other";

export type TrustedAdvisorQualifyingSupportPlan =
  | "business_support_plus"
  | "enterprise"
  | "unified_operations"
  | "unknown"
  | "not_qualifying";

export type TrustedAdvisorOrganizationCollectorAccount =
  | "management"
  | "delegated_administrator"
  | "member"
  | "unknown";

export interface TrustedAdvisorOrganizationPrerequisites {
  /** Priority requires Enterprise Support or AWS Unified Operations. */
  readonly supportPlan: TrustedAdvisorQualifyingSupportPlan;
  readonly organizationsAllFeaturesEnabled: boolean;
  readonly trustedAdvisorTrustedAccessEnabled: boolean;
  readonly trustedAdvisorPriorityEnabled: boolean;
  readonly collectorAccountType: TrustedAdvisorOrganizationCollectorAccount;
  /** The four read operations were successfully authorization-tested. */
  readonly readPermissionsValidated: boolean;
}

export interface TrustedAdvisorResourcesAggregates {
  readonly errorCount: number;
  readonly excludedCount?: number;
  readonly okCount: number;
  readonly warningCount: number;
}

export interface TrustedAdvisorCostOptimizingAggregate {
  /**
   * AWS returns a number but no currency in this API object. Sutra keeps the
   * value recommendation-local and never totals it across recommendations.
   */
  readonly estimatedMonthlySavings?: number;
  readonly estimatedPercentMonthlySavings?: number;
}

export interface AwsOrganizationRecommendationSummary {
  readonly arn: string;
  readonly awsServices?: readonly string[];
  readonly checkArn?: string;
  readonly createdAt?: string;
  readonly id: string;
  readonly lastUpdatedAt?: string;
  readonly lifecycleStage?: TrustedAdvisorLifecycleStage;
  readonly name: string;
  readonly pillars: readonly TrustedAdvisorPillar[];
  readonly pillarSpecificAggregates?: {
    readonly costOptimizing?: TrustedAdvisorCostOptimizingAggregate;
  };
  readonly resourcesAggregates: TrustedAdvisorResourcesAggregates;
  readonly source: TrustedAdvisorRecommendationSource;
  readonly status: TrustedAdvisorStatus;
  readonly type: TrustedAdvisorRecommendationType;
}

export interface AwsOrganizationRecommendation
  extends AwsOrganizationRecommendationSummary {
  readonly createdBy?: string;
  readonly description: string;
  readonly resolvedAt?: string;
  readonly updatedOnBehalfOf?: string;
  readonly updatedOnBehalfOfJobTitle?: string;
  readonly updateReason?: string;
  readonly updateReasonCode?: TrustedAdvisorUpdateReasonCode;
}

export interface AwsAccountRecommendationLifecycleSummary {
  readonly accountId?: string;
  readonly accountRecommendationArn?: string;
  readonly lastUpdatedAt?: string;
  readonly lifecycleStage?: TrustedAdvisorLifecycleStage;
  readonly updatedOnBehalfOf?: string;
  readonly updatedOnBehalfOfJobTitle?: string;
  readonly updateReason?: string;
  readonly updateReasonCode?: TrustedAdvisorUpdateReasonCode;
}

export interface AwsOrganizationRecommendationResourceSummary {
  readonly accountId?: string;
  readonly arn: string;
  readonly awsResourceId: string;
  readonly exclusionStatus?: TrustedAdvisorExclusionStatus;
  readonly id: string;
  readonly lastUpdatedAt: string;
  readonly metadata: Readonly<Record<string, string>>;
  readonly recommendationArn: string;
  readonly regionCode: string;
  readonly status: TrustedAdvisorStatus;
}

interface TrustedAdvisorPageRequest {
  readonly maxResults: number;
  readonly nextToken: string | null;
}

export interface TrustedAdvisorRecommendationPage {
  readonly request: TrustedAdvisorPageRequest & {
    readonly afterLastUpdatedAt: null;
    readonly awsService: null;
    readonly beforeLastUpdatedAt: null;
    readonly checkIdentifier: null;
    readonly pillar: null;
    readonly source: null;
    readonly status: null;
    readonly type: null;
  };
  readonly response: {
    readonly organizationRecommendationSummaries:
      readonly AwsOrganizationRecommendationSummary[];
    readonly nextToken: string | null;
  };
}

export interface TrustedAdvisorAccountPage {
  readonly request: TrustedAdvisorPageRequest & {
    readonly affectedAccountId: null;
  };
  readonly response: {
    readonly accountRecommendationLifecycleSummaries:
      readonly AwsAccountRecommendationLifecycleSummary[];
    readonly nextToken: string | null;
  };
}

export interface TrustedAdvisorResourcePage {
  readonly request: TrustedAdvisorPageRequest & {
    readonly affectedAccountId: null;
    readonly exclusionStatus: null;
    readonly regionCode: null;
    readonly status: null;
  };
  readonly response: {
    readonly organizationRecommendationResourceSummaries:
      readonly AwsOrganizationRecommendationResourceSummary[];
    readonly nextToken: string | null;
  };
}

export interface TrustedAdvisorRecommendationPageSequence {
  readonly pages: readonly TrustedAdvisorRecommendationPage[];
  /** False means collection stopped at a declared Sutra bound. */
  readonly exhausted: boolean;
}

export interface TrustedAdvisorAccountPageSequence {
  readonly recommendationArn: string;
  readonly pages: readonly TrustedAdvisorAccountPage[];
  readonly exhausted: boolean;
}

export interface TrustedAdvisorResourcePageSequence {
  readonly recommendationArn: string;
  readonly pages: readonly TrustedAdvisorResourcePage[];
  readonly exhausted: boolean;
}

export interface TrustedAdvisorOrganizationCapture {
  readonly scope: FinopsSourceScope;
  readonly captureId: string;
  readonly startedAtIso: string;
  readonly completedAtIso: string;
  readonly prerequisites: TrustedAdvisorOrganizationPrerequisites;
  readonly recommendations: TrustedAdvisorRecommendationPageSequence;
  /** One GetOrganizationRecommendation response for each listed ARN. */
  readonly recommendationDetails: readonly AwsOrganizationRecommendation[];
  readonly accounts: readonly TrustedAdvisorAccountPageSequence[];
  readonly resources: readonly TrustedAdvisorResourcePageSequence[];
}

export interface TrustedAdvisorMetadataEntry {
  readonly key: string;
  readonly value: string;
}

export interface TrustedAdvisorNormalizedAccountLifecycle {
  readonly accountId: string | null;
  readonly accountRecommendationArn: string | null;
  readonly lastUpdatedAt: string | null;
  readonly lifecycleStage: TrustedAdvisorLifecycleStage | null;
  readonly updatedOnBehalfOf: string | null;
  readonly updatedOnBehalfOfJobTitle: string | null;
  readonly updateReason: string | null;
  readonly updateReasonCode: TrustedAdvisorUpdateReasonCode | null;
}

export interface TrustedAdvisorNormalizedResource {
  readonly accountId: string | null;
  readonly arn: string;
  readonly awsResourceId: string;
  readonly exclusionStatus: TrustedAdvisorExclusionStatus | null;
  readonly id: string;
  readonly lastUpdatedAt: string;
  readonly metadata: readonly TrustedAdvisorMetadataEntry[];
  readonly recommendationArn: string;
  readonly regionCode: string;
  readonly status: TrustedAdvisorStatus;
}

export interface TrustedAdvisorNormalizedRecommendation {
  readonly arn: string;
  readonly awsServices: readonly string[];
  readonly checkArn: string | null;
  readonly createdAt: string | null;
  readonly createdBy: string | null;
  readonly description: string;
  readonly id: string;
  readonly lastUpdatedAt: string | null;
  readonly lifecycleStage: TrustedAdvisorLifecycleStage | null;
  readonly name: string;
  readonly pillars: readonly TrustedAdvisorPillar[];
  readonly recommendationType: TrustedAdvisorRecommendationType;
  readonly resolvedAt: string | null;
  readonly source: TrustedAdvisorRecommendationSource;
  readonly status: TrustedAdvisorStatus;
  readonly updateReason: string | null;
  readonly updateReasonCode: TrustedAdvisorUpdateReasonCode | null;
  readonly updatedOnBehalfOf: string | null;
  readonly updatedOnBehalfOfJobTitle: string | null;
  readonly awsResourceAggregates: {
    readonly errorCount: number;
    readonly excludedCount: number | null;
    readonly okCount: number;
    readonly warningCount: number;
  };
  readonly costOptimizing: {
    readonly estimatedMonthlySavings: number | null;
    readonly estimatedPercentMonthlySavings: number | null;
    readonly currency: null;
    readonly aggregationAllowed: false;
  } | null;
  readonly accounts: readonly TrustedAdvisorNormalizedAccountLifecycle[];
  readonly resources: readonly TrustedAdvisorNormalizedResource[];
  readonly drilldownEvidence: {
    readonly accountPagesExhausted: boolean;
    readonly resourcePagesExhausted: boolean;
    readonly resourceAggregateReconciled: boolean;
    readonly observedResourceStatusCounts: Readonly<
      Record<TrustedAdvisorStatus, number>
    >;
  };
}

export interface TrustedAdvisorOrganizationSnapshot {
  readonly scope: FinopsSourceScope;
  readonly sourceId: "trusted_advisor_organization";
  readonly captureId: string;
  readonly observedAtIso: string;
  readonly collectionStartedAtIso: string;
  readonly collectionDurationMs: number;
  readonly prerequisites: TrustedAdvisorOrganizationPrerequisites;
  readonly coverage: {
    readonly assessment: "complete" | "partial";
    readonly recommendationPagesExhausted: boolean;
    readonly recommendationCount: number;
    readonly accountLifecycleCount: number;
    readonly resourceCount: number;
    readonly allDetailsObserved: boolean;
    readonly allAccountPagesExhausted: boolean;
    readonly allResourcePagesExhausted: boolean;
    readonly allResourceAggregatesReconciled: boolean;
  };
  readonly recommendations: readonly TrustedAdvisorNormalizedRecommendation[];
  readonly evidence: {
    readonly apiOperations: typeof TRUSTED_ADVISOR_ORGANIZATION_API_OPERATIONS;
    readonly apiScope: "organization_priority_recommendations";
    readonly apiIsGlobalRecommendationView: true;
    readonly captureBytes: number;
    readonly pageCount: number;
    readonly limitations: readonly string[];
  };
}

export type TrustedAdvisorOrganizationFailureCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "BYTE_LIMIT_EXCEEDED"
  | "TIME_LIMIT_EXCEEDED"
  | "PAGE_LIMIT_EXCEEDED"
  | "RECORD_LIMIT_EXCEEDED"
  | "INVALID_PAGINATION"
  | "CONFLICTING_DUPLICATE"
  | "INCOMPLETE_DRILLDOWN";

export class TrustedAdvisorOrganizationError extends Error {
  public readonly code: TrustedAdvisorOrganizationFailureCode;

  public constructor(code: TrustedAdvisorOrganizationFailureCode) {
    super("Trusted Advisor organization evidence rejected");
    this.name = "TrustedAdvisorOrganizationError";
    this.code = code;
  }
}

const PILLARS = new Set<TrustedAdvisorPillar>([
  "cost_optimizing",
  "performance",
  "security",
  "service_limits",
  "fault_tolerance",
  "operational_excellence",
]);
const SOURCES = new Set<TrustedAdvisorRecommendationSource>([
  "aws_config",
  "compute_optimizer",
  "cost_explorer",
  "lse",
  "manual",
  "pse",
  "rds",
  "resilience",
  "resilience_hub",
  "security_hub",
  "stir",
  "ta_check",
  "well_architected",
  "cost_optimization_hub",
]);
const STATUSES = new Set<TrustedAdvisorStatus>(["ok", "warning", "error"]);
const RECOMMENDATION_TYPES = new Set<TrustedAdvisorRecommendationType>([
  "standard",
  "priority",
]);
const LIFECYCLE_STAGES = new Set<TrustedAdvisorLifecycleStage>([
  "in_progress",
  "pending_response",
  "dismissed",
  "resolved",
]);
const EXCLUSION_STATUSES = new Set<TrustedAdvisorExclusionStatus>([
  "excluded",
  "included",
]);
const REASON_CODES = new Set<TrustedAdvisorUpdateReasonCode>([
  "non_critical_account",
  "temporary_account",
  "valid_business_case",
  "other_methods_available",
  "low_priority",
  "not_applicable",
  "other",
]);
const SUPPORT_PLANS = new Set<TrustedAdvisorQualifyingSupportPlan>([
  "business_support_plus",
  "enterprise",
  "unified_operations",
  "unknown",
  "not_qualifying",
]);
const COLLECTOR_ACCOUNT_TYPES =
  new Set<TrustedAdvisorOrganizationCollectorAccount>([
    "management",
    "delegated_administrator",
    "member",
    "unknown",
  ]);

function reject(code: TrustedAdvisorOrganizationFailureCode): never {
  throw new TrustedAdvisorOrganizationError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(
  value: unknown,
  maximumLength: number,
  allowEmpty = false,
): value is string {
  return typeof value === "string"
    && (allowEmpty || value.length > 0)
    && value.length <= maximumLength
    && !value.includes("\0");
}

function optionalText(
  value: unknown,
  maximumLength: number,
): value is string | undefined {
  return value === undefined || validText(value, maximumLength);
}

function iso(value: unknown): string | null {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) return null;
  return new Date(value).toISOString();
}

function optionalIso(value: unknown): string | null {
  if (value === undefined) return null;
  return iso(value);
}

function boundedInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function optionalFiniteNonNegative(
  value: unknown,
): value is number | undefined {
  return value === undefined
    || (typeof value === "number" && Number.isFinite(value) && value >= 0);
}

function validScope(scope: unknown): scope is FinopsSourceScope {
  return isRecord(scope)
    && typeof scope.orgId === "string"
    && IDENTIFIER.test(scope.orgId)
    && typeof scope.customerId === "string"
    && IDENTIFIER.test(scope.customerId)
    && typeof scope.connectionId === "string"
    && IDENTIFIER.test(scope.connectionId);
}

function sameScope(
  left: FinopsSourceScope,
  right: FinopsSourceScope,
): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function boundedJsonByteLength(value: unknown, maximumBytes: number): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    reject("INVALID_INPUT");
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > maximumBytes) reject("BYTE_LIMIT_EXCEEDED");
  return bytes;
}

function validatePrerequisites(
  value: unknown,
): asserts value is TrustedAdvisorOrganizationPrerequisites {
  if (
    !isRecord(value)
    || typeof value.supportPlan !== "string"
    || !SUPPORT_PLANS.has(
      value.supportPlan as TrustedAdvisorQualifyingSupportPlan,
    )
    || typeof value.organizationsAllFeaturesEnabled !== "boolean"
    || typeof value.trustedAdvisorTrustedAccessEnabled !== "boolean"
    || typeof value.trustedAdvisorPriorityEnabled !== "boolean"
    || typeof value.collectorAccountType !== "string"
    || !COLLECTOR_ACCOUNT_TYPES.has(
      value.collectorAccountType as
        TrustedAdvisorOrganizationCollectorAccount,
    )
    || typeof value.readPermissionsValidated !== "boolean"
  ) reject("INVALID_INPUT");
}

function validToken(value: unknown): value is string | null {
  return value === null
    || (
      typeof value === "string"
      && value.length >= 4
      && value.length <= 10_000
      && !value.includes("\0")
    );
}

function validateBaseRequest(
  request: unknown,
): asserts request is TrustedAdvisorPageRequest {
  if (
    !isRecord(request)
    || request.maxResults
      !== TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.apiPageSize
    || !validToken(request.nextToken)
  ) reject("INVALID_INPUT");
}

function validateNullFields(
  request: Readonly<Record<string, unknown>>,
  fields: readonly string[],
): void {
  if (fields.some((field) => request[field] !== null)) {
    reject("INVALID_INPUT");
  }
}

function validatePageChain<T extends {
  readonly request: TrustedAdvisorPageRequest;
  readonly response: { readonly nextToken: string | null };
}>(
  pages: readonly T[],
  exhausted: boolean,
): void {
  if (pages.length === 0) reject("INVALID_PAGINATION");
  let expectedRequestToken: string | null = null;
  const seenTokens = new Set<string>();
  for (const page of pages) {
    validateBaseRequest(page.request);
    if (!isRecord(page.response) || !validToken(page.response.nextToken)) {
      reject("INVALID_INPUT");
    }
    if (page.request.nextToken !== expectedRequestToken) {
      reject("INVALID_PAGINATION");
    }
    if (
      page.request.nextToken !== null
      && seenTokens.has(page.request.nextToken)
    ) reject("INVALID_PAGINATION");
    if (page.request.nextToken !== null) seenTokens.add(page.request.nextToken);
    if (
      page.response.nextToken !== null
      && seenTokens.has(page.response.nextToken)
    ) reject("INVALID_PAGINATION");
    expectedRequestToken = page.response.nextToken;
  }
  if (exhausted !== (expectedRequestToken === null)) {
    reject("INVALID_PAGINATION");
  }
}

function normalizeResourcesAggregates(
  value: unknown,
): TrustedAdvisorNormalizedRecommendation["awsResourceAggregates"] {
  if (
    !isRecord(value)
    || !boundedInteger(value.errorCount)
    || !boundedInteger(value.okCount)
    || !boundedInteger(value.warningCount)
    || (
      value.excludedCount !== undefined
      && !boundedInteger(value.excludedCount)
    )
  ) reject("INVALID_INPUT");
  return {
    errorCount: value.errorCount,
    excludedCount: value.excludedCount === undefined
      ? null
      : value.excludedCount,
    okCount: value.okCount,
    warningCount: value.warningCount,
  };
}

function sortedUniqueText(
  value: unknown,
  maximumItems: number,
  maximumLength: number,
): readonly string[] {
  if (
    !Array.isArray(value)
    || value.length > maximumItems
    || !value.every((item) => validText(item, maximumLength))
  ) reject("INVALID_INPUT");
  return [...new Set(value)].sort((left, right) => left.localeCompare(right));
}

interface CommonRecommendationFields {
  readonly arn: string;
  readonly awsServices: readonly string[];
  readonly checkArn: string | null;
  readonly createdAt: string | null;
  readonly id: string;
  readonly lastUpdatedAt: string | null;
  readonly lifecycleStage: TrustedAdvisorLifecycleStage | null;
  readonly name: string;
  readonly pillars: readonly TrustedAdvisorPillar[];
  readonly source: TrustedAdvisorRecommendationSource;
  readonly status: TrustedAdvisorStatus;
  readonly recommendationType: TrustedAdvisorRecommendationType;
  readonly resourcesAggregates:
    TrustedAdvisorNormalizedRecommendation["awsResourceAggregates"];
  readonly costOptimizing:
    TrustedAdvisorNormalizedRecommendation["costOptimizing"];
}

function normalizeCommonRecommendation(
  value: unknown,
): CommonRecommendationFields {
  if (
    !isRecord(value)
    || !validText(value.arn, 200)
    || !RECOMMENDATION_ARN.test(value.arn)
    || !validText(value.id, 256)
    || !validText(value.name, 1_024)
    || !Array.isArray(value.pillars)
    || value.pillars.length < 1
    || value.pillars.length > 50
    || !value.pillars.every((pillar) =>
      typeof pillar === "string"
      && PILLARS.has(pillar as TrustedAdvisorPillar)
    )
    || typeof value.source !== "string"
    || !SOURCES.has(value.source as TrustedAdvisorRecommendationSource)
    || typeof value.status !== "string"
    || !STATUSES.has(value.status as TrustedAdvisorStatus)
    || typeof value.type !== "string"
    || !RECOMMENDATION_TYPES.has(
      value.type as TrustedAdvisorRecommendationType,
    )
    || !optionalText(value.checkArn, 64)
    || (
      value.checkArn !== undefined
      && !CHECK_ARN.test(value.checkArn)
    )
    || (
      value.lifecycleStage !== undefined
      && (
        typeof value.lifecycleStage !== "string"
        || !LIFECYCLE_STAGES.has(
          value.lifecycleStage as TrustedAdvisorLifecycleStage,
        )
      )
    )
    || (
      value.createdAt !== undefined
      && iso(value.createdAt) === null
    )
    || (
      value.lastUpdatedAt !== undefined
      && iso(value.lastUpdatedAt) === null
    )
  ) reject("INVALID_INPUT");

  const awsServices = value.awsServices === undefined
    ? []
    : sortedUniqueText(value.awsServices, 50, 30);
  const pillars = [...new Set(value.pillars as TrustedAdvisorPillar[])]
    .sort((left, right) => left.localeCompare(right));
  const resourcesAggregates =
    normalizeResourcesAggregates(value.resourcesAggregates);

  let costOptimizing:
    TrustedAdvisorNormalizedRecommendation["costOptimizing"] = null;
  if (value.pillarSpecificAggregates !== undefined) {
    if (!isRecord(value.pillarSpecificAggregates)) reject("INVALID_INPUT");
    const aggregate = value.pillarSpecificAggregates.costOptimizing;
    if (aggregate !== undefined) {
      if (
        !isRecord(aggregate)
        || !optionalFiniteNonNegative(aggregate.estimatedMonthlySavings)
        || !optionalFiniteNonNegative(
          aggregate.estimatedPercentMonthlySavings,
        )
      ) reject("INVALID_INPUT");
      costOptimizing = {
        estimatedMonthlySavings:
          aggregate.estimatedMonthlySavings === undefined
            ? null
            : aggregate.estimatedMonthlySavings,
        estimatedPercentMonthlySavings:
          aggregate.estimatedPercentMonthlySavings === undefined
            ? null
            : aggregate.estimatedPercentMonthlySavings,
        currency: null,
        aggregationAllowed: false,
      };
    }
  }

  return {
    arn: value.arn,
    awsServices,
    checkArn: value.checkArn ?? null,
    createdAt: optionalIso(value.createdAt) ?? null,
    id: value.id,
    lastUpdatedAt: optionalIso(value.lastUpdatedAt) ?? null,
    lifecycleStage:
      (value.lifecycleStage as TrustedAdvisorLifecycleStage | undefined)
        ?? null,
    name: value.name,
    pillars,
    source: value.source as TrustedAdvisorRecommendationSource,
    status: value.status as TrustedAdvisorStatus,
    recommendationType: value.type as TrustedAdvisorRecommendationType,
    resourcesAggregates,
    costOptimizing,
  };
}

function normalizeSummary(
  value: unknown,
): CommonRecommendationFields {
  return normalizeCommonRecommendation(value);
}

interface NormalizedDetailFields extends CommonRecommendationFields {
  readonly createdBy: string | null;
  readonly description: string;
  readonly resolvedAt: string | null;
  readonly updatedOnBehalfOf: string | null;
  readonly updatedOnBehalfOfJobTitle: string | null;
  readonly updateReason: string | null;
  readonly updateReasonCode: TrustedAdvisorUpdateReasonCode | null;
}

function normalizeDetail(value: unknown): NormalizedDetailFields {
  const common = normalizeCommonRecommendation(value);
  if (
    !isRecord(value)
    || !validText(value.description, 16_384)
    || !optionalText(value.createdBy, 1_024)
    || !optionalText(value.updatedOnBehalfOf, 1_024)
    || !optionalText(value.updatedOnBehalfOfJobTitle, 1_024)
    || !optionalText(value.updateReason, 4_096)
    || (
      value.updateReasonCode !== undefined
      && (
        typeof value.updateReasonCode !== "string"
        || !REASON_CODES.has(
          value.updateReasonCode as TrustedAdvisorUpdateReasonCode,
        )
      )
    )
    || (
      value.resolvedAt !== undefined
      && iso(value.resolvedAt) === null
    )
  ) reject("INVALID_INPUT");
  return {
    ...common,
    createdBy: value.createdBy ?? null,
    description: value.description,
    resolvedAt: optionalIso(value.resolvedAt) ?? null,
    updatedOnBehalfOf: value.updatedOnBehalfOf ?? null,
    updatedOnBehalfOfJobTitle: value.updatedOnBehalfOfJobTitle ?? null,
    updateReason: value.updateReason ?? null,
    updateReasonCode:
      (value.updateReasonCode as TrustedAdvisorUpdateReasonCode | undefined)
        ?? null,
  };
}

function recommendationCommonSignature(
  recommendation: CommonRecommendationFields,
): string {
  return JSON.stringify({
    arn: recommendation.arn,
    awsServices: recommendation.awsServices,
    checkArn: recommendation.checkArn,
    createdAt: recommendation.createdAt,
    id: recommendation.id,
    lastUpdatedAt: recommendation.lastUpdatedAt,
    lifecycleStage: recommendation.lifecycleStage,
    name: recommendation.name,
    pillars: recommendation.pillars,
    source: recommendation.source,
    status: recommendation.status,
    recommendationType: recommendation.recommendationType,
    resourcesAggregates: recommendation.resourcesAggregates,
    costOptimizing: recommendation.costOptimizing,
  });
}

function normalizeAccountLifecycle(
  value: unknown,
): TrustedAdvisorNormalizedAccountLifecycle {
  if (
    !isRecord(value)
    || (
      value.accountId !== undefined
      && (
        typeof value.accountId !== "string"
        || !ACCOUNT_ID.test(value.accountId)
      )
    )
    || (
      value.accountRecommendationArn !== undefined
      && (
        !validText(value.accountRecommendationArn, 2_048)
        || !ACCOUNT_RECOMMENDATION_ARN.test(
          value.accountRecommendationArn,
        )
      )
    )
    || (
      value.accountId === undefined
      && value.accountRecommendationArn === undefined
    )
    || (
      value.lifecycleStage !== undefined
      && (
        typeof value.lifecycleStage !== "string"
        || !LIFECYCLE_STAGES.has(
          value.lifecycleStage as TrustedAdvisorLifecycleStage,
        )
      )
    )
    || !optionalText(value.updatedOnBehalfOf, 1_024)
    || !optionalText(value.updatedOnBehalfOfJobTitle, 1_024)
    || !optionalText(value.updateReason, 4_096)
    || (
      value.updateReasonCode !== undefined
      && (
        typeof value.updateReasonCode !== "string"
        || !REASON_CODES.has(
          value.updateReasonCode as TrustedAdvisorUpdateReasonCode,
        )
      )
    )
    || (
      value.lastUpdatedAt !== undefined
      && iso(value.lastUpdatedAt) === null
    )
  ) reject("INVALID_INPUT");

  const arnAccount = value.accountRecommendationArn === undefined
    ? null
    : ACCOUNT_RECOMMENDATION_ARN.exec(value.accountRecommendationArn)?.[1]
      ?? null;
  if (
    value.accountId !== undefined
    && arnAccount !== null
    && arnAccount !== value.accountId
  ) reject("INVALID_INPUT");

  return {
    accountId: value.accountId ?? arnAccount,
    accountRecommendationArn: value.accountRecommendationArn ?? null,
    lastUpdatedAt: optionalIso(value.lastUpdatedAt) ?? null,
    lifecycleStage:
      (value.lifecycleStage as TrustedAdvisorLifecycleStage | undefined)
        ?? null,
    updatedOnBehalfOf: value.updatedOnBehalfOf ?? null,
    updatedOnBehalfOfJobTitle: value.updatedOnBehalfOfJobTitle ?? null,
    updateReason: value.updateReason ?? null,
    updateReasonCode:
      (value.updateReasonCode as TrustedAdvisorUpdateReasonCode | undefined)
        ?? null,
  };
}

function normalizeResource(
  value: unknown,
): TrustedAdvisorNormalizedResource {
  if (
    !isRecord(value)
    || !validText(value.arn, 2_048)
    || !RESOURCE_ARN.test(value.arn)
    || !validText(value.awsResourceId, 4_096, true)
    || !validText(value.id, 512)
    || iso(value.lastUpdatedAt) === null
    || !isRecord(value.metadata)
    || Object.keys(value.metadata).length
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
        .maximumMetadataEntriesPerResource
    || !Object.entries(value.metadata).every(([key, entry]) =>
      validText(key, 256, true) && validText(entry, 4_096, true)
    )
    || !validText(value.recommendationArn, 200)
    || !RECOMMENDATION_ARN.test(value.recommendationArn)
    || !validText(value.regionCode, 20)
    || value.regionCode.length < 9
    || typeof value.status !== "string"
    || !STATUSES.has(value.status as TrustedAdvisorStatus)
    || (
      value.accountId !== undefined
      && (
        typeof value.accountId !== "string"
        || !ACCOUNT_ID.test(value.accountId)
      )
    )
    || (
      value.exclusionStatus !== undefined
      && (
        typeof value.exclusionStatus !== "string"
        || !EXCLUSION_STATUSES.has(
          value.exclusionStatus as TrustedAdvisorExclusionStatus,
        )
      )
    )
  ) reject("INVALID_INPUT");
  const arnAccount = RESOURCE_ARN.exec(value.arn)?.[1] ?? null;
  if (
    value.accountId !== undefined
    && arnAccount !== value.accountId
  ) reject("INVALID_INPUT");
  return {
    accountId: value.accountId ?? arnAccount,
    arn: value.arn,
    awsResourceId: value.awsResourceId,
    exclusionStatus:
      (value.exclusionStatus as TrustedAdvisorExclusionStatus | undefined)
        ?? null,
    id: value.id,
    lastUpdatedAt: iso(value.lastUpdatedAt) as string,
    metadata: Object.entries(value.metadata)
      .map(([key, entry]) => ({ key, value: entry as string }))
      .sort((left, right) =>
        left.key.localeCompare(right.key)
        || left.value.localeCompare(right.value)
      ),
    recommendationArn: value.recommendationArn,
    regionCode: value.regionCode,
    status: value.status as TrustedAdvisorStatus,
  };
}

function addDeterministic<T>(
  map: Map<string, T>,
  key: string,
  value: T,
): void {
  const previous = map.get(key);
  if (previous === undefined) {
    map.set(key, value);
    return;
  }
  if (JSON.stringify(previous) !== JSON.stringify(value)) {
    reject("CONFLICTING_DUPLICATE");
  }
}

function prerequisitesSatisfied(
  prerequisites: TrustedAdvisorOrganizationPrerequisites,
): boolean {
  return (
    (
      prerequisites.supportPlan === "enterprise"
      || prerequisites.supportPlan === "unified_operations"
    )
    && prerequisites.organizationsAllFeaturesEnabled
    && prerequisites.trustedAdvisorTrustedAccessEnabled
    && prerequisites.trustedAdvisorPriorityEnabled
    && (
      prerequisites.collectorAccountType === "management"
      || prerequisites.collectorAccountType === "delegated_administrator"
    )
    && prerequisites.readPermissionsValidated
  );
}

function prerequisiteLimitations(
  prerequisites: TrustedAdvisorOrganizationPrerequisites,
): string[] {
  const limitations: string[] = [];
  if (
    prerequisites.supportPlan !== "enterprise"
    && prerequisites.supportPlan !== "unified_operations"
  ) {
    limitations.push(
      "Trusted Advisor Priority entitlement requires Enterprise Support or AWS Unified Operations; that qualifying plan was not proven.",
    );
  }
  if (!prerequisites.organizationsAllFeaturesEnabled) {
    limitations.push(
      "AWS Organizations all-features mode was not proven.",
    );
  }
  if (!prerequisites.trustedAdvisorTrustedAccessEnabled) {
    limitations.push(
      "Trusted access between AWS Organizations and Trusted Advisor was not proven.",
    );
  }
  if (!prerequisites.trustedAdvisorPriorityEnabled) {
    limitations.push("Trusted Advisor Priority enablement was not proven.");
  }
  if (
    prerequisites.collectorAccountType !== "management"
    && prerequisites.collectorAccountType !== "delegated_administrator"
  ) {
    limitations.push(
      "Collection from the management account or a delegated administrator was not proven.",
    );
  }
  if (!prerequisites.readPermissionsValidated) {
    limitations.push(
      "Required Trusted Advisor organization read permissions were not validated.",
    );
  }
  return limitations;
}

function recordCountFromPages<T>(
  pages: readonly T[],
  rows: (page: T) => readonly unknown[],
): number {
  return pages.reduce((total, page) => total + rows(page).length, 0);
}

/**
 * Convert one bounded, unfiltered AWS API capture into a canonical snapshot.
 * Invalid input is rejected with a generic error; no AWS response body or
 * tenant identifier is copied into an exception message.
 */
export function normalizeTrustedAdvisorOrganizationCapture(
  input: TrustedAdvisorOrganizationCapture,
  nowMs = Date.now(),
): TrustedAdvisorOrganizationSnapshot {
  if (
    !isRecord(input)
    || !validScope(input.scope)
    || !validText(input.captureId, 68)
    || !CAPTURE_ID.test(input.captureId)
    || !Number.isFinite(nowMs)
    || !Array.isArray(input.recommendationDetails)
    || !Array.isArray(input.accounts)
    || !Array.isArray(input.resources)
    || !isRecord(input.recommendations)
    || !Array.isArray(input.recommendations.pages)
    || typeof input.recommendations.exhausted !== "boolean"
  ) reject("INVALID_INPUT");

  const captureBytes = boundedJsonByteLength(
    input,
    TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.maximumCaptureBytes,
  );
  validatePrerequisites(input.prerequisites);
  const startedAt = iso(input.startedAtIso);
  const completedAt = iso(input.completedAtIso);
  if (startedAt === null || completedAt === null) reject("INVALID_INPUT");
  const startedMs = Date.parse(startedAt);
  const completedMs = Date.parse(completedAt);
  const durationMs = completedMs - startedMs;
  if (durationMs < 0) reject("INVALID_INPUT");
  if (
    durationMs
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.maximumDurationMs
    || completedMs > nowMs + MAX_CLOCK_SKEW_MS
  ) reject("TIME_LIMIT_EXCEEDED");

  validatePageChain(
    input.recommendations.pages,
    input.recommendations.exhausted,
  );
  for (const page of input.recommendations.pages) {
    if (!isRecord(page.request)) reject("INVALID_INPUT");
    validateNullFields(page.request, [
      "afterLastUpdatedAt",
      "awsService",
      "beforeLastUpdatedAt",
      "checkIdentifier",
      "pillar",
      "source",
      "status",
      "type",
    ]);
    if (
      !isRecord(page.response)
      || !Array.isArray(
        page.response.organizationRecommendationSummaries,
      )
      || page.response.organizationRecommendationSummaries.length
        > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.apiPageSize
    ) reject("INVALID_INPUT");
  }

  let pageCount = input.recommendations.pages.length;
  let accountLifecycleCount = 0;
  let resourceCount = 0;
  for (const sequence of input.accounts) {
    if (
      !isRecord(sequence)
      || !validText(sequence.recommendationArn, 200)
      || !RECOMMENDATION_ARN.test(sequence.recommendationArn)
      || !Array.isArray(sequence.pages)
      || typeof sequence.exhausted !== "boolean"
    ) reject("INVALID_INPUT");
    validatePageChain(sequence.pages, sequence.exhausted);
    pageCount += sequence.pages.length;
    accountLifecycleCount += recordCountFromPages(
      sequence.pages,
      (page) => {
        if (!isRecord(page.request)) reject("INVALID_INPUT");
        validateNullFields(page.request, ["affectedAccountId"]);
        if (
          !isRecord(page.response)
          || !Array.isArray(
            page.response.accountRecommendationLifecycleSummaries,
          )
          || page.response.accountRecommendationLifecycleSummaries.length
            > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.apiPageSize
        ) reject("INVALID_INPUT");
        return page.response.accountRecommendationLifecycleSummaries;
      },
    );
  }
  for (const sequence of input.resources) {
    if (
      !isRecord(sequence)
      || !validText(sequence.recommendationArn, 200)
      || !RECOMMENDATION_ARN.test(sequence.recommendationArn)
      || !Array.isArray(sequence.pages)
      || typeof sequence.exhausted !== "boolean"
    ) reject("INVALID_INPUT");
    validatePageChain(sequence.pages, sequence.exhausted);
    pageCount += sequence.pages.length;
    resourceCount += recordCountFromPages(sequence.pages, (page) => {
      if (!isRecord(page.request)) reject("INVALID_INPUT");
      validateNullFields(page.request, [
        "affectedAccountId",
        "exclusionStatus",
        "regionCode",
        "status",
      ]);
      if (
        !isRecord(page.response)
        || !Array.isArray(
          page.response.organizationRecommendationResourceSummaries,
        )
        || page.response.organizationRecommendationResourceSummaries.length
          > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.apiPageSize
      ) reject("INVALID_INPUT");
      return page.response.organizationRecommendationResourceSummaries;
    });
  }
  if (
    pageCount
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.maximumPages
  ) reject("PAGE_LIMIT_EXCEEDED");

  const rawRecommendationCount = recordCountFromPages(
    input.recommendations.pages,
    (page) => page.response.organizationRecommendationSummaries,
  );
  if (
    rawRecommendationCount
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
        .maximumRecommendations
    || input.recommendationDetails.length
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
        .maximumRecommendations
    || accountLifecycleCount
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
        .maximumAccountLifecycles
    || resourceCount
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.maximumResources
  ) reject("RECORD_LIMIT_EXCEEDED");

  const summaries = new Map<string, CommonRecommendationFields>();
  for (const page of input.recommendations.pages) {
    for (
      const raw of page.response.organizationRecommendationSummaries
    ) {
      const normalized = normalizeSummary(raw);
      addDeterministic(
        summaries,
        normalized.arn,
        normalized,
      );
    }
  }

  const details = new Map<string, NormalizedDetailFields>();
  for (const raw of input.recommendationDetails) {
    const normalized = normalizeDetail(raw);
    addDeterministic(details, normalized.arn, normalized);
  }
  for (const [arn, summary] of summaries) {
    const detail = details.get(arn);
    if (detail === undefined) reject("INCOMPLETE_DRILLDOWN");
    if (
      recommendationCommonSignature(summary)
      !== recommendationCommonSignature(detail)
    ) reject("CONFLICTING_DUPLICATE");
  }
  if (
    [...details.keys()].some((arn) => !summaries.has(arn))
  ) reject("SCOPE_MISMATCH");

  const accountSequences = new Map<
    string,
    TrustedAdvisorAccountPageSequence
  >();
  for (const sequence of input.accounts) {
    if (accountSequences.has(sequence.recommendationArn)) {
      reject("CONFLICTING_DUPLICATE");
    }
    accountSequences.set(sequence.recommendationArn, sequence);
  }
  const resourceSequences = new Map<
    string,
    TrustedAdvisorResourcePageSequence
  >();
  for (const sequence of input.resources) {
    if (resourceSequences.has(sequence.recommendationArn)) {
      reject("CONFLICTING_DUPLICATE");
    }
    resourceSequences.set(sequence.recommendationArn, sequence);
  }
  if (
    [...accountSequences.keys()].some((arn) => !summaries.has(arn))
    || [...resourceSequences.keys()].some((arn) => !summaries.has(arn))
  ) reject("SCOPE_MISMATCH");
  for (const arn of summaries.keys()) {
    if (
      !accountSequences.has(arn)
      || !resourceSequences.has(arn)
    ) reject("INCOMPLETE_DRILLDOWN");
  }

  const recommendations: TrustedAdvisorNormalizedRecommendation[] = [];
  for (const arn of [...summaries.keys()].sort((left, right) =>
    left.localeCompare(right)
  )) {
    const detail = details.get(arn) as NormalizedDetailFields;
    const accountSequence =
      accountSequences.get(arn) as TrustedAdvisorAccountPageSequence;
    const resourceSequence =
      resourceSequences.get(arn) as TrustedAdvisorResourcePageSequence;
    const accounts = new Map<
      string,
      TrustedAdvisorNormalizedAccountLifecycle
    >();
    for (const page of accountSequence.pages) {
      for (
        const raw of page.response
          .accountRecommendationLifecycleSummaries
      ) {
        const normalized = normalizeAccountLifecycle(raw);
        addDeterministic(
          accounts,
          `${normalized.accountId ?? ""}\0${
            normalized.accountRecommendationArn ?? ""
          }`,
          normalized,
        );
      }
    }
    const resources = new Map<string, TrustedAdvisorNormalizedResource>();
    for (const page of resourceSequence.pages) {
      for (
        const raw of page.response
          .organizationRecommendationResourceSummaries
      ) {
        const normalized = normalizeResource(raw);
        if (normalized.recommendationArn !== arn) {
          reject("SCOPE_MISMATCH");
        }
        addDeterministic(resources, normalized.arn, normalized);
      }
    }
    const normalizedAccounts = [...accounts.values()].sort((left, right) =>
      (left.accountId ?? "").localeCompare(right.accountId ?? "")
      || (left.accountRecommendationArn ?? "").localeCompare(
        right.accountRecommendationArn ?? "",
      )
    );
    const normalizedResources = [...resources.values()].sort((left, right) =>
      (left.accountId ?? "").localeCompare(right.accountId ?? "")
      || left.regionCode.localeCompare(right.regionCode)
      || left.arn.localeCompare(right.arn)
    );
    const observedResourceStatusCounts = {
      ok: normalizedResources.filter((row) => row.status === "ok").length,
      warning: normalizedResources.filter((row) =>
        row.status === "warning"
      ).length,
      error: normalizedResources.filter((row) =>
        row.status === "error"
      ).length,
    };
    const resourceAggregateReconciled =
      resourceSequence.exhausted
      && observedResourceStatusCounts.ok
        === detail.resourcesAggregates.okCount
      && observedResourceStatusCounts.warning
        === detail.resourcesAggregates.warningCount
      && observedResourceStatusCounts.error
        === detail.resourcesAggregates.errorCount;

    recommendations.push({
      arn: detail.arn,
      awsServices: detail.awsServices,
      checkArn: detail.checkArn,
      createdAt: detail.createdAt,
      createdBy: detail.createdBy,
      description: detail.description,
      id: detail.id,
      lastUpdatedAt: detail.lastUpdatedAt,
      lifecycleStage: detail.lifecycleStage,
      name: detail.name,
      pillars: detail.pillars,
      recommendationType: detail.recommendationType,
      resolvedAt: detail.resolvedAt,
      source: detail.source,
      status: detail.status,
      updateReason: detail.updateReason,
      updateReasonCode: detail.updateReasonCode,
      updatedOnBehalfOf: detail.updatedOnBehalfOf,
      updatedOnBehalfOfJobTitle: detail.updatedOnBehalfOfJobTitle,
      awsResourceAggregates: detail.resourcesAggregates,
      costOptimizing: detail.costOptimizing,
      accounts: normalizedAccounts,
      resources: normalizedResources,
      drilldownEvidence: {
        accountPagesExhausted: accountSequence.exhausted,
        resourcePagesExhausted: resourceSequence.exhausted,
        resourceAggregateReconciled,
        observedResourceStatusCounts,
      },
    });
  }

  const allAccountPagesExhausted = recommendations.every(
    (recommendation) =>
      recommendation.drilldownEvidence.accountPagesExhausted,
  );
  const allResourcePagesExhausted = recommendations.every(
    (recommendation) =>
      recommendation.drilldownEvidence.resourcePagesExhausted,
  );
  const allResourceAggregatesReconciled = recommendations.every(
    (recommendation) =>
      recommendation.drilldownEvidence.resourceAggregateReconciled,
  );
  const limitations = [
    "AWS Trusted Advisor organization Public API operations cover prioritized recommendations, not every standard Trusted Advisor check or the legacy organizational-view report.",
    "AWS recommendation savings have no currency field in this API and are never aggregated by Sutra.",
    ...prerequisiteLimitations(input.prerequisites),
  ];
  if (!input.recommendations.exhausted) {
    limitations.push(
      "Recommendation pagination stopped at a declared Sutra collection bound.",
    );
  }
  if (!allAccountPagesExhausted) {
    limitations.push(
      "At least one account lifecycle drilldown stopped at a declared Sutra collection bound.",
    );
  }
  if (!allResourcePagesExhausted) {
    limitations.push(
      "At least one resource drilldown stopped at a declared Sutra collection bound.",
    );
  }
  if (!allResourceAggregatesReconciled) {
    limitations.push(
      "At least one observed resource drilldown does not reconcile to the AWS recommendation aggregate.",
    );
  }
  const complete = prerequisitesSatisfied(input.prerequisites)
    && input.recommendations.exhausted
    && allAccountPagesExhausted
    && allResourcePagesExhausted
    && allResourceAggregatesReconciled;

  return {
    scope: { ...input.scope },
    sourceId: "trusted_advisor_organization",
    captureId: input.captureId,
    observedAtIso: completedAt,
    collectionStartedAtIso: startedAt,
    collectionDurationMs: durationMs,
    prerequisites: { ...input.prerequisites },
    coverage: {
      assessment: complete ? "complete" : "partial",
      recommendationPagesExhausted: input.recommendations.exhausted,
      recommendationCount: recommendations.length,
      accountLifecycleCount: recommendations.reduce(
        (total, recommendation) =>
          total + recommendation.accounts.length,
        0,
      ),
      resourceCount: recommendations.reduce(
        (total, recommendation) =>
          total + recommendation.resources.length,
        0,
      ),
      allDetailsObserved: true,
      allAccountPagesExhausted,
      allResourcePagesExhausted,
      allResourceAggregatesReconciled,
    },
    recommendations,
    evidence: {
      apiOperations: TRUSTED_ADVISOR_ORGANIZATION_API_OPERATIONS,
      apiScope: "organization_priority_recommendations",
      apiIsGlobalRecommendationView: true,
      captureBytes,
      pageCount,
      limitations,
    },
  };
}

export function trustedAdvisorOrganizationSourceEvidence(
  snapshot: TrustedAdvisorOrganizationSnapshot,
): FinopsSourceEvidence {
  if (
    !isRecord(snapshot)
    || !validScope(snapshot.scope)
    || snapshot.sourceId !== "trusted_advisor_organization"
    || !CAPTURE_ID.test(snapshot.captureId)
    || iso(snapshot.observedAtIso) === null
    || !isRecord(snapshot.coverage)
    || !boundedInteger(snapshot.coverage.recommendationCount)
    || !isRecord(snapshot.evidence)
    || !Array.isArray(snapshot.evidence.limitations)
  ) reject("INVALID_INPUT");
  const configured =
    snapshot.prerequisites.trustedAdvisorPriorityEnabled
    && snapshot.prerequisites.trustedAdvisorTrustedAccessEnabled;
  const priorityCaptureComplete =
    snapshot.coverage.assessment === "complete";
  return {
    scope: snapshot.scope,
    sourceId: "trusted_advisor_organization",
    configured,
    deliveryObserved: true,
    lastAttemptAt: snapshot.observedAtIso,
    lastAttemptOutcome:
      priorityCaptureComplete
        ? "succeeded"
        : "partial",
    lastSuccessAt:
      priorityCaptureComplete
        ? snapshot.observedAtIso
        : null,
    dataThroughAt:
      priorityCaptureComplete
        ? snapshot.observedAtIso
        : null,
    coverage: {
      // The shared source gate represents the broader organizational
      // dashboard. Priority-only Public API evidence can never complete it.
      assessment: "partial",
      acceptedRecords: snapshot.coverage.recommendationCount,
      // AWS pagination does not declare a total expected recommendation count.
      expectedRecords: null,
      rejectedRecords: 0,
    },
    lastError: null,
    evidenceBasis:
      "Bounded tenant-scoped AWS Trusted Advisor organization Priority recommendation, detail, account lifecycle, and resource API capture; standard-check organization coverage is not present.",
    limitations: snapshot.evidence.limitations,
  };
}

export interface TrustedAdvisorOrganizationDashboardOptions {
  readonly recommendationLimit?: number;
  readonly accountLimit?: number;
  readonly resourceLimit?: number;
  readonly historyLimit?: number;
  readonly pillar?: TrustedAdvisorPillar;
  readonly status?: TrustedAdvisorStatus;
  readonly lifecycleStage?: TrustedAdvisorLifecycleStage;
  readonly source?: TrustedAdvisorRecommendationSource;
  readonly accountId?: string;
  readonly includeExcludedResources?: boolean;
}

export interface TrustedAdvisorOrganizationDashboard {
  readonly scope: FinopsSourceScope;
  readonly generatedAtIso: string;
  readonly source: {
    readonly sourceId: "trusted_advisor_organization";
    readonly captureId: string;
    readonly observedAtIso: string;
    readonly freshnessAgeHours: number;
    readonly freshnessSlaHours: 48;
    readonly fresh: boolean;
    readonly coverage: TrustedAdvisorOrganizationSnapshot["coverage"];
    readonly limitations: readonly string[];
  };
  readonly summary: {
    readonly recommendationCount: number;
    readonly accountCount: number;
    readonly resourceCount: number;
    readonly recommendationStatusCounts:
      Readonly<Record<TrustedAdvisorStatus, number>>;
    readonly lifecycleCounts:
      Readonly<Record<TrustedAdvisorLifecycleStage | "unknown", number>>;
    readonly resourceStatusCounts:
      Readonly<Record<TrustedAdvisorStatus, number>>;
    readonly pillarCounts:
      Readonly<Record<TrustedAdvisorPillar, number>>;
    readonly sourceCounts:
      Readonly<Record<TrustedAdvisorRecommendationSource, number>>;
  };
  readonly recommendations: readonly (
    Omit<TrustedAdvisorNormalizedRecommendation, "accounts" | "resources">
    & {
      readonly accounts: readonly TrustedAdvisorNormalizedAccountLifecycle[];
      readonly accountsTruncated: boolean;
      readonly resources: readonly TrustedAdvisorNormalizedResource[];
      readonly resourcesTruncated: boolean;
    }
  )[];
  readonly recommendationsTruncated: boolean;
  readonly history: readonly {
    readonly captureId: string;
    readonly observedAtIso: string;
    readonly coverage: "complete" | "partial";
    readonly recommendationStatusCounts:
      Readonly<Record<TrustedAdvisorStatus, number>>;
    readonly resourceStatusCounts:
      Readonly<Record<TrustedAdvisorStatus, number>>;
  }[];
  readonly historyTruncated: boolean;
  readonly disclosure: string;
}

function boundedDashboardLimit(
  value: number | undefined,
  fallback: number,
  maximum: number,
): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
    reject("INVALID_INPUT");
  }
  return resolved;
}

function validateDashboardOptions(
  options: TrustedAdvisorOrganizationDashboardOptions,
): void {
  if (
    options === null
    || typeof options !== "object"
    || Array.isArray(options)
    || (
      options.pillar !== undefined
      && !PILLARS.has(options.pillar)
    )
    || (
      options.status !== undefined
      && !STATUSES.has(options.status)
    )
    || (
      options.lifecycleStage !== undefined
      && !LIFECYCLE_STAGES.has(options.lifecycleStage)
    )
    || (
      options.source !== undefined
      && !SOURCES.has(options.source)
    )
    || (
      options.accountId !== undefined
      && !ACCOUNT_ID.test(options.accountId)
    )
    || (
      options.includeExcludedResources !== undefined
      && typeof options.includeExcludedResources !== "boolean"
    )
  ) reject("INVALID_INPUT");
}

function emptyStatusCounts(): Record<TrustedAdvisorStatus, number> {
  return { ok: 0, warning: 0, error: 0 };
}

function statusCountsForRecommendations(
  recommendations: readonly TrustedAdvisorNormalizedRecommendation[],
): Record<TrustedAdvisorStatus, number> {
  const counts = emptyStatusCounts();
  for (const recommendation of recommendations) {
    counts[recommendation.status] += 1;
  }
  return counts;
}

function statusCountsForResources(
  recommendations: readonly TrustedAdvisorNormalizedRecommendation[],
): Record<TrustedAdvisorStatus, number> {
  const counts = emptyStatusCounts();
  for (const recommendation of recommendations) {
    for (const resource of recommendation.resources) {
      counts[resource.status] += 1;
    }
  }
  return counts;
}

function validateDashboardSnapshot(
  snapshot: TrustedAdvisorOrganizationSnapshot,
  scope: FinopsSourceScope,
): number {
  if (
    snapshot === null
    || typeof snapshot !== "object"
    || Array.isArray(snapshot)
    || !validScope(snapshot.scope)
    || !sameScope(snapshot.scope, scope)
  ) reject("SCOPE_MISMATCH");
  validatePrerequisites(snapshot.prerequisites);
  if (
    snapshot.sourceId !== "trusted_advisor_organization"
    || !CAPTURE_ID.test(snapshot.captureId)
    || iso(snapshot.observedAtIso) === null
    || iso(snapshot.collectionStartedAtIso) === null
    || !boundedInteger(snapshot.collectionDurationMs)
    || snapshot.collectionDurationMs
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.maximumDurationMs
    || snapshot.coverage === null
    || typeof snapshot.coverage !== "object"
    || (
      snapshot.coverage.assessment !== "complete"
      && snapshot.coverage.assessment !== "partial"
    )
    || !boundedInteger(snapshot.coverage.recommendationCount)
    || snapshot.coverage.recommendationCount
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
        .maximumRecommendations
    || !boundedInteger(snapshot.coverage.accountLifecycleCount)
    || snapshot.coverage.accountLifecycleCount
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
        .maximumAccountLifecycles
    || !boundedInteger(snapshot.coverage.resourceCount)
    || snapshot.coverage.resourceCount
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.maximumResources
    || typeof snapshot.coverage.recommendationPagesExhausted !== "boolean"
    || typeof snapshot.coverage.allDetailsObserved !== "boolean"
    || typeof snapshot.coverage.allAccountPagesExhausted !== "boolean"
    || typeof snapshot.coverage.allResourcePagesExhausted !== "boolean"
    || typeof snapshot.coverage.allResourceAggregatesReconciled !== "boolean"
    || snapshot.evidence === null
    || typeof snapshot.evidence !== "object"
    || snapshot.evidence.apiScope
      !== "organization_priority_recommendations"
    || snapshot.evidence.apiIsGlobalRecommendationView !== true
    || JSON.stringify(snapshot.evidence.apiOperations)
      !== JSON.stringify(TRUSTED_ADVISOR_ORGANIZATION_API_OPERATIONS)
    || !boundedInteger(snapshot.evidence.captureBytes)
    || snapshot.evidence.captureBytes
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.maximumCaptureBytes
    || !boundedInteger(snapshot.evidence.pageCount)
    || snapshot.evidence.pageCount
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.maximumPages
    || !Array.isArray(snapshot.evidence.limitations)
    || snapshot.evidence.limitations.length > 100
    || !snapshot.evidence.limitations.every((limitation) =>
      validText(limitation, 4_096)
    )
    || !Array.isArray(snapshot.recommendations)
    || snapshot.recommendations.length
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
        .maximumRecommendations
  ) reject("INVALID_INPUT");

  let accountCount = 0;
  let resourceCount = 0;
  const recommendationArns = new Set<string>();
  for (
    const recommendation of snapshot.recommendations as
      readonly TrustedAdvisorNormalizedRecommendation[]
  ) {
    if (
      recommendation === null
      || typeof recommendation !== "object"
      || Array.isArray(recommendation)
      || !validText(recommendation.arn, 200)
      || !RECOMMENDATION_ARN.test(recommendation.arn)
      || recommendationArns.has(recommendation.arn)
      || !validText(recommendation.id, 256)
      || !validText(recommendation.name, 1_024)
      || !validText(recommendation.description, 16_384)
      || !Array.isArray(recommendation.pillars)
      || recommendation.pillars.length < 1
      || recommendation.pillars.length > 50
      || !recommendation.pillars.every((pillar) =>
        PILLARS.has(pillar)
      )
      || !SOURCES.has(recommendation.source)
      || !STATUSES.has(recommendation.status)
      || !RECOMMENDATION_TYPES.has(recommendation.recommendationType)
      || (
        recommendation.lifecycleStage !== null
        && !LIFECYCLE_STAGES.has(recommendation.lifecycleStage)
      )
      || (
        recommendation.lastUpdatedAt !== null
        && iso(recommendation.lastUpdatedAt) === null
      )
      || !Array.isArray(recommendation.accounts)
      || !Array.isArray(recommendation.resources)
      || recommendation.drilldownEvidence === null
      || typeof recommendation.drilldownEvidence !== "object"
      || typeof recommendation.drilldownEvidence.accountPagesExhausted
        !== "boolean"
      || typeof recommendation.drilldownEvidence.resourcePagesExhausted
        !== "boolean"
      || typeof recommendation.drilldownEvidence.resourceAggregateReconciled
        !== "boolean"
    ) reject("INVALID_INPUT");
    recommendationArns.add(recommendation.arn);
    accountCount += recommendation.accounts.length;
    resourceCount += recommendation.resources.length;
    if (
      accountCount
        > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
          .maximumAccountLifecycles
      || resourceCount
        > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS.maximumResources
    ) reject("RECORD_LIMIT_EXCEEDED");
    for (const account of recommendation.accounts) {
      if (
        account === null
        || typeof account !== "object"
        || Array.isArray(account)
        || (
          account.accountId !== null
          && !ACCOUNT_ID.test(account.accountId)
        )
        || (
          account.accountRecommendationArn !== null
          && !ACCOUNT_RECOMMENDATION_ARN.test(
            account.accountRecommendationArn,
          )
        )
        || (
          account.lifecycleStage !== null
          && !LIFECYCLE_STAGES.has(account.lifecycleStage)
        )
      ) reject("INVALID_INPUT");
    }
    const resourceArns = new Set<string>();
    for (const resource of recommendation.resources) {
      if (
        resource === null
        || typeof resource !== "object"
        || Array.isArray(resource)
        || !RESOURCE_ARN.test(resource.arn)
        || resourceArns.has(resource.arn)
        || resource.recommendationArn !== recommendation.arn
        || (
          resource.accountId !== null
          && !ACCOUNT_ID.test(resource.accountId)
        )
        || !STATUSES.has(resource.status)
        || (
          resource.exclusionStatus !== null
          && !EXCLUSION_STATUSES.has(resource.exclusionStatus)
        )
        || iso(resource.lastUpdatedAt) === null
        || !Array.isArray(resource.metadata)
        || resource.metadata.length
          > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
            .maximumMetadataEntriesPerResource
        || !(resource.metadata as readonly TrustedAdvisorMetadataEntry[])
          .every((entry) =>
          entry !== null
          && typeof entry === "object"
          && !Array.isArray(entry)
          && validText(entry.key, 256, true)
          && validText(entry.value, 4_096, true)
          )
      ) reject("INVALID_INPUT");
      resourceArns.add(resource.arn);
    }
  }
  if (
    snapshot.coverage.recommendationCount
      !== snapshot.recommendations.length
    || snapshot.coverage.accountLifecycleCount !== accountCount
    || snapshot.coverage.resourceCount !== resourceCount
  ) reject("INVALID_INPUT");
  return snapshot.recommendations.length + accountCount + resourceCount;
}

/**
 * Build a bounded organization/account/resource drilldown and history series.
 * Every supplied snapshot must exactly match the authoritative server scope;
 * foreign records fail closed instead of being silently filtered.
 */
export function buildTrustedAdvisorOrganizationDashboard(input: {
  readonly scope: FinopsSourceScope;
  readonly snapshots: readonly TrustedAdvisorOrganizationSnapshot[];
  readonly options?: TrustedAdvisorOrganizationDashboardOptions;
  readonly nowMs?: number;
}): TrustedAdvisorOrganizationDashboard {
  if (
    input === null
    || typeof input !== "object"
    || Array.isArray(input)
    || !validScope(input.scope)
    || !Array.isArray(input.snapshots)
    || input.snapshots.length === 0
    || input.snapshots.length
      > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
        .maximumHistorySnapshots
  ) reject("INVALID_INPUT");
  const options = input.options ?? {};
  validateDashboardOptions(options);
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) reject("INVALID_INPUT");
  boundedJsonByteLength(
    input,
    TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
      .maximumDashboardInputBytes,
  );
  let historyRecordCount = 0;
  for (const snapshot of input.snapshots) {
    historyRecordCount += validateDashboardSnapshot(
      snapshot as TrustedAdvisorOrganizationSnapshot,
      input.scope,
    );
    if (
      historyRecordCount
        > TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
          .maximumDashboardHistoryRecords
    ) reject("RECORD_LIMIT_EXCEEDED");
  }
  const snapshots = (
    [...input.snapshots] as TrustedAdvisorOrganizationSnapshot[]
  ).sort((left, right) =>
    right.observedAtIso.localeCompare(left.observedAtIso)
    || right.captureId.localeCompare(left.captureId)
  );
  const seenCaptures = new Set<string>();
  for (const snapshot of snapshots) {
    if (seenCaptures.has(snapshot.captureId)) {
      reject("CONFLICTING_DUPLICATE");
    }
    seenCaptures.add(snapshot.captureId);
  }
  const current = snapshots[0];
  const recommendationLimit = boundedDashboardLimit(
    options.recommendationLimit,
    50,
    TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
      .maximumDashboardRecommendations,
  );
  const accountLimit = boundedDashboardLimit(
    options.accountLimit,
    50,
    TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
      .maximumDashboardAccounts,
  );
  const resourceLimit = boundedDashboardLimit(
    options.resourceLimit,
    50,
    TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
      .maximumDashboardResources,
  );
  const historyLimit = boundedDashboardLimit(
    options.historyLimit,
    12,
    TRUSTED_ADVISOR_ORGANIZATION_COLLECTION_BOUNDS
      .maximumHistorySnapshots,
  );

  const filtered = current.recommendations
    .filter((recommendation) =>
      (options.pillar === undefined
        || recommendation.pillars.includes(options.pillar))
      && (options.status === undefined
        || recommendation.status === options.status)
      && (options.lifecycleStage === undefined
        || recommendation.lifecycleStage === options.lifecycleStage)
      && (options.source === undefined
        || recommendation.source === options.source)
      && (
        options.accountId === undefined
        || recommendation.accounts.some((account) =>
          account.accountId === options.accountId
        )
        || recommendation.resources.some((resource) =>
          resource.accountId === options.accountId
        )
      )
    )
    .sort((left, right) =>
      (right.lastUpdatedAt ?? "").localeCompare(left.lastUpdatedAt ?? "")
      || left.arn.localeCompare(right.arn)
    );
  const visible = filtered.slice(0, recommendationLimit).map(
    (recommendation) => {
      const accounts = recommendation.accounts.filter((account) =>
        options.accountId === undefined
        || account.accountId === options.accountId
      );
      const resources = recommendation.resources.filter((resource) =>
        (options.accountId === undefined
          || resource.accountId === options.accountId)
        && (
          options.includeExcludedResources === true
          || resource.exclusionStatus !== "excluded"
        )
      );
      return {
        ...recommendation,
        accounts: accounts.slice(0, accountLimit),
        accountsTruncated: accounts.length > accountLimit,
        resources: resources.slice(0, resourceLimit),
        resourcesTruncated: resources.length > resourceLimit,
      };
    },
  );

  const allAccountIds = new Set<string>();
  const summaryResourceCounts = emptyStatusCounts();
  const lifecycleCounts: Record<
    TrustedAdvisorLifecycleStage | "unknown",
    number
  > = {
    in_progress: 0,
    pending_response: 0,
    dismissed: 0,
    resolved: 0,
    unknown: 0,
  };
  const pillarCounts = Object.fromEntries(
    [...PILLARS].sort().map((pillar) => [pillar, 0]),
  ) as Record<TrustedAdvisorPillar, number>;
  const sourceCounts = Object.fromEntries(
    [...SOURCES].sort().map((source) => [source, 0]),
  ) as Record<TrustedAdvisorRecommendationSource, number>;
  for (const recommendation of filtered) {
    lifecycleCounts[recommendation.lifecycleStage ?? "unknown"] += 1;
    sourceCounts[recommendation.source] += 1;
    for (const pillar of recommendation.pillars) pillarCounts[pillar] += 1;
    for (const account of recommendation.accounts) {
      if (
        account.accountId !== null
        && (
          options.accountId === undefined
          || account.accountId === options.accountId
        )
      ) allAccountIds.add(account.accountId);
    }
    for (const resource of recommendation.resources) {
      if (
        options.accountId !== undefined
        && resource.accountId !== options.accountId
      ) continue;
      if (resource.accountId !== null) allAccountIds.add(resource.accountId);
      if (
        options.includeExcludedResources === true
        || resource.exclusionStatus !== "excluded"
      ) summaryResourceCounts[resource.status] += 1;
    }
  }

  const history = snapshots.slice(0, historyLimit).map((snapshot) => ({
    captureId: snapshot.captureId,
    observedAtIso: snapshot.observedAtIso,
    coverage: snapshot.coverage.assessment,
    recommendationStatusCounts: statusCountsForRecommendations(
      snapshot.recommendations,
    ),
    resourceStatusCounts: statusCountsForResources(
      snapshot.recommendations,
    ),
  }));
  const ageMs = nowMs - Date.parse(current.observedAtIso);
  const freshnessAgeHours = ageMs < 0
    ? Number.POSITIVE_INFINITY
    : Math.round((ageMs / 3_600_000) * 100) / 100;

  return {
    scope: { ...input.scope },
    generatedAtIso: new Date(nowMs).toISOString(),
    source: {
      sourceId: "trusted_advisor_organization",
      captureId: current.captureId,
      observedAtIso: current.observedAtIso,
      freshnessAgeHours,
      freshnessSlaHours: 48,
      fresh: Number.isFinite(freshnessAgeHours)
        && freshnessAgeHours <= 48,
      coverage: current.coverage,
      limitations: current.evidence.limitations,
    },
    summary: {
      recommendationCount: filtered.length,
      accountCount: allAccountIds.size,
      resourceCount:
        summaryResourceCounts.ok
        + summaryResourceCounts.warning
        + summaryResourceCounts.error,
      recommendationStatusCounts:
        statusCountsForRecommendations(filtered),
      lifecycleCounts,
      resourceStatusCounts: summaryResourceCounts,
      pillarCounts,
      sourceCounts,
    },
    recommendations: visible,
    recommendationsTruncated: filtered.length > recommendationLimit,
    history,
    historyTruncated: snapshots.length > historyLimit,
    disclosure:
      "This view is sourced from AWS Trusted Advisor Priority organization APIs. It is not evidence of complete standard-check organizational-view coverage; recommendation savings are not totaled because the API supplies no currency.",
  };
}
