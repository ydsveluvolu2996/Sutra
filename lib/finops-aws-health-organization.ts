/**
 * Bounded, tenant-pinned normalization and dashboard projection for AWS
 * Health Organizational View.
 *
 * The credential-owning collector is outside this module. It must execute the
 * exact read-only operations declared below and return this capture through an
 * authenticated broker. This module accepts no credentials, performs no I/O,
 * keeps no global cache, and never derives tenant scope from a client request.
 */
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const CAPTURE_ID = /^health_[a-f0-9]{64}$/u;
const JOB_ID = /^healthjob_[a-f0-9]{32}$/u;
const EVENT_ARN =
  /^arn:(aws|aws-us-gov):health:[^:]*:[^:]*:event(?:\/[\w-]+){3}$/u;
const TOKEN = /^[a-zA-Z0-9=/+_.-]{4,10000}$/u;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;

export const AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS = Object.freeze({
  apiPageSize: 100,
  apiDetailBatchSize: 10,
  maximumConcurrency: 4,
  maximumDurationMs: 15 * 60 * 1_000,
  maximumCaptureBytes: 48 * 1_024 * 1_024,
  maximumPages: 20_000,
  maximumEvents: 10_000,
  maximumAffectedAccounts: 100_000,
  maximumAffectedEntities: 200_000,
  maximumDescriptionCharacters: 16_384,
  maximumMetadataEntries: 50,
  maximumMetadataKeyCharacters: 1_024,
  maximumMetadataValueCharacters: 4_096,
  maximumDashboardInputBytes: 64 * 1_024 * 1_024,
  maximumDashboardEvents: 500,
  sourceFreshnessSlaHours: 72,
  providerRetentionDays: 90,
} as const);

export const AWS_HEALTH_ORGANIZATION_READ_OPERATIONS = Object.freeze([
  "health:DescribeAffectedAccountsForOrganization",
  "health:DescribeAffectedEntitiesForOrganization",
  "health:DescribeEventDetailsForOrganization",
  "health:DescribeEventsForOrganization",
] as const);

export const AWS_HEALTH_ORGANIZATION_CONFIGURATION_READ_OPERATION =
  "health:DescribeHealthServiceStatusForOrganization" as const;

export type AwsHealthPartition = "aws" | "aws-us-gov";
export type AwsHealthEventStatus = "open" | "closed" | "upcoming";
export type AwsHealthEventCategory =
  | "issue"
  | "accountNotification"
  | "scheduledChange"
  | "investigation";
export type AwsHealthEventScope = "PUBLIC" | "ACCOUNT_SPECIFIC";
export type AwsHealthEntityStatus =
  | "IMPAIRED"
  | "UNIMPAIRED"
  | "UNKNOWN"
  | "PENDING"
  | "RESOLVED";
export type AwsHealthActionability =
  | "ACTION_REQUIRED"
  | "ACTION_MAY_BE_REQUIRED"
  | "INFORMATIONAL";
export type AwsHealthPersona = "OPERATIONS" | "SECURITY" | "BILLING";
export type AwsHealthSupportPlan =
  | "business_support_plus"
  | "enterprise"
  | "unified_operations"
  | "business"
  | "enterprise_on_ramp"
  | "unknown"
  | "not_qualifying";
export type AwsHealthCollectorAccountType =
  | "management"
  | "delegated_administrator"
  | "member"
  | "unknown";
export type AwsHealthOrganizationViewStatus =
  | "ENABLED"
  | "DISABLED"
  | "PENDING"
  | "UNKNOWN";
export type AwsHealthInitialLoadState = "COMPLETE" | "PENDING" | "UNKNOWN";
export type AwsHealthProviderFailureCode =
  | "ACCESS_DENIED"
  | "SUBSCRIPTION_REQUIRED"
  | "ORGANIZATION_VIEW_DISABLED"
  | "INVALID_PAGINATION"
  | "THROTTLED"
  | "TIMEOUT"
  | "BOUND_REACHED"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";

export interface AwsHealthOrganizationPrerequisites {
  readonly organizationsAllFeaturesEnabled: boolean;
  readonly organizationViewStatus: AwsHealthOrganizationViewStatus;
  /**
   * The status API is management-account only. A delegated administrator can
   * instead carry management-verified enablement evidence.
   */
  readonly organizationViewStatusEvidence:
    | "management_status_api"
    | "management_verified_delegation"
    | "unverified";
  readonly supportPlan: AwsHealthSupportPlan;
  readonly apiEntitlementValidated: boolean;
  readonly collectorAccountType: AwsHealthCollectorAccountType;
  readonly delegatedAdministratorRegistered: boolean;
  readonly readPermissionsValidated: boolean;
  readonly initialLoadState: AwsHealthInitialLoadState;
}

export interface AwsHealthOrganizationScope extends FinopsSourceScope {
  readonly accountId: string;
  readonly partition: AwsHealthPartition;
  readonly endpointRegion: "us-east-1" | "us-gov-west-1";
}

export interface AwsHealthOrganizationEvent {
  readonly arn: string;
  readonly actionability?: AwsHealthActionability;
  readonly endTime?: string;
  readonly eventScopeCode: AwsHealthEventScope;
  readonly eventTypeCategory: AwsHealthEventCategory;
  readonly eventTypeCode: string;
  readonly lastUpdatedTime?: string;
  readonly personas?: readonly AwsHealthPersona[];
  readonly region?: string;
  readonly service?: string;
  readonly startTime?: string;
  readonly statusCode: AwsHealthEventStatus;
}

interface AwsHealthPageRequest {
  readonly maxResults: 100;
  readonly nextToken: string | null;
}

export interface AwsHealthEventPage {
  readonly request: AwsHealthPageRequest & {
    readonly filter: null;
    readonly locale: "en";
  };
  readonly response: {
    readonly events: readonly AwsHealthOrganizationEvent[];
    readonly nextToken: string | null;
  };
}

export interface AwsHealthAffectedAccountPage {
  readonly request: AwsHealthPageRequest & {
    readonly eventArn: string;
  };
  readonly response: {
    readonly affectedAccounts: readonly string[];
    readonly eventScopeCode: AwsHealthEventScope;
    readonly nextToken: string | null;
  };
}

export interface AwsHealthAffectedAccountSequence {
  readonly eventArn: string;
  readonly pages: readonly AwsHealthAffectedAccountPage[];
  /** False means the collector stopped at a declared bound. */
  readonly exhausted: boolean;
}

export interface AwsHealthAffectedEntity {
  readonly awsAccountId?: string;
  readonly entityArn?: string;
  readonly entityMetadata?: Readonly<Record<string, string>>;
  readonly entityValue?: string;
  readonly eventArn: string;
  readonly lastUpdatedTime?: string;
  readonly statusCode?: AwsHealthEntityStatus;
}

export interface AwsHealthFailedFilter {
  readonly eventArn: string;
  readonly awsAccountId: string | null;
  /** Provider messages are deliberately excluded from the broker payload. */
  readonly code: AwsHealthProviderFailureCode;
}

export interface AwsHealthAffectedEntityPage {
  readonly request: AwsHealthPageRequest & {
    readonly locale: "en";
    readonly organizationEntityAccountFilters: null;
    readonly organizationEntityFilters: readonly [{
      readonly eventArn: string;
      readonly awsAccountId: string | null;
    }];
  };
  readonly response: {
    readonly entities: readonly AwsHealthAffectedEntity[];
    readonly failedSet: readonly AwsHealthFailedFilter[];
    readonly nextToken: string | null;
  };
}

export interface AwsHealthAffectedEntitySequence {
  readonly eventArn: string;
  readonly awsAccountId: string | null;
  readonly pages: readonly AwsHealthAffectedEntityPage[];
  readonly exhausted: boolean;
}

export interface AwsHealthEventDetail {
  readonly eventArn: string;
  readonly awsAccountId: string | null;
  readonly description: string | null;
  readonly metadata: Readonly<Record<string, string>>;
}

export interface AwsHealthEventDetailResult {
  readonly eventArn: string;
  readonly awsAccountId: string | null;
  readonly detail: AwsHealthEventDetail | null;
  readonly failureCode: AwsHealthProviderFailureCode | null;
}

export interface AwsHealthOrganizationCapture {
  readonly schemaVersion: "sutra.aws-health-organization.v1";
  readonly scope: AwsHealthOrganizationScope;
  readonly captureId: string;
  readonly startedAtIso: string;
  readonly completedAtIso: string;
  readonly execution: {
    readonly concurrencyLimit: 4;
    readonly eventDetailBatchSize: 10;
    readonly observedPeakConcurrency: number;
  };
  readonly prerequisites: AwsHealthOrganizationPrerequisites;
  readonly events: {
    readonly pages: readonly AwsHealthEventPage[];
    readonly exhausted: boolean;
  };
  readonly affectedAccounts: readonly AwsHealthAffectedAccountSequence[];
  readonly affectedEntities: readonly AwsHealthAffectedEntitySequence[];
  readonly eventDetails: readonly AwsHealthEventDetailResult[];
}

export interface AwsHealthMetadataEntry {
  readonly key: string;
  readonly value: string;
}

export interface AwsHealthNormalizedEntity {
  readonly accountId: string | null;
  readonly entityArn: string | null;
  readonly entityValue: string | null;
  readonly lastUpdatedAt: string | null;
  readonly metadata: readonly AwsHealthMetadataEntry[];
  readonly status: AwsHealthEntityStatus | null;
}

export interface AwsHealthNormalizedDetail {
  readonly accountId: string | null;
  readonly description: string | null;
  readonly metadata: readonly AwsHealthMetadataEntry[];
}

export interface AwsHealthNormalizedEvent {
  readonly arn: string;
  readonly actionability: AwsHealthActionability | null;
  readonly category: AwsHealthEventCategory;
  readonly service: string | null;
  readonly region: string | null;
  readonly eventTypeCode: string;
  readonly status: AwsHealthEventStatus;
  readonly scope: AwsHealthEventScope;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly lastUpdatedAt: string | null;
  readonly personas: readonly AwsHealthPersona[];
  readonly affectedAccounts: readonly string[];
  readonly affectedEntities: readonly AwsHealthNormalizedEntity[];
  readonly details: readonly AwsHealthNormalizedDetail[];
  readonly evidence: {
    readonly accountPagesExhausted: boolean;
    readonly entityPagesExhausted: boolean;
    readonly detailResultsComplete: boolean;
    readonly requiredSummaryFieldsPresent: boolean;
    readonly providerFailures: readonly AwsHealthProviderFailureCode[];
  };
}

export type AwsHealthConfigurationState =
  | "ready"
  | "pending"
  | "unavailable"
  | "unverified";
export type AwsHealthCollectionState = "complete" | "partial" | "unavailable";

export interface AwsHealthOrganizationSnapshot {
  readonly scope: AwsHealthOrganizationScope;
  readonly sourceId: "aws_health_organization";
  readonly captureId: string;
  readonly observedAtIso: string;
  readonly collectionStartedAtIso: string;
  readonly collectionDurationMs: number;
  readonly prerequisites: AwsHealthOrganizationPrerequisites;
  readonly configurationState: AwsHealthConfigurationState;
  readonly collectionState: AwsHealthCollectionState;
  readonly coverage: {
    readonly eventPagesExhausted: boolean;
    readonly allAccountPagesExhausted: boolean;
    readonly allEntityPagesExhausted: boolean;
    readonly allDetailsComplete: boolean;
    readonly summaryEvidenceComplete: boolean;
    readonly eventCount: number;
    readonly affectedAccountCount: number;
    readonly affectedEntityCount: number;
    readonly providerFailureCount: number;
  };
  readonly events: readonly AwsHealthNormalizedEvent[];
  readonly evidence: {
    readonly readOperations:
      typeof AWS_HEALTH_ORGANIZATION_READ_OPERATIONS;
    readonly configurationReadOperation:
      typeof AWS_HEALTH_ORGANIZATION_CONFIGURATION_READ_OPERATION;
    readonly captureBytes: number;
    readonly pageCount: number;
    readonly limitations: readonly string[];
  };
}

export type AwsHealthOrganizationErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "BYTE_LIMIT_EXCEEDED"
  | "TIME_LIMIT_EXCEEDED"
  | "PAGE_LIMIT_EXCEEDED"
  | "RECORD_LIMIT_EXCEEDED"
  | "INVALID_PAGINATION"
  | "CONFLICTING_DUPLICATE"
  | "INCOMPLETE_DRILLDOWN";

export class AwsHealthOrganizationError extends Error {
  public readonly code: AwsHealthOrganizationErrorCode;

  public constructor(code: AwsHealthOrganizationErrorCode) {
    super("AWS Health organization evidence rejected");
    this.name = "AwsHealthOrganizationError";
    this.code = code;
  }
}

const EVENT_STATUSES = new Set<AwsHealthEventStatus>([
  "open",
  "closed",
  "upcoming",
]);
const EVENT_CATEGORIES = new Set<AwsHealthEventCategory>([
  "issue",
  "accountNotification",
  "scheduledChange",
  "investigation",
]);
const EVENT_SCOPES = new Set<AwsHealthEventScope>([
  "PUBLIC",
  "ACCOUNT_SPECIFIC",
]);
const ENTITY_STATUSES = new Set<AwsHealthEntityStatus>([
  "IMPAIRED",
  "UNIMPAIRED",
  "UNKNOWN",
  "PENDING",
  "RESOLVED",
]);
const ACTIONABILITIES = new Set<AwsHealthActionability>([
  "ACTION_REQUIRED",
  "ACTION_MAY_BE_REQUIRED",
  "INFORMATIONAL",
]);
const PERSONAS = new Set<AwsHealthPersona>([
  "OPERATIONS",
  "SECURITY",
  "BILLING",
]);
const SUPPORT_PLANS = new Set<AwsHealthSupportPlan>([
  "business_support_plus",
  "enterprise",
  "unified_operations",
  "business",
  "enterprise_on_ramp",
  "unknown",
  "not_qualifying",
]);
const ACCOUNT_TYPES = new Set<AwsHealthCollectorAccountType>([
  "management",
  "delegated_administrator",
  "member",
  "unknown",
]);
const ORG_VIEW_STATUSES = new Set<AwsHealthOrganizationViewStatus>([
  "ENABLED",
  "DISABLED",
  "PENDING",
  "UNKNOWN",
]);
const INITIAL_LOAD_STATES = new Set<AwsHealthInitialLoadState>([
  "COMPLETE",
  "PENDING",
  "UNKNOWN",
]);
const PROVIDER_FAILURE_CODES = new Set<AwsHealthProviderFailureCode>([
  "ACCESS_DENIED",
  "SUBSCRIPTION_REQUIRED",
  "ORGANIZATION_VIEW_DISABLED",
  "INVALID_PAGINATION",
  "THROTTLED",
  "TIMEOUT",
  "BOUND_REACHED",
  "PROVIDER_UNAVAILABLE",
  "UNKNOWN",
]);

function reject(code: AwsHealthOrganizationErrorCode): never {
  throw new AwsHealthOrganizationError(code);
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

function iso(value: unknown): string | null {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) return null;
  return new Date(value).toISOString();
}

function optionalIso(value: unknown): string | null {
  return value === undefined ? null : iso(value);
}

function validScope(value: unknown): value is AwsHealthOrganizationScope {
  if (!isRecord(value)) return false;
  return typeof value.orgId === "string"
    && IDENTIFIER.test(value.orgId)
    && typeof value.customerId === "string"
    && IDENTIFIER.test(value.customerId)
    && typeof value.connectionId === "string"
    && IDENTIFIER.test(value.connectionId)
    && typeof value.accountId === "string"
    && ACCOUNT_ID.test(value.accountId)
    && (
      (
        value.partition === "aws"
        && value.endpointRegion === "us-east-1"
      )
      || (
        value.partition === "aws-us-gov"
        && value.endpointRegion === "us-gov-west-1"
      )
    );
}

function sameScope(
  left: AwsHealthOrganizationScope,
  right: AwsHealthOrganizationScope,
): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId
    && left.accountId === right.accountId
    && left.partition === right.partition
    && left.endpointRegion === right.endpointRegion;
}

function token(value: unknown): value is string | null {
  return value === null
    || (typeof value === "string" && TOKEN.test(value));
}

function jsonBytes(value: unknown, maximum: number): number {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    reject("INVALID_INPUT");
  }
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > maximum) reject("BYTE_LIMIT_EXCEEDED");
  return bytes;
}

function validatePageChain<T extends {
  readonly request: AwsHealthPageRequest;
  readonly response: { readonly nextToken: string | null };
}>(
  pages: readonly T[],
  exhausted: boolean,
): void {
  if (pages.length === 0) reject("INVALID_PAGINATION");
  let expected: string | null = null;
  const seen = new Set<string>();
  for (const page of pages) {
    if (
      !isRecord(page)
      || !isRecord(page.request)
      || !isRecord(page.response)
      || page.request.maxResults
        !== AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.apiPageSize
      || !token(page.request.nextToken)
      || !token(page.response.nextToken)
      || page.request.nextToken !== expected
    ) reject("INVALID_PAGINATION");
    if (page.request.nextToken !== null) {
      if (seen.has(page.request.nextToken)) reject("INVALID_PAGINATION");
      seen.add(page.request.nextToken);
    }
    if (
      page.response.nextToken !== null
      && seen.has(page.response.nextToken)
    ) reject("INVALID_PAGINATION");
    expected = page.response.nextToken;
  }
  if (exhausted !== (expected === null)) reject("INVALID_PAGINATION");
}

function validatePrerequisites(
  value: unknown,
): asserts value is AwsHealthOrganizationPrerequisites {
  if (
    !isRecord(value)
    || typeof value.organizationsAllFeaturesEnabled !== "boolean"
    || typeof value.organizationViewStatus !== "string"
    || !ORG_VIEW_STATUSES.has(
      value.organizationViewStatus as AwsHealthOrganizationViewStatus,
    )
    || (
      value.organizationViewStatusEvidence !== "management_status_api"
      && value.organizationViewStatusEvidence
        !== "management_verified_delegation"
      && value.organizationViewStatusEvidence !== "unverified"
    )
    || typeof value.supportPlan !== "string"
    || !SUPPORT_PLANS.has(value.supportPlan as AwsHealthSupportPlan)
    || typeof value.apiEntitlementValidated !== "boolean"
    || typeof value.collectorAccountType !== "string"
    || !ACCOUNT_TYPES.has(
      value.collectorAccountType as AwsHealthCollectorAccountType,
    )
    || typeof value.delegatedAdministratorRegistered !== "boolean"
    || typeof value.readPermissionsValidated !== "boolean"
    || typeof value.initialLoadState !== "string"
    || !INITIAL_LOAD_STATES.has(
      value.initialLoadState as AwsHealthInitialLoadState,
    )
    || (
      value.supportPlan === "not_qualifying"
      && value.apiEntitlementValidated
    )
  ) reject("INVALID_INPUT");
}

function normalizeMetadata(
  value: unknown,
): readonly AwsHealthMetadataEntry[] {
  if (!isRecord(value)) reject("INVALID_INPUT");
  const entries = Object.entries(value);
  if (
    entries.length
      > AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumMetadataEntries
    || entries.some(([key, item]) =>
      !validText(
        key,
        AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS
          .maximumMetadataKeyCharacters,
        true,
      )
      || !validText(
        item,
        AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS
          .maximumMetadataValueCharacters,
        true,
      )
    )
  ) reject("INVALID_INPUT");
  return entries
    .map(([key, item]) => ({ key, value: item as string }))
    .sort((left, right) =>
      left.key.localeCompare(right.key)
      || left.value.localeCompare(right.value)
    );
}

function normalizeEvent(value: unknown): AwsHealthNormalizedEvent {
  if (
    !isRecord(value)
    || !validText(value.arn, 1_600)
    || !EVENT_ARN.test(value.arn)
    || !validText(value.eventTypeCode, 100)
    || typeof value.eventTypeCategory !== "string"
    || !EVENT_CATEGORIES.has(
      value.eventTypeCategory as AwsHealthEventCategory,
    )
    || typeof value.statusCode !== "string"
    || !EVENT_STATUSES.has(value.statusCode as AwsHealthEventStatus)
    || typeof value.eventScopeCode !== "string"
    || !EVENT_SCOPES.has(value.eventScopeCode as AwsHealthEventScope)
    || (
      value.actionability !== undefined
      && (
        typeof value.actionability !== "string"
        || !ACTIONABILITIES.has(
          value.actionability as AwsHealthActionability,
        )
      )
    )
    || (value.service !== undefined && !validText(value.service, 30))
    || (value.region !== undefined && !validText(value.region, 25))
    || (
      value.startTime !== undefined
      && iso(value.startTime) === null
    )
    || (value.endTime !== undefined && iso(value.endTime) === null)
    || (
      value.lastUpdatedTime !== undefined
      && iso(value.lastUpdatedTime) === null
    )
    || (
      value.personas !== undefined
      && (
        !Array.isArray(value.personas)
        || value.personas.length > 3
        || !value.personas.every((persona) =>
          typeof persona === "string"
          && PERSONAS.has(persona as AwsHealthPersona)
        )
      )
    )
  ) reject("INVALID_INPUT");
  return {
    arn: value.arn,
    actionability:
      (value.actionability as AwsHealthActionability | undefined) ?? null,
    category: value.eventTypeCategory as AwsHealthEventCategory,
    service: (value.service as string | undefined) ?? null,
    region: (value.region as string | undefined) ?? null,
    eventTypeCode: value.eventTypeCode,
    status: value.statusCode as AwsHealthEventStatus,
    scope: value.eventScopeCode as AwsHealthEventScope,
    startAt: optionalIso(value.startTime),
    endAt: optionalIso(value.endTime),
    lastUpdatedAt: optionalIso(value.lastUpdatedTime),
    personas: [...new Set(
      (value.personas as AwsHealthPersona[] | undefined) ?? [],
    )].sort((left, right) => left.localeCompare(right)),
    affectedAccounts: [],
    affectedEntities: [],
    details: [],
    evidence: {
      accountPagesExhausted: false,
      entityPagesExhausted: false,
      detailResultsComplete: false,
      requiredSummaryFieldsPresent:
        value.service !== undefined
        && value.region !== undefined
        && value.startTime !== undefined
        && value.lastUpdatedTime !== undefined,
      providerFailures: [],
    },
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
  } else if (JSON.stringify(previous) !== JSON.stringify(value)) {
    reject("CONFLICTING_DUPLICATE");
  }
}

function configurationState(
  prerequisites: AwsHealthOrganizationPrerequisites,
): AwsHealthConfigurationState {
  if (
    prerequisites.organizationViewStatus === "DISABLED"
    || prerequisites.collectorAccountType === "member"
    || !prerequisites.apiEntitlementValidated
  ) return "unavailable";
  if (
    prerequisites.organizationViewStatus === "PENDING"
    || prerequisites.initialLoadState === "PENDING"
  ) return "pending";
  if (
    prerequisites.organizationViewStatus !== "ENABLED"
    || prerequisites.organizationViewStatusEvidence === "unverified"
    || !prerequisites.organizationsAllFeaturesEnabled
    || !prerequisites.readPermissionsValidated
    || prerequisites.initialLoadState !== "COMPLETE"
    || prerequisites.collectorAccountType === "unknown"
    || (
      prerequisites.collectorAccountType === "delegated_administrator"
      && !prerequisites.delegatedAdministratorRegistered
    )
  ) return "unverified";
  return "ready";
}

function prerequisiteLimitations(
  prerequisites: AwsHealthOrganizationPrerequisites,
): string[] {
  const limitations: string[] = [];
  if (!prerequisites.organizationsAllFeaturesEnabled) {
    limitations.push("AWS Organizations all-features mode was not proven.");
  }
  if (prerequisites.organizationViewStatus !== "ENABLED") {
    limitations.push(
      "AWS Health Organizational View is not proven enabled.",
    );
  }
  if (prerequisites.organizationViewStatusEvidence === "unverified") {
    limitations.push(
      "Management-account or management-verified Organizational View status evidence is absent.",
    );
  }
  if (!prerequisites.apiEntitlementValidated) {
    limitations.push(
      "AWS Health API support-plan entitlement was not validated.",
    );
  }
  if (
    prerequisites.collectorAccountType !== "management"
    && prerequisites.collectorAccountType !== "delegated_administrator"
  ) {
    limitations.push(
      "Collection from the management account or a registered delegated administrator was not proven.",
    );
  }
  if (
    prerequisites.collectorAccountType === "delegated_administrator"
    && !prerequisites.delegatedAdministratorRegistered
  ) {
    limitations.push(
      "AWS Health delegated-administrator registration was not proven.",
    );
  }
  if (!prerequisites.readPermissionsValidated) {
    limitations.push(
      "Required AWS Health organization read permissions were not validated.",
    );
  }
  if (prerequisites.initialLoadState !== "COMPLETE") {
    limitations.push(
      "Initial Organizational View account and historical-event loading is not proven complete.",
    );
  }
  return limitations;
}

function pairKey(eventArn: string, accountId: string | null): string {
  return `${eventArn}\0${accountId ?? ""}`;
}

function validateAffectedEntity(
  value: unknown,
  eventArn: string,
  accountId: string | null,
): AwsHealthNormalizedEntity {
  if (
    !isRecord(value)
    || value.eventArn !== eventArn
    || (
      value.awsAccountId !== undefined
      && (
        !validText(value.awsAccountId, 12)
        || !ACCOUNT_ID.test(value.awsAccountId)
        || (
          accountId !== null
          && value.awsAccountId !== accountId
        )
      )
    )
    || (
      accountId === null
      && value.awsAccountId !== undefined
    )
    || (
      accountId !== null
      && value.awsAccountId !== accountId
    )
    || (
      value.entityArn !== undefined
      && !validText(value.entityArn, 1_600, true)
    )
    || (
      value.entityValue !== undefined
      && !validText(value.entityValue, 1_224, true)
    )
    || (
      value.lastUpdatedTime !== undefined
      && iso(value.lastUpdatedTime) === null
    )
    || (
      value.statusCode !== undefined
      && (
        typeof value.statusCode !== "string"
        || !ENTITY_STATUSES.has(value.statusCode as AwsHealthEntityStatus)
      )
    )
    || (
      value.entityMetadata !== undefined
      && !isRecord(value.entityMetadata)
    )
  ) reject("SCOPE_MISMATCH");
  return {
    accountId:
      (value.awsAccountId as string | undefined) ?? accountId,
    entityArn: (value.entityArn as string | undefined) ?? null,
    entityValue: (value.entityValue as string | undefined) ?? null,
    lastUpdatedAt: optionalIso(value.lastUpdatedTime),
    metadata: normalizeMetadata(value.entityMetadata ?? {}),
    status:
      (value.statusCode as AwsHealthEntityStatus | undefined) ?? null,
  };
}

/**
 * Normalize one complete-or-explicitly-partial capture. Scope is compared to
 * server-derived configuration before any event data is accepted.
 */
export function normalizeAwsHealthOrganizationCapture(
  input: AwsHealthOrganizationCapture,
  expectedScope: AwsHealthOrganizationScope,
  nowMs = Date.now(),
): AwsHealthOrganizationSnapshot {
  if (
    !isRecord(input)
    || input.schemaVersion !== "sutra.aws-health-organization.v1"
    || !validScope(input.scope)
    || !validScope(expectedScope)
    || !sameScope(input.scope, expectedScope)
    || !validText(input.captureId, 71)
    || !CAPTURE_ID.test(input.captureId)
    || !Number.isFinite(nowMs)
    || !isRecord(input.execution)
    || input.execution.concurrencyLimit
      !== AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumConcurrency
    || input.execution.eventDetailBatchSize
      !== AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.apiDetailBatchSize
    || !Number.isSafeInteger(input.execution.observedPeakConcurrency)
    || input.execution.observedPeakConcurrency < 1
    || input.execution.observedPeakConcurrency
      > AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumConcurrency
    || !isRecord(input.events)
    || !Array.isArray(input.events.pages)
    || typeof input.events.exhausted !== "boolean"
    || !Array.isArray(input.affectedAccounts)
    || !Array.isArray(input.affectedEntities)
    || !Array.isArray(input.eventDetails)
  ) reject("INVALID_INPUT");
  const captureBytes = jsonBytes(
    input,
    AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumCaptureBytes,
  );
  validatePrerequisites(input.prerequisites);
  const startedAt = iso(input.startedAtIso);
  const completedAt = iso(input.completedAtIso);
  if (startedAt === null || completedAt === null) reject("INVALID_INPUT");
  const durationMs = Date.parse(completedAt) - Date.parse(startedAt);
  if (durationMs < 0) reject("INVALID_INPUT");
  if (
    durationMs
      > AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumDurationMs
    || Date.parse(completedAt) > nowMs + MAX_CLOCK_SKEW_MS
  ) reject("TIME_LIMIT_EXCEEDED");

  validatePageChain(input.events.pages, input.events.exhausted);
  const eventMap = new Map<string, AwsHealthNormalizedEvent>();
  let rawEventCount = 0;
  for (const page of input.events.pages) {
    if (
      page.request.filter !== null
      || page.request.locale !== "en"
      || !Array.isArray(page.response.events)
      || page.response.events.length
        > AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.apiPageSize
    ) reject("INVALID_INPUT");
    rawEventCount += page.response.events.length;
    for (const raw of page.response.events) {
      const event = normalizeEvent(raw);
      if (!event.arn.startsWith(`arn:${input.scope.partition}:`)) {
        reject("SCOPE_MISMATCH");
      }
      addDeterministic(eventMap, event.arn, event);
    }
  }
  if (
    rawEventCount > AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumEvents
  ) reject("RECORD_LIMIT_EXCEEDED");

  let pageCount = input.events.pages.length;
  let affectedAccountCount = 0;
  const accountSequences = new Map<
    string,
    AwsHealthAffectedAccountSequence
  >();
  for (const rawSequence of input.affectedAccounts as readonly unknown[]) {
    if (
      !isRecord(rawSequence)
      || !validText(rawSequence.eventArn, 1_600)
      || !EVENT_ARN.test(rawSequence.eventArn)
      || !eventMap.has(rawSequence.eventArn)
      || !Array.isArray(rawSequence.pages)
      || typeof rawSequence.exhausted !== "boolean"
      || accountSequences.has(rawSequence.eventArn)
    ) reject("SCOPE_MISMATCH");
    const sequence =
      rawSequence as unknown as AwsHealthAffectedAccountSequence;
    validatePageChain(sequence.pages, sequence.exhausted);
    pageCount += sequence.pages.length;
    for (const page of sequence.pages) {
      if (
        page.request.eventArn !== sequence.eventArn
        || !Array.isArray(page.response.affectedAccounts)
        || page.response.affectedAccounts.length
          > AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.apiPageSize
        || page.response.eventScopeCode
          !== eventMap.get(sequence.eventArn)?.scope
        || page.response.affectedAccounts.some((accountId) =>
          !ACCOUNT_ID.test(accountId)
        )
      ) reject("SCOPE_MISMATCH");
      affectedAccountCount += page.response.affectedAccounts.length;
    }
    accountSequences.set(sequence.eventArn, sequence);
  }
  if (
    affectedAccountCount
      > AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumAffectedAccounts
  ) reject("RECORD_LIMIT_EXCEEDED");
  if (
    [...eventMap.keys()].some((eventArn) =>
      !accountSequences.has(eventArn)
    )
  ) reject("INCOMPLETE_DRILLDOWN");

  const entitySequences = new Map<
    string,
    AwsHealthAffectedEntitySequence
  >();
  let affectedEntityCount = 0;
  let providerFailureCount = 0;
  for (const rawSequence of input.affectedEntities as readonly unknown[]) {
    if (
      !isRecord(rawSequence)
      || !validText(rawSequence.eventArn, 1_600)
      || !eventMap.has(rawSequence.eventArn)
      || (
        rawSequence.awsAccountId !== null
        && (
          typeof rawSequence.awsAccountId !== "string"
          || !ACCOUNT_ID.test(rawSequence.awsAccountId)
        )
      )
      || !Array.isArray(rawSequence.pages)
      || typeof rawSequence.exhausted !== "boolean"
    ) reject("SCOPE_MISMATCH");
    const sequence =
      rawSequence as unknown as AwsHealthAffectedEntitySequence;
    const key = pairKey(sequence.eventArn, sequence.awsAccountId);
    if (entitySequences.has(key)) reject("CONFLICTING_DUPLICATE");
    validatePageChain(sequence.pages, sequence.exhausted);
    pageCount += sequence.pages.length;
    for (const page of sequence.pages) {
      const filter = page.request.organizationEntityFilters;
      if (
        page.request.locale !== "en"
        || page.request.organizationEntityAccountFilters !== null
        || !Array.isArray(filter)
        || filter.length !== 1
        || filter[0]?.eventArn !== sequence.eventArn
        || filter[0]?.awsAccountId !== sequence.awsAccountId
        || !Array.isArray(page.response.entities)
        || page.response.entities.length
          > AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.apiPageSize
        || !Array.isArray(page.response.failedSet)
        || page.response.failedSet.length
          > AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.apiDetailBatchSize
      ) reject("SCOPE_MISMATCH");
      for (const failed of page.response.failedSet) {
        if (
          !isRecord(failed)
          || failed.eventArn !== sequence.eventArn
          || failed.awsAccountId !== sequence.awsAccountId
          || typeof failed.code !== "string"
          || !PROVIDER_FAILURE_CODES.has(
            failed.code as AwsHealthProviderFailureCode,
          )
        ) reject("SCOPE_MISMATCH");
      }
      affectedEntityCount += page.response.entities.length;
      providerFailureCount += page.response.failedSet.length;
    }
    entitySequences.set(key, sequence);
  }
  if (
    affectedEntityCount
      > AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumAffectedEntities
  ) reject("RECORD_LIMIT_EXCEEDED");

  const details = new Map<string, AwsHealthEventDetailResult>();
  for (const rawResult of input.eventDetails as readonly unknown[]) {
    if (
      !isRecord(rawResult)
      || !validText(rawResult.eventArn, 1_600)
      || !eventMap.has(rawResult.eventArn)
      || (
        rawResult.awsAccountId !== null
        && (
          typeof rawResult.awsAccountId !== "string"
          || !ACCOUNT_ID.test(rawResult.awsAccountId)
        )
      )
      || details.has(pairKey(
        rawResult.eventArn,
        rawResult.awsAccountId as string | null,
      ))
      || (
        (rawResult.detail === null) === (rawResult.failureCode === null)
      )
      || (
        rawResult.failureCode !== null
        && (
          typeof rawResult.failureCode !== "string"
          || !PROVIDER_FAILURE_CODES.has(
            rawResult.failureCode as AwsHealthProviderFailureCode,
          )
        )
      )
    ) reject("INVALID_INPUT");
    const result = rawResult as unknown as AwsHealthEventDetailResult;
    if (result.detail !== null) {
      if (
        !isRecord(result.detail)
        || result.detail.eventArn !== result.eventArn
        || result.detail.awsAccountId !== result.awsAccountId
        || (
          result.detail.description !== null
          && !validText(
            result.detail.description,
            AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS
              .maximumDescriptionCharacters,
            true,
          )
        )
      ) reject("SCOPE_MISMATCH");
      normalizeMetadata(result.detail.metadata);
    } else {
      providerFailureCount += 1;
    }
    details.set(pairKey(result.eventArn, result.awsAccountId), result);
  }
  if (
    pageCount > AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumPages
  ) reject("PAGE_LIMIT_EXCEEDED");

  const normalizedEvents: AwsHealthNormalizedEvent[] = [];
  const consumedPairs = new Set<string>();
  for (const event of [...eventMap.values()].sort((left, right) =>
    left.arn.localeCompare(right.arn)
  )) {
    const accountSequence =
      accountSequences.get(event.arn) as AwsHealthAffectedAccountSequence;
    const accountMap = new Map<string, string>();
    for (const page of accountSequence.pages) {
      for (const accountId of page.response.affectedAccounts) {
        accountMap.set(accountId, accountId);
      }
    }
    const accountIds = [...accountMap.keys()].sort((left, right) =>
      left.localeCompare(right)
    );
    if (event.scope === "PUBLIC" && accountIds.length > 0) {
      reject("SCOPE_MISMATCH");
    }
    const expectedPairs = event.scope === "PUBLIC"
      ? [null]
      : accountIds;
    const normalizedEntities = new Map<string, AwsHealthNormalizedEntity>();
    const normalizedDetails: AwsHealthNormalizedDetail[] = [];
    const providerFailures: AwsHealthProviderFailureCode[] = [];
    let entityPagesExhausted = true;
    let detailResultsComplete = true;
    for (const accountId of expectedPairs) {
      const key = pairKey(event.arn, accountId);
      consumedPairs.add(key);
      const entitySequence = entitySequences.get(key);
      const detailResult = details.get(key);
      if (entitySequence === undefined || detailResult === undefined) {
        reject("INCOMPLETE_DRILLDOWN");
      }
      entityPagesExhausted &&= entitySequence.exhausted;
      for (const page of entitySequence.pages) {
        for (const failed of page.response.failedSet) {
          providerFailures.push(failed.code);
        }
        for (const raw of page.response.entities) {
          const entity = validateAffectedEntity(
            raw,
            event.arn,
            accountId,
          );
          const entityKey = [
            entity.accountId ?? "",
            entity.entityArn ?? "",
            entity.entityValue ?? "",
          ].join("\0");
          addDeterministic(normalizedEntities, entityKey, entity);
        }
      }
      if (detailResult.detail === null) {
        detailResultsComplete = false;
        providerFailures.push(
          detailResult.failureCode as AwsHealthProviderFailureCode,
        );
      } else {
        normalizedDetails.push({
          accountId,
          description: detailResult.detail.description,
          metadata: normalizeMetadata(detailResult.detail.metadata),
        });
      }
    }
    normalizedEvents.push({
      ...event,
      affectedAccounts: accountIds,
      affectedEntities: [...normalizedEntities.values()].sort(
        (left, right) =>
          (left.accountId ?? "").localeCompare(right.accountId ?? "")
          || (left.entityArn ?? "").localeCompare(right.entityArn ?? "")
          || (left.entityValue ?? "").localeCompare(right.entityValue ?? ""),
      ),
      details: normalizedDetails.sort((left, right) =>
        (left.accountId ?? "").localeCompare(right.accountId ?? "")
      ),
      evidence: {
        accountPagesExhausted: accountSequence.exhausted,
        entityPagesExhausted,
        detailResultsComplete,
        requiredSummaryFieldsPresent:
          event.evidence.requiredSummaryFieldsPresent,
        providerFailures: [...new Set(providerFailures)].sort((left, right) =>
          left.localeCompare(right)
        ),
      },
    });
  }
  if (
    [...entitySequences.keys()].some((key) => !consumedPairs.has(key))
    || [...details.keys()].some((key) => !consumedPairs.has(key))
  ) reject("SCOPE_MISMATCH");

  const allAccountPagesExhausted = normalizedEvents.every(
    (event) => event.evidence.accountPagesExhausted,
  );
  const allEntityPagesExhausted = normalizedEvents.every(
    (event) => event.evidence.entityPagesExhausted,
  );
  const allDetailsComplete = normalizedEvents.every(
    (event) => event.evidence.detailResultsComplete,
  );
  const summaryEvidenceComplete = normalizedEvents.every(
    (event) => event.evidence.requiredSummaryFieldsPresent,
  );
  const configState = configurationState(input.prerequisites);
  const complete = configState === "ready"
    && input.events.exhausted
    && allAccountPagesExhausted
    && allEntityPagesExhausted
    && allDetailsComplete
    && summaryEvidenceComplete
    && providerFailureCount === 0;
  const limitations = [
    "AWS Health Organizational View is a provider snapshot, not a real-time event stream.",
    "Initial account and historical-event loading can take up to 24 hours after Organizational View is enabled.",
    "AWS Health organizational events are retained by AWS for up to 90 days; longer history requires separately persisted snapshots.",
    "An empty complete response proves only that the bounded provider query returned no retained events; it does not prove that no incident exists or that provider publication has completed.",
    ...prerequisiteLimitations(input.prerequisites),
  ];
  if (!input.events.exhausted) {
    limitations.push(
      "Event pagination stopped at a declared Sutra collection bound.",
    );
  }
  if (!allAccountPagesExhausted) {
    limitations.push(
      "At least one affected-account drilldown stopped at a declared Sutra collection bound.",
    );
  }
  if (!allEntityPagesExhausted) {
    limitations.push(
      "At least one affected-entity drilldown stopped at a declared Sutra collection bound.",
    );
  }
  if (!allDetailsComplete || providerFailureCount > 0) {
    limitations.push(
      "At least one event detail or entity filter failed with a generic provider code.",
    );
  }
  if (!summaryEvidenceComplete) {
    limitations.push(
      "At least one event omitted service, Region, start time, or last-updated evidence.",
    );
  }

  return {
    scope: { ...input.scope },
    sourceId: "aws_health_organization",
    captureId: input.captureId,
    observedAtIso: completedAt,
    collectionStartedAtIso: startedAt,
    collectionDurationMs: durationMs,
    prerequisites: { ...input.prerequisites },
    configurationState: configState,
    collectionState: complete
      ? "complete"
      : configState === "unavailable"
        ? "unavailable"
        : "partial",
    coverage: {
      eventPagesExhausted: input.events.exhausted,
      allAccountPagesExhausted,
      allEntityPagesExhausted,
      allDetailsComplete,
      summaryEvidenceComplete,
      eventCount: normalizedEvents.length,
      affectedAccountCount: normalizedEvents.reduce(
        (total, event) => total + event.affectedAccounts.length,
        0,
      ),
      affectedEntityCount: normalizedEvents.reduce(
        (total, event) => total + event.affectedEntities.length,
        0,
      ),
      providerFailureCount,
    },
    events: normalizedEvents,
    evidence: {
      readOperations: AWS_HEALTH_ORGANIZATION_READ_OPERATIONS,
      configurationReadOperation:
        AWS_HEALTH_ORGANIZATION_CONFIGURATION_READ_OPERATION,
      captureBytes,
      pageCount,
      limitations,
    },
  };
}

export function awsHealthOrganizationSourceEvidence(
  snapshot: AwsHealthOrganizationSnapshot,
): FinopsSourceEvidence {
  if (
    !isRecord(snapshot)
    || !validScope(snapshot.scope)
    || snapshot.sourceId !== "aws_health_organization"
    || !CAPTURE_ID.test(snapshot.captureId)
    || iso(snapshot.observedAtIso) === null
  ) reject("INVALID_INPUT");
  const succeeded = snapshot.collectionState === "complete";
  return {
    scope: snapshot.scope,
    sourceId: "aws_health_organization",
    configured: snapshot.configurationState === "ready",
    deliveryObserved: true,
    lastAttemptAt: snapshot.observedAtIso,
    lastAttemptOutcome: succeeded
      ? "succeeded"
      : snapshot.collectionState === "unavailable"
        ? "failed"
        : "partial",
    lastSuccessAt: succeeded ? snapshot.observedAtIso : null,
    // AWS Health does not expose an organizational publication watermark.
    // Query completion is retained as lastSuccessAt, never as dataThroughAt.
    dataThroughAt: null,
    coverage: {
      assessment: succeeded ? "complete" : "partial",
      acceptedRecords: snapshot.coverage.eventCount,
      expectedRecords: null,
      rejectedRecords: snapshot.coverage.providerFailureCount,
    },
    lastError: snapshot.collectionState === "unavailable"
      ? {
        code: "CONFIGURATION_UNAVAILABLE",
        message: "AWS Health organization source is unavailable",
        at: snapshot.observedAtIso,
      }
      : null,
    evidenceBasis:
      "Bounded tenant-scoped AWS Health Organizational View event, affected-account, event-detail, and affected-entity API capture. Query completion time is not a provider publication guarantee.",
    limitations: snapshot.evidence.limitations,
  };
}

export interface AwsHealthOrganizationDashboardOptions {
  readonly status?: AwsHealthEventStatus;
  readonly category?: AwsHealthEventCategory;
  readonly service?: string;
  readonly accountId?: string;
  readonly eventLimit?: number;
}

export interface AwsHealthOrganizationDashboard {
  readonly scope: AwsHealthOrganizationScope;
  readonly generatedAtIso: string;
  readonly source: {
    readonly sourceId: "aws_health_organization";
    readonly captureId: string;
    readonly observedAtIso: string;
    readonly configurationState: AwsHealthConfigurationState;
    readonly collectionState: AwsHealthCollectionState;
    readonly freshness: "fresh" | "stale";
    readonly ageHours: number;
    readonly freshnessSlaHours: 72;
    readonly limitations: readonly string[];
  };
  readonly summary: {
    readonly eventCount: number;
    readonly openCount: number;
    readonly upcomingCount: number;
    readonly closedCount: number;
    readonly actionRequiredCount: number;
    readonly affectedAccountCount: number;
    readonly affectedEntityCount: number;
    readonly categoryCounts: Readonly<Record<AwsHealthEventCategory, number>>;
    readonly serviceCounts: readonly {
      readonly service: string;
      readonly eventCount: number;
    }[];
  };
  readonly events: readonly AwsHealthNormalizedEvent[];
  readonly eventsTruncated: boolean;
  readonly disclosure: string;
}

export function buildAwsHealthOrganizationDashboard(input: {
  readonly snapshot: AwsHealthOrganizationSnapshot;
  readonly expectedScope: AwsHealthOrganizationScope;
  readonly options?: AwsHealthOrganizationDashboardOptions;
  readonly nowMs?: number;
}): AwsHealthOrganizationDashboard {
  if (
    !isRecord(input)
    || !validScope(input.expectedScope)
    || !isRecord(input.snapshot)
    || !validScope(input.snapshot.scope)
    || !sameScope(input.snapshot.scope, input.expectedScope)
    || input.snapshot.sourceId !== "aws_health_organization"
    || !Array.isArray(input.snapshot.events)
  ) reject("SCOPE_MISMATCH");
  const snapshot =
    input.snapshot as unknown as AwsHealthOrganizationSnapshot;
  jsonBytes(
    snapshot,
    AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumDashboardInputBytes,
  );
  const rawOptions: unknown = input.options ?? {};
  if (
    !isRecord(rawOptions)
    || (
      rawOptions.status !== undefined
      && (
        typeof rawOptions.status !== "string"
        || !EVENT_STATUSES.has(rawOptions.status as AwsHealthEventStatus)
      )
    )
    || (
      rawOptions.category !== undefined
      && (
        typeof rawOptions.category !== "string"
        || !EVENT_CATEGORIES.has(
          rawOptions.category as AwsHealthEventCategory,
        )
      )
    )
    || (
      rawOptions.service !== undefined
      && !validText(rawOptions.service, 30)
    )
    || (
      rawOptions.accountId !== undefined
      && (
        typeof rawOptions.accountId !== "string"
        || !ACCOUNT_ID.test(rawOptions.accountId)
      )
    )
    || (
      rawOptions.eventLimit !== undefined
      && (
        !Number.isSafeInteger(rawOptions.eventLimit)
        || Number(rawOptions.eventLimit) < 1
        || Number(rawOptions.eventLimit)
          > AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumDashboardEvents
      )
    )
  ) reject("INVALID_INPUT");
  const options =
    rawOptions as unknown as AwsHealthOrganizationDashboardOptions;
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) reject("INVALID_INPUT");
  const observedMs = Date.parse(snapshot.observedAtIso);
  if (!Number.isFinite(observedMs) || observedMs > nowMs + MAX_CLOCK_SKEW_MS) {
    reject("TIME_LIMIT_EXCEEDED");
  }
  const ageHours = Math.max(0, (nowMs - observedMs) / 3_600_000);
  const allFiltered = snapshot.events.filter((event) =>
    (options.status === undefined || event.status === options.status)
    && (
      options.category === undefined
      || event.category === options.category
    )
    && (
      options.service === undefined
      || event.service === options.service
    )
    && (
      options.accountId === undefined
      || event.affectedAccounts.includes(options.accountId)
    )
  ).sort((left, right) =>
    (right.lastUpdatedAt ?? "").localeCompare(left.lastUpdatedAt ?? "")
    || left.arn.localeCompare(right.arn)
  );
  const limit = options.eventLimit ?? 100;
  const events = allFiltered.slice(0, limit);
  const categoryCounts: Record<AwsHealthEventCategory, number> = {
    issue: 0,
    accountNotification: 0,
    scheduledChange: 0,
    investigation: 0,
  };
  const serviceCounts = new Map<string, number>();
  const accounts = new Set<string>();
  let entityCount = 0;
  for (const event of allFiltered) {
    categoryCounts[event.category] += 1;
    serviceCounts.set(
      event.service ?? "Unknown",
      (serviceCounts.get(event.service ?? "Unknown") ?? 0) + 1,
    );
    for (const accountId of event.affectedAccounts) accounts.add(accountId);
    entityCount += event.affectedEntities.length;
  }
  return {
    scope: snapshot.scope,
    generatedAtIso: new Date(nowMs).toISOString(),
    source: {
      sourceId: "aws_health_organization",
      captureId: snapshot.captureId,
      observedAtIso: snapshot.observedAtIso,
      configurationState: snapshot.configurationState,
      collectionState: snapshot.collectionState,
      freshness:
        ageHours
          <= AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS
            .sourceFreshnessSlaHours
          ? "fresh"
          : "stale",
      ageHours,
      freshnessSlaHours: 72,
      limitations: snapshot.evidence.limitations,
    },
    summary: {
      eventCount: allFiltered.length,
      openCount: allFiltered.filter((event) => event.status === "open").length,
      upcomingCount: allFiltered.filter((event) =>
        event.status === "upcoming"
      ).length,
      closedCount: allFiltered.filter((event) =>
        event.status === "closed"
      ).length,
      actionRequiredCount: allFiltered.filter((event) =>
        event.actionability === "ACTION_REQUIRED"
      ).length,
      affectedAccountCount: accounts.size,
      affectedEntityCount: entityCount,
      categoryCounts,
      serviceCounts: [...serviceCounts.entries()]
        .map(([service, eventCount]) => ({ service, eventCount }))
        .sort((left, right) =>
          right.eventCount - left.eventCount
          || left.service.localeCompare(right.service)
        ),
    },
    events,
    eventsTruncated: events.length < allFiltered.length,
    disclosure:
      "AWS Health Organizational View is bounded, retention-limited provider evidence. It is not a real-time incident feed, and an empty result is not proof that no incident exists.",
  };
}

export interface AwsHealthOrganizationBrokerRequest {
  readonly tenantId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsHealthPartition;
  readonly endpointRegion: "us-east-1" | "us-gov-west-1";
  readonly jobId: string;
  readonly locale: "en";
  readonly unfilteredAvailableEvents: true;
  readonly limits: {
    readonly pageSize: 100;
    readonly detailBatchSize: 10;
    readonly concurrency: 4;
    readonly maximumDurationMs: number;
    readonly maximumPages: number;
    readonly maximumEvents: number;
    readonly maximumAffectedAccounts: number;
    readonly maximumAffectedEntities: number;
    readonly maximumBytes: number;
  };
}

export interface AwsHealthOrganizationTransport {
  collect(request: AwsHealthOrganizationBrokerRequest): Promise<unknown>;
}

export type AwsHealthOrganizationQueryErrorCode =
  | "INVALID_QUERY"
  | "COLLECTION_FAILED"
  | "INVALID_EVIDENCE";

export class AwsHealthOrganizationQueryError extends Error {
  public readonly code: AwsHealthOrganizationQueryErrorCode;

  public constructor(code: AwsHealthOrganizationQueryErrorCode) {
    super("AWS Health organization query failed");
    this.name = "AwsHealthOrganizationQueryError";
    this.code = code;
  }
}

export function createAwsHealthOrganizationQueryService(
  scope: AwsHealthOrganizationScope,
  transport: AwsHealthOrganizationTransport,
  dependencies: {
    readonly now?: () => Date;
    readonly createJobId?: () => string;
  } = {},
): {
  query(
    input?: Readonly<Record<string, never>>,
  ): Promise<AwsHealthOrganizationSnapshot>;
} {
  if (!validScope(scope) || !isRecord(transport)) reject("INVALID_INPUT");
  const pinnedScope = { ...scope };
  const now = dependencies.now ?? (() => new Date());
  const createJobId = dependencies.createJobId
    ?? (() => `healthjob_${crypto.randomUUID().replaceAll("-", "")}`);
  return {
    async query(
      input: Readonly<Record<string, never>> = {},
    ): Promise<AwsHealthOrganizationSnapshot> {
      if (!isRecord(input) || Object.keys(input).length !== 0) {
        throw new AwsHealthOrganizationQueryError("INVALID_QUERY");
      }
      const jobId = createJobId();
      if (!JOB_ID.test(jobId)) {
        throw new AwsHealthOrganizationQueryError("COLLECTION_FAILED");
      }
      const observedNow = now();
      if (
        !(observedNow instanceof Date)
        || !Number.isFinite(observedNow.getTime())
      ) {
        throw new AwsHealthOrganizationQueryError("COLLECTION_FAILED");
      }
      const request: AwsHealthOrganizationBrokerRequest = {
        tenantId: pinnedScope.orgId,
        customerId: pinnedScope.customerId,
        connectionId: pinnedScope.connectionId,
        accountId: pinnedScope.accountId,
        partition: pinnedScope.partition,
        endpointRegion: pinnedScope.endpointRegion,
        jobId,
        locale: "en",
        unfilteredAvailableEvents: true,
        limits: {
          pageSize: 100,
          detailBatchSize: 10,
          concurrency: 4,
          maximumDurationMs:
            AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumDurationMs,
          maximumPages:
            AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumPages,
          maximumEvents:
            AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumEvents,
          maximumAffectedAccounts:
            AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS
              .maximumAffectedAccounts,
          maximumAffectedEntities:
            AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS
              .maximumAffectedEntities,
          maximumBytes:
            AWS_HEALTH_ORGANIZATION_COLLECTION_BOUNDS.maximumCaptureBytes,
        },
      };
      let raw: unknown;
      try {
        raw = await transport.collect(request);
      } catch {
        throw new AwsHealthOrganizationQueryError("COLLECTION_FAILED");
      }
      try {
        return normalizeAwsHealthOrganizationCapture(
          raw as AwsHealthOrganizationCapture,
          pinnedScope,
          observedNow.getTime(),
        );
      } catch {
        throw new AwsHealthOrganizationQueryError("INVALID_EVIDENCE");
      }
    },
  };
}
