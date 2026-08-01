/**
 * Tenant-pinned AWS Support Cases Radar normalization and dashboard engine.
 *
 * AWS Support case reads are account-local. "Organization" coverage in this
 * module therefore means bounded fan-out over an immutable, server-resolved
 * intended-account set; it never means that AWS exposed an organization-wide
 * case API. The credential-owning collector and signed broker are outside this
 * pure module. No credentials, raw correspondence, personal identifiers,
 * provider messages, pagination tokens, or global tenant cache are accepted.
 */
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const CASE_ID = /^case-[A-Za-z0-9-]{1,240}$/u;
const DISPLAY_ID = /^\d{1,64}$/u;
const SAFE_CODE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u;
const CAPTURE_ID = /^support_[a-f0-9]{64}$/u;
const JOB_ID = /^supportjob_[a-f0-9]{32}$/u;
const EVIDENCE_HASH = /^hmac-sha256:[a-f0-9]{64}$/u;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOUR_MS = 60 * 60 * 1_000;

export const AWS_SUPPORT_CASES_COLLECTION_BOUNDS = Object.freeze({
  casePageSize: 100,
  communicationPageSize: 100,
  maximumRequestsPerSecondPerAccount: 4,
  providerQuotaRequestsPerSecond: 5,
  maximumConcurrency: 2,
  maximumDurationMs: 15 * 60 * 1_000,
  maximumCaptureBytes: 64 * 1_024 * 1_024,
  maximumDashboardInputBytes: 96 * 1_024 * 1_024,
  maximumAccounts: 200,
  maximumCasePages: 10_000,
  maximumCommunicationPages: 50_000,
  maximumCases: 50_000,
  maximumCommunications: 250_000,
  maximumAttachmentsPerCommunication: 10,
  maximumTextBytes: 1 * 1_024 * 1_024,
  maximumInitialLookbackDays: 730,
  maximumIncrementalWindowDays: 31,
  maximumIncrementalOverlapHours: 48,
  maximumHistorySnapshots: 36,
  maximumDashboardCases: 500,
  maximumDashboardAccounts: 200,
  freshnessSlaHours: 48,
} as const);

/** AWS Support has no resource-level ARN or service-specific condition keys. */
export const AWS_SUPPORT_CASES_READ_OPERATIONS = Object.freeze([
  "support:DescribeCases",
  "support:DescribeCommunications",
] as const);

export type AwsSupportPartition = "aws" | "aws-us-gov";
export type AwsSupportEndpointRegion = "us-east-1" | "us-gov-west-1";
export type AwsSupportPlan =
  | "business_support_plus"
  | "enterprise"
  | "unified_operations"
  | "business"
  | "enterprise_on_ramp"
  | "developer"
  | "basic"
  | "unknown"
  | "not_qualifying";
export type AwsSupportEntitlementState =
  | "QUALIFYING"
  | "NOT_QUALIFYING"
  | "UNKNOWN";
export type AwsSupportCaseStatus =
  | "all-open"
  | "customer-action-completed"
  | "opened"
  | "pending-customer-action"
  | "reopened"
  | "resolved"
  | "unassigned"
  | "work-in-progress";
export type AwsSupportCaseSeverity =
  | "low"
  | "normal"
  | "high"
  | "urgent"
  | "critical";
export type AwsSupportActorKind = "AWS" | "CUSTOMER" | "UNKNOWN";
export type AwsSupportFailureCode =
  | "ACCESS_DENIED"
  | "SUBSCRIPTION_REQUIRED"
  | "CASE_NOT_FOUND"
  | "THROTTLED"
  | "TIMEOUT"
  | "BOUND_REACHED"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";
export type AwsSupportConfigurationState =
  | "ready"
  | "partial"
  | "unavailable"
  | "unverified";
export type AwsSupportCollectionState =
  | "complete"
  | "partial"
  | "unavailable";
export type AwsSupportWindowMode = "INITIAL" | "INCREMENTAL";

export interface AwsSupportCasesScope extends FinopsSourceScope {
  readonly partition: AwsSupportPartition;
  readonly endpointRegion: AwsSupportEndpointRegion;
}

export interface AwsSupportIntendedAccount {
  readonly accountId: string;
  readonly connectionId: string;
}

export interface AwsSupportCasesBoundary {
  readonly scope: AwsSupportCasesScope;
  readonly binding: "SERVER_RESOLVED_CONNECTIONS";
  readonly intendedAccounts: readonly AwsSupportIntendedAccount[];
}

export interface AwsSupportCollectionWindow {
  readonly mode: AwsSupportWindowMode;
  readonly afterTime: string;
  readonly beforeTime: string;
  readonly priorWatermark: string | null;
  readonly nextWatermark: string;
}

interface AwsSupportPageCursor {
  readonly pageIndex: number;
  /** Keyed digest of the provider token; the token itself never crosses. */
  readonly cursorEvidenceHash: string | null;
}

export interface AwsSupportSanitizedCase {
  readonly caseId: string;
  readonly displayId: string;
  readonly categoryCode: string;
  readonly language: string;
  readonly serviceCode: string;
  readonly severityCode: AwsSupportCaseSeverity;
  readonly status: AwsSupportCaseStatus;
  readonly createdAt: string;
  readonly submittedByKind: AwsSupportActorKind;
  readonly ccRecipientCount: number;
  readonly subjectBytes: number;
  readonly subjectEvidenceHash: string;
  readonly contactEvidenceHash: string;
  readonly metadataEvidenceHash: string;
  readonly recentCommunicationsOmitted: true;
}

export interface AwsSupportCasePage {
  readonly request: AwsSupportPageCursor & {
    readonly afterTime: string;
    readonly beforeTime: string;
    readonly caseIdList: null;
    readonly displayId: null;
    readonly includeCommunications: false;
    readonly includeResolvedCases: true;
    readonly language: null;
    readonly maxResults: 100;
  };
  readonly response: {
    readonly cases: readonly AwsSupportSanitizedCase[];
    readonly nextCursorEvidenceHash: string | null;
  };
}

export interface AwsSupportSanitizedCommunication {
  readonly caseId: string;
  readonly createdAt: string;
  readonly submittedByKind: AwsSupportActorKind;
  readonly bodyBytes: number;
  readonly bodyEvidenceHash: string;
  readonly submitterEvidenceHash: string;
  readonly attachmentCount: number;
  readonly attachmentEvidenceHash: string;
  readonly metadataEvidenceHash: string;
}

export interface AwsSupportCommunicationPage {
  readonly request: AwsSupportPageCursor & {
    readonly caseId: string;
    readonly afterTime: string;
    readonly beforeTime: string;
    readonly maxResults: 100;
  };
  readonly response: {
    readonly communications: readonly AwsSupportSanitizedCommunication[];
    readonly nextCursorEvidenceHash: string | null;
  };
}

export interface AwsSupportCommunicationSequence {
  readonly caseId: string;
  readonly status: "SUCCEEDED" | "FAILED";
  readonly pages: readonly AwsSupportCommunicationPage[];
  readonly exhausted: boolean;
  /** Provider text is excluded; only an allowlisted code may cross. */
  readonly failureCode: AwsSupportFailureCode | null;
}

interface AwsSupportAccountCaptureBase {
  readonly accountId: string;
  readonly connectionId: string;
  readonly supportPlan: AwsSupportPlan;
  readonly entitlementState: AwsSupportEntitlementState;
  readonly readPermissionsValidated: boolean;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly observedPeakConcurrency: number;
  readonly observedPeakRequestsPerSecond: number;
}

export interface AwsSupportSucceededAccountCapture
  extends AwsSupportAccountCaptureBase {
  readonly status: "SUCCEEDED";
  readonly failureCode: null;
  readonly casePages: readonly AwsSupportCasePage[];
  readonly casesExhausted: boolean;
  readonly communications: readonly AwsSupportCommunicationSequence[];
}

export interface AwsSupportFailedAccountCapture
  extends AwsSupportAccountCaptureBase {
  readonly status: "FAILED";
  readonly failureCode: AwsSupportFailureCode;
  readonly casePages: readonly [];
  readonly casesExhausted: false;
  readonly communications: readonly [];
}

export type AwsSupportAccountCapture =
  | AwsSupportSucceededAccountCapture
  | AwsSupportFailedAccountCapture;

export interface AwsSupportCasesCapture {
  readonly schemaVersion: "sutra.aws-support-cases.capture.v1";
  readonly scope: AwsSupportCasesScope;
  readonly captureId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly window: AwsSupportCollectionWindow;
  readonly intendedAccounts: readonly AwsSupportIntendedAccount[];
  readonly accounts: readonly AwsSupportAccountCapture[];
}

export interface AwsSupportNormalizedCommunicationEvidence {
  readonly createdAt: string;
  readonly submittedByKind: AwsSupportActorKind;
  readonly bodyBytes: number;
  readonly bodyEvidenceHash: string;
  readonly submitterEvidenceHash: string;
  readonly attachmentCount: number;
  readonly attachmentEvidenceHash: string;
  readonly metadataEvidenceHash: string;
}

export interface AwsSupportNormalizedCase {
  readonly accountId: string;
  readonly caseId: string;
  readonly displayId: string;
  readonly categoryCode: string;
  readonly language: string;
  readonly serviceCode: string;
  readonly severity: AwsSupportCaseSeverity;
  readonly status: AwsSupportCaseStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Observation time, not an AWS-provided resolution timestamp. */
  readonly resolvedObservedAt: string | null;
  readonly submittedByKind: AwsSupportActorKind;
  readonly ccRecipientCount: number;
  readonly subjectBytes: number;
  readonly subjectEvidenceHash: string;
  readonly contactEvidenceHash: string;
  readonly metadataEvidenceHash: string;
  readonly communicationCount: number;
  readonly attachmentCount: number;
  readonly communications: readonly AwsSupportNormalizedCommunicationEvidence[];
  readonly communicationsComplete: boolean;
}

export interface AwsSupportAccountCoverage {
  readonly accountId: string;
  readonly connectionId: string;
  readonly supportPlan: AwsSupportPlan;
  readonly entitlementState: AwsSupportEntitlementState;
  readonly readPermissionsValidated: boolean;
  readonly status: "complete" | "partial" | "unavailable";
  readonly casesExhausted: boolean;
  readonly communicationsExhausted: boolean;
  readonly caseCount: number;
  readonly communicationCount: number;
  readonly failureCode: AwsSupportFailureCode | null;
}

export interface AwsSupportCasesSnapshot {
  readonly schemaVersion: "sutra.aws-support-cases.snapshot.v1";
  readonly scope: AwsSupportCasesScope;
  readonly sourceId: "aws_support_cases_organization";
  readonly captureId: string;
  readonly observedAt: string;
  readonly collectionStartedAt: string;
  readonly collectionDurationMs: number;
  readonly window: AwsSupportCollectionWindow;
  readonly configurationState: AwsSupportConfigurationState;
  readonly collectionState: AwsSupportCollectionState;
  readonly intendedAccounts: readonly AwsSupportIntendedAccount[];
  readonly accountCoverage: readonly AwsSupportAccountCoverage[];
  readonly cases: readonly AwsSupportNormalizedCase[];
  readonly evidence: {
    readonly readOperations: typeof AWS_SUPPORT_CASES_READ_OPERATIONS;
    readonly captureBytes: number;
    readonly casePageCount: number;
    readonly communicationPageCount: number;
    readonly providerCaseRetentionMonths: 24;
    readonly limitations: readonly string[];
  };
}

export type AwsSupportCasesErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "BYTE_LIMIT_EXCEEDED"
  | "TIME_LIMIT_EXCEEDED"
  | "PAGE_LIMIT_EXCEEDED"
  | "RECORD_LIMIT_EXCEEDED"
  | "INVALID_PAGINATION"
  | "CONFLICTING_DUPLICATE"
  | "INCOMPLETE_DRILLDOWN"
  | "UNSAFE_CONTENT";

export class AwsSupportCasesError extends Error {
  public readonly code: AwsSupportCasesErrorCode;

  public constructor(code: AwsSupportCasesErrorCode) {
    super("AWS Support cases evidence rejected");
    this.name = "AwsSupportCasesError";
    this.code = code;
  }
}

const CASE_STATUSES = new Set<AwsSupportCaseStatus>([
  "all-open",
  "customer-action-completed",
  "opened",
  "pending-customer-action",
  "reopened",
  "resolved",
  "unassigned",
  "work-in-progress",
]);
const SEVERITIES = new Set<AwsSupportCaseSeverity>([
  "low",
  "normal",
  "high",
  "urgent",
  "critical",
]);
const ACTOR_KINDS = new Set<AwsSupportActorKind>([
  "AWS",
  "CUSTOMER",
  "UNKNOWN",
]);
const SUPPORT_PLANS = new Set<AwsSupportPlan>([
  "business_support_plus",
  "enterprise",
  "unified_operations",
  "business",
  "enterprise_on_ramp",
  "developer",
  "basic",
  "unknown",
  "not_qualifying",
]);
const ENTITLEMENT_STATES = new Set<AwsSupportEntitlementState>([
  "QUALIFYING",
  "NOT_QUALIFYING",
  "UNKNOWN",
]);
const FAILURE_CODES = new Set<AwsSupportFailureCode>([
  "ACCESS_DENIED",
  "SUBSCRIPTION_REQUIRED",
  "CASE_NOT_FOUND",
  "THROTTLED",
  "TIMEOUT",
  "BOUND_REACHED",
  "PROVIDER_UNAVAILABLE",
  "UNKNOWN",
]);

function reject(code: AwsSupportCasesErrorCode): never {
  throw new AwsSupportCasesError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort((left, right) =>
    left.localeCompare(right)
  );
  const expected = [...keys].sort((left, right) => left.localeCompare(right));
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function iso(value: unknown): string | null {
  if (
    typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T/u.test(value)
    || !Number.isFinite(Date.parse(value))
  ) return null;
  return new Date(value).toISOString();
}

function safeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return Number.isSafeInteger(value)
    && Number(value) >= minimum
    && Number(value) <= maximum;
}

function validScope(value: unknown): value is AwsSupportCasesScope {
  if (!isRecord(value)) return false;
  return hasExactKeys(value, [
    "orgId",
    "customerId",
    "connectionId",
    "partition",
    "endpointRegion",
  ])
    && typeof value.orgId === "string"
    && IDENTIFIER.test(value.orgId)
    && typeof value.customerId === "string"
    && IDENTIFIER.test(value.customerId)
    && typeof value.connectionId === "string"
    && CONNECTION_ID.test(value.connectionId)
    && (
      (value.partition === "aws" && value.endpointRegion === "us-east-1")
      || (
        value.partition === "aws-us-gov"
        && value.endpointRegion === "us-gov-west-1"
      )
    );
}

function sameScope(
  left: AwsSupportCasesScope,
  right: AwsSupportCasesScope,
): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId
    && left.partition === right.partition
    && left.endpointRegion === right.endpointRegion;
}

function validateEvidenceHash(value: unknown): value is string {
  return typeof value === "string" && EVIDENCE_HASH.test(value);
}

function serializedBytes(value: unknown, maximum: number): number {
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

function validateIntendedAccounts(
  value: unknown,
): asserts value is readonly AwsSupportIntendedAccount[] {
  if (
    !Array.isArray(value)
    || value.length < 1
    || value.length > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumAccounts
  ) reject("INVALID_INPUT");
  const seenAccounts = new Set<string>();
  const seenConnections = new Set<string>();
  for (const raw of value) {
    if (
      !isRecord(raw)
      || !hasExactKeys(raw, ["accountId", "connectionId"])
      || typeof raw.accountId !== "string"
      || !ACCOUNT_ID.test(raw.accountId)
      || typeof raw.connectionId !== "string"
      || !CONNECTION_ID.test(raw.connectionId)
      || seenAccounts.has(raw.accountId)
      || seenConnections.has(raw.connectionId)
    ) reject("INVALID_INPUT");
    seenAccounts.add(raw.accountId);
    seenConnections.add(raw.connectionId);
  }
  const sorted = [...value].sort((left, right) =>
    String((left as AwsSupportIntendedAccount).accountId).localeCompare(
      String((right as AwsSupportIntendedAccount).accountId),
    )
  );
  if (JSON.stringify(sorted) !== JSON.stringify(value)) {
    reject("INVALID_INPUT");
  }
}

function sameAccounts(
  left: readonly AwsSupportIntendedAccount[],
  right: readonly AwsSupportIntendedAccount[],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateWindow(
  value: unknown,
  completedAtMs: number,
): asserts value is AwsSupportCollectionWindow {
  if (!isRecord(value)) reject("INVALID_INPUT");
  if (
    !hasExactKeys(value, [
      "mode",
      "afterTime",
      "beforeTime",
      "priorWatermark",
      "nextWatermark",
    ])
  ) reject("UNSAFE_CONTENT");
  const afterTime = iso(value.afterTime);
  const beforeTime = iso(value.beforeTime);
  const priorWatermark = value.priorWatermark === null
    ? null
    : iso(value.priorWatermark);
  const nextWatermark = iso(value.nextWatermark);
  if (
    (value.mode !== "INITIAL" && value.mode !== "INCREMENTAL")
    || afterTime === null
    || beforeTime === null
    || nextWatermark === null
    || (value.priorWatermark !== null && priorWatermark === null)
    || Date.parse(afterTime) >= Date.parse(beforeTime)
    || nextWatermark !== beforeTime
    || Date.parse(beforeTime) > completedAtMs + MAX_CLOCK_SKEW_MS
  ) reject("INVALID_INPUT");
  const durationMs = Date.parse(beforeTime) - Date.parse(afterTime);
  if (value.mode === "INITIAL") {
    if (
      priorWatermark !== null
      || durationMs
        > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumInitialLookbackDays
          * DAY_MS
    ) reject("TIME_LIMIT_EXCEEDED");
  } else if (
    priorWatermark === null
    || Date.parse(beforeTime) <= Date.parse(priorWatermark)
    || Date.parse(afterTime) > Date.parse(priorWatermark)
    || Date.parse(priorWatermark) - Date.parse(afterTime)
      > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumIncrementalOverlapHours
        * HOUR_MS
    || durationMs
      > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumIncrementalWindowDays
        * DAY_MS
  ) reject("TIME_LIMIT_EXCEEDED");
}

function validateCursorChain<T extends {
  readonly request: AwsSupportPageCursor;
  readonly response: { readonly nextCursorEvidenceHash: string | null };
}>(pages: readonly T[], exhausted: boolean): void {
  if (pages.length === 0) reject("INVALID_PAGINATION");
  let expectedCursor: string | null = null;
  const seen = new Set<string>();
  for (const [index, page] of pages.entries()) {
    if (
      !isRecord(page)
      || !isRecord(page.request)
      || !isRecord(page.response)
      || page.request.pageIndex !== index
      || page.request.cursorEvidenceHash !== expectedCursor
      || (
        page.request.cursorEvidenceHash !== null
        && !validateEvidenceHash(page.request.cursorEvidenceHash)
      )
      || (
        page.response.nextCursorEvidenceHash !== null
        && !validateEvidenceHash(page.response.nextCursorEvidenceHash)
      )
    ) reject("INVALID_PAGINATION");
    if (
      page.request.cursorEvidenceHash !== null
      && seen.has(page.request.cursorEvidenceHash)
    ) reject("INVALID_PAGINATION");
    if (page.request.cursorEvidenceHash !== null) {
      seen.add(page.request.cursorEvidenceHash);
    }
    if (
      page.response.nextCursorEvidenceHash !== null
      && seen.has(page.response.nextCursorEvidenceHash)
    ) reject("INVALID_PAGINATION");
    expectedCursor = page.response.nextCursorEvidenceHash;
  }
  if (exhausted !== (expectedCursor === null)) {
    reject("INVALID_PAGINATION");
  }
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

function validateAccountBase(
  value: unknown,
  intended: AwsSupportIntendedAccount,
): asserts value is AwsSupportAccountCapture {
  if (
    !isRecord(value)
    || !hasExactKeys(
      value,
      value.status === "SUCCEEDED"
        ? [
          "accountId",
          "connectionId",
          "supportPlan",
          "entitlementState",
          "readPermissionsValidated",
          "startedAt",
          "completedAt",
          "observedPeakConcurrency",
          "observedPeakRequestsPerSecond",
          "status",
          "failureCode",
          "casePages",
          "casesExhausted",
          "communications",
        ]
        : [
          "accountId",
          "connectionId",
          "supportPlan",
          "entitlementState",
          "readPermissionsValidated",
          "startedAt",
          "completedAt",
          "observedPeakConcurrency",
          "observedPeakRequestsPerSecond",
          "status",
          "failureCode",
          "casePages",
          "casesExhausted",
          "communications",
        ],
    )
    || value.accountId !== intended.accountId
    || value.connectionId !== intended.connectionId
    || (value.status !== "SUCCEEDED" && value.status !== "FAILED")
    || typeof value.supportPlan !== "string"
    || !SUPPORT_PLANS.has(value.supportPlan as AwsSupportPlan)
    || typeof value.entitlementState !== "string"
    || !ENTITLEMENT_STATES.has(
      value.entitlementState as AwsSupportEntitlementState,
    )
    || typeof value.readPermissionsValidated !== "boolean"
    || iso(value.startedAt) === null
    || iso(value.completedAt) === null
    || Date.parse(value.startedAt as string) > Date.parse(value.completedAt as string)
    || Date.parse(value.completedAt as string) - Date.parse(value.startedAt as string)
      > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumDurationMs
    || !safeInteger(
      value.observedPeakConcurrency,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumConcurrency,
    )
    || !safeInteger(
      value.observedPeakRequestsPerSecond,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumRequestsPerSecondPerAccount,
    )
    || (
      ["basic", "developer", "not_qualifying"].includes(
        String(value.supportPlan),
      )
      && value.entitlementState === "QUALIFYING"
    )
    || (
      value.status === "SUCCEEDED"
      && value.entitlementState === "NOT_QUALIFYING"
    )
    || !Array.isArray(value.casePages)
    || typeof value.casesExhausted !== "boolean"
    || !Array.isArray(value.communications)
  ) reject("SCOPE_MISMATCH");
}

function normalizeSanitizedCase(
  value: unknown,
  accountId: string,
  observedAt: string,
): AwsSupportNormalizedCase {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "caseId",
      "displayId",
      "categoryCode",
      "language",
      "serviceCode",
      "severityCode",
      "status",
      "createdAt",
      "submittedByKind",
      "ccRecipientCount",
      "subjectBytes",
      "subjectEvidenceHash",
      "contactEvidenceHash",
      "metadataEvidenceHash",
      "recentCommunicationsOmitted",
    ])
    || typeof value.caseId !== "string"
    || !CASE_ID.test(value.caseId)
    || typeof value.displayId !== "string"
    || !DISPLAY_ID.test(value.displayId)
    || typeof value.categoryCode !== "string"
    || !SAFE_CODE.test(value.categoryCode)
    || typeof value.language !== "string"
    || !/^[a-z]{2}$/u.test(value.language)
    || typeof value.serviceCode !== "string"
    || !SAFE_CODE.test(value.serviceCode)
    || typeof value.severityCode !== "string"
    || !SEVERITIES.has(value.severityCode as AwsSupportCaseSeverity)
    || typeof value.status !== "string"
    || !CASE_STATUSES.has(value.status as AwsSupportCaseStatus)
    || iso(value.createdAt) === null
    || typeof value.submittedByKind !== "string"
    || !ACTOR_KINDS.has(value.submittedByKind as AwsSupportActorKind)
    || !safeInteger(value.ccRecipientCount, 0, 10)
    || !safeInteger(
      value.subjectBytes,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumTextBytes,
    )
    || !validateEvidenceHash(value.subjectEvidenceHash)
    || !validateEvidenceHash(value.contactEvidenceHash)
    || !validateEvidenceHash(value.metadataEvidenceHash)
    || value.recentCommunicationsOmitted !== true
    || Date.parse(value.createdAt as string)
      > Date.parse(observedAt) + MAX_CLOCK_SKEW_MS
  ) reject("UNSAFE_CONTENT");
  return {
    accountId,
    caseId: value.caseId,
    displayId: value.displayId,
    categoryCode: value.categoryCode,
    language: value.language,
    serviceCode: value.serviceCode,
    severity: value.severityCode as AwsSupportCaseSeverity,
    status: value.status as AwsSupportCaseStatus,
    createdAt: iso(value.createdAt) as string,
    updatedAt: iso(value.createdAt) as string,
    resolvedObservedAt: value.status === "resolved" ? observedAt : null,
    submittedByKind: value.submittedByKind as AwsSupportActorKind,
    ccRecipientCount: value.ccRecipientCount,
    subjectBytes: value.subjectBytes,
    subjectEvidenceHash: value.subjectEvidenceHash,
    contactEvidenceHash: value.contactEvidenceHash,
    metadataEvidenceHash: value.metadataEvidenceHash,
    communicationCount: 0,
    attachmentCount: 0,
    communications: [],
    communicationsComplete: false,
  };
}

function normalizeCommunication(
  value: unknown,
  caseId: string,
  observedAt: string,
): AwsSupportNormalizedCommunicationEvidence {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "caseId",
      "createdAt",
      "submittedByKind",
      "bodyBytes",
      "bodyEvidenceHash",
      "submitterEvidenceHash",
      "attachmentCount",
      "attachmentEvidenceHash",
      "metadataEvidenceHash",
    ])
    || value.caseId !== caseId
    || iso(value.createdAt) === null
    || typeof value.submittedByKind !== "string"
    || !ACTOR_KINDS.has(value.submittedByKind as AwsSupportActorKind)
    || !safeInteger(
      value.bodyBytes,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumTextBytes,
    )
    || !validateEvidenceHash(value.bodyEvidenceHash)
    || !validateEvidenceHash(value.submitterEvidenceHash)
    || !safeInteger(
      value.attachmentCount,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumAttachmentsPerCommunication,
    )
    || !validateEvidenceHash(value.attachmentEvidenceHash)
    || !validateEvidenceHash(value.metadataEvidenceHash)
    || Date.parse(value.createdAt as string)
      > Date.parse(observedAt) + MAX_CLOCK_SKEW_MS
  ) reject("UNSAFE_CONTENT");
  return {
    createdAt: iso(value.createdAt) as string,
    submittedByKind: value.submittedByKind as AwsSupportActorKind,
    bodyBytes: value.bodyBytes,
    bodyEvidenceHash: value.bodyEvidenceHash,
    submitterEvidenceHash: value.submitterEvidenceHash,
    attachmentCount: value.attachmentCount,
    attachmentEvidenceHash: value.attachmentEvidenceHash,
    metadataEvidenceHash: value.metadataEvidenceHash,
  };
}

function accountConfigurationState(
  account: AwsSupportAccountCapture,
): AwsSupportConfigurationState {
  if (
    account.entitlementState === "NOT_QUALIFYING"
    || account.failureCode === "SUBSCRIPTION_REQUIRED"
  ) return "unavailable";
  if (
    account.entitlementState === "UNKNOWN"
    || account.supportPlan === "unknown"
  ) return "unverified";
  if (!account.readPermissionsValidated) return "partial";
  return "ready";
}

export function normalizeAwsSupportCasesCapture(
  input: unknown,
  boundary: AwsSupportCasesBoundary,
  nowMs = Date.now(),
): AwsSupportCasesSnapshot {
  if (
    !isRecord(input)
    || !hasExactKeys(input, [
      "schemaVersion",
      "scope",
      "captureId",
      "startedAt",
      "completedAt",
      "window",
      "intendedAccounts",
      "accounts",
    ])
    || !isRecord(boundary)
    || !hasExactKeys(boundary, [
      "scope",
      "binding",
      "intendedAccounts",
    ])
    || !validScope(boundary.scope)
    || boundary.binding !== "SERVER_RESOLVED_CONNECTIONS"
    || !Number.isFinite(nowMs)
  ) reject("INVALID_INPUT");
  validateIntendedAccounts(boundary.intendedAccounts);
  if (
    input.schemaVersion !== "sutra.aws-support-cases.capture.v1"
    || !validScope(input.scope)
    || !sameScope(input.scope, boundary.scope)
    || typeof input.captureId !== "string"
    || !CAPTURE_ID.test(input.captureId)
    || iso(input.startedAt) === null
    || iso(input.completedAt) === null
    || Date.parse(input.startedAt as string) > Date.parse(input.completedAt as string)
    || Date.parse(input.completedAt as string) > nowMs + MAX_CLOCK_SKEW_MS
    || Date.parse(input.completedAt as string) - Date.parse(input.startedAt as string)
      > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumDurationMs
  ) reject("SCOPE_MISMATCH");
  validateIntendedAccounts(input.intendedAccounts);
  if (!sameAccounts(input.intendedAccounts, boundary.intendedAccounts)) {
    reject("SCOPE_MISMATCH");
  }
  const completedAt = iso(input.completedAt) as string;
  validateWindow(input.window, Date.parse(completedAt));
  const captureBytes = serializedBytes(
    input,
    AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCaptureBytes,
  );
  if (!Array.isArray(input.accounts)) reject("INVALID_INPUT");
  const accountMap = new Map<string, AwsSupportAccountCapture>();
  for (const account of input.accounts) {
    if (!isRecord(account) || typeof account.accountId !== "string") {
      reject("INVALID_INPUT");
    }
    const intended = boundary.intendedAccounts.find((candidate) =>
      candidate.accountId === account.accountId
    );
    if (intended === undefined || accountMap.has(account.accountId)) {
      reject("SCOPE_MISMATCH");
    }
    validateAccountBase(account, intended);
    if (
      Date.parse(account.startedAt as string) < Date.parse(input.startedAt as string)
      || Date.parse(account.completedAt as string) > Date.parse(input.completedAt as string)
    ) reject("TIME_LIMIT_EXCEEDED");
    accountMap.set(account.accountId, account);
  }
  if (accountMap.size !== boundary.intendedAccounts.length) {
    reject("SCOPE_MISMATCH");
  }

  let casePageCount = 0;
  let communicationPageCount = 0;
  let communicationCount = 0;
  const normalizedCases: AwsSupportNormalizedCase[] = [];
  const accountCoverage: AwsSupportAccountCoverage[] = [];
  const configurationStates: AwsSupportConfigurationState[] = [];

  for (const intended of boundary.intendedAccounts) {
    const account = accountMap.get(intended.accountId) as AwsSupportAccountCapture;
    const configuration = accountConfigurationState(account);
    configurationStates.push(configuration);
    if (account.status === "FAILED") {
      if (
        account.casePages.length !== 0
        || account.communications.length !== 0
        || account.casesExhausted
        || account.failureCode === null
        || !FAILURE_CODES.has(account.failureCode)
      ) reject("INVALID_INPUT");
      accountCoverage.push({
        accountId: account.accountId,
        connectionId: account.connectionId,
        supportPlan: account.supportPlan,
        entitlementState: account.entitlementState,
        readPermissionsValidated: account.readPermissionsValidated,
        status: "unavailable",
        casesExhausted: false,
        communicationsExhausted: false,
        caseCount: 0,
        communicationCount: 0,
        failureCode: account.failureCode,
      });
      continue;
    }
    if (account.failureCode !== null || !Array.isArray(account.casePages)) {
      reject("INVALID_INPUT");
    }
    validateCursorChain(account.casePages, account.casesExhausted);
    casePageCount += account.casePages.length;
    const cases = new Map<string, AwsSupportNormalizedCase>();
    for (const page of account.casePages) {
      if (
        !isRecord(page)
        || !hasExactKeys(page, ["request", "response"])
        || !isRecord(page.request)
        || !hasExactKeys(page.request, [
          "pageIndex",
          "cursorEvidenceHash",
          "afterTime",
          "beforeTime",
          "caseIdList",
          "displayId",
          "includeCommunications",
          "includeResolvedCases",
          "language",
          "maxResults",
        ])
        || !isRecord(page.response)
        || !hasExactKeys(page.response, [
          "cases",
          "nextCursorEvidenceHash",
        ])
        || page.request.afterTime !== input.window.afterTime
        || page.request.beforeTime !== input.window.beforeTime
        || page.request.caseIdList !== null
        || page.request.displayId !== null
        || page.request.includeCommunications !== false
        || page.request.includeResolvedCases !== true
        || page.request.language !== null
        || page.request.maxResults
          !== AWS_SUPPORT_CASES_COLLECTION_BOUNDS.casePageSize
        || !Array.isArray(page.response.cases)
        || page.response.cases.length
          > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.casePageSize
      ) reject("INVALID_INPUT");
      for (const rawCase of page.response.cases) {
        const normalized = normalizeSanitizedCase(
          rawCase,
          account.accountId,
          completedAt,
        );
        addDeterministic(cases, normalized.caseId, normalized);
      }
    }
    if (cases.size > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCases) {
      reject("RECORD_LIMIT_EXCEEDED");
    }
    if (!Array.isArray(account.communications)) reject("INVALID_INPUT");
    const sequences = new Map<string, AwsSupportCommunicationSequence>();
    for (const sequence of account.communications) {
      if (
        !isRecord(sequence)
        || !hasExactKeys(sequence, [
          "caseId",
          "status",
          "pages",
          "exhausted",
          "failureCode",
        ])
        || typeof sequence.caseId !== "string"
        || !cases.has(sequence.caseId)
        || sequences.has(sequence.caseId)
        || !Array.isArray(sequence.pages)
      ) reject("INCOMPLETE_DRILLDOWN");
      sequences.set(
        sequence.caseId,
        sequence as unknown as AwsSupportCommunicationSequence,
      );
    }
    if (sequences.size !== cases.size) reject("INCOMPLETE_DRILLDOWN");

    let allCommunicationsExhausted = true;
    let accountCommunicationCount = 0;
    for (const [caseId, current] of cases) {
      const sequence = sequences.get(caseId) as AwsSupportCommunicationSequence;
      if (sequence.status === "FAILED") {
        if (
          sequence.pages.length !== 0
          || sequence.exhausted
          || sequence.failureCode === null
          || !FAILURE_CODES.has(sequence.failureCode)
        ) reject("INVALID_INPUT");
        allCommunicationsExhausted = false;
        cases.set(caseId, { ...current, communicationsComplete: false });
        continue;
      }
      if (sequence.failureCode !== null) reject("INVALID_INPUT");
      validateCursorChain(sequence.pages, sequence.exhausted);
      allCommunicationsExhausted &&= sequence.exhausted;
      communicationPageCount += sequence.pages.length;
      const communications = new Map<
        string,
        AwsSupportNormalizedCommunicationEvidence
      >();
      for (const page of sequence.pages) {
        if (
          !isRecord(page)
          || !hasExactKeys(page, ["request", "response"])
          || !isRecord(page.request)
          || !hasExactKeys(page.request, [
            "pageIndex",
            "cursorEvidenceHash",
            "caseId",
            "afterTime",
            "beforeTime",
            "maxResults",
          ])
          || !isRecord(page.response)
          || !hasExactKeys(page.response, [
            "communications",
            "nextCursorEvidenceHash",
          ])
          || page.request.caseId !== caseId
          || page.request.afterTime !== input.window.afterTime
          || page.request.beforeTime !== input.window.beforeTime
          || page.request.maxResults
            !== AWS_SUPPORT_CASES_COLLECTION_BOUNDS.communicationPageSize
          || !Array.isArray(page.response.communications)
          || page.response.communications.length
            > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.communicationPageSize
        ) reject("INVALID_INPUT");
        for (const rawCommunication of page.response.communications) {
          const normalized = normalizeCommunication(
            rawCommunication,
            caseId,
            completedAt,
          );
          if (normalized.createdAt < current.createdAt) {
            reject("INVALID_INPUT");
          }
          addDeterministic(
            communications,
            normalized.metadataEvidenceHash,
            normalized,
          );
        }
      }
      const ordered = [...communications.values()].sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt)
        || left.metadataEvidenceHash.localeCompare(right.metadataEvidenceHash)
      );
      accountCommunicationCount += ordered.length;
      communicationCount += ordered.length;
      const updatedAt = ordered.reduce(
        (latest, communication) =>
          communication.createdAt > latest ? communication.createdAt : latest,
        current.createdAt,
      );
      cases.set(caseId, {
        ...current,
        updatedAt,
        communications: ordered,
        communicationCount: ordered.length,
        attachmentCount: ordered.reduce(
          (total, communication) => total + communication.attachmentCount,
          0,
        ),
        communicationsComplete: sequence.exhausted,
      });
    }
    const complete = configuration === "ready"
      && account.casesExhausted
      && allCommunicationsExhausted;
    normalizedCases.push(...cases.values());
    accountCoverage.push({
      accountId: account.accountId,
      connectionId: account.connectionId,
      supportPlan: account.supportPlan,
      entitlementState: account.entitlementState,
      readPermissionsValidated: account.readPermissionsValidated,
      status: complete ? "complete" : "partial",
      casesExhausted: account.casesExhausted,
      communicationsExhausted: allCommunicationsExhausted,
      caseCount: cases.size,
      communicationCount: accountCommunicationCount,
      failureCode: null,
    });
  }
  if (
    casePageCount > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCasePages
    || communicationPageCount
      > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCommunicationPages
  ) reject("PAGE_LIMIT_EXCEEDED");
  if (
    normalizedCases.length > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCases
    || communicationCount
      > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCommunications
  ) reject("RECORD_LIMIT_EXCEEDED");

  const configurationState: AwsSupportConfigurationState =
    configurationStates.every((state) => state === "ready")
      ? "ready"
      : configurationStates.every((state) => state === "unavailable")
        ? "unavailable"
        : configurationStates.some((state) => state === "unverified")
          ? "unverified"
          : "partial";
  const collectionState: AwsSupportCollectionState = accountCoverage.every(
      (account) => account.status === "complete",
    )
    ? "complete"
    : accountCoverage.every((account) => account.status === "unavailable")
      ? "unavailable"
      : "partial";
  const limitations = [
    "AWS Support cases are account-local; organization coverage is Sutra fan-out over the explicit intended-account set, not an AWS organization-wide case API.",
    "AWS retains case data for 24 months; older history is unavailable unless Sutra previously persisted bounded snapshots.",
    "Raw case subjects, communication bodies, submitter names or email addresses, CC addresses, attachment identifiers, names or URLs, pagination tokens, and provider messages are excluded; only allowlisted metadata, counts, timestamps, and keyed evidence hashes are retained.",
    "The resolved observation time is when Sutra first observed the resolved status, not an AWS-provided resolution timestamp.",
    "AWS afterTime and beforeTime filter case communications. Incremental windows can miss a status-only change, so a periodic full retained-window reconciliation is required for current status assurance.",
    "A complete empty response proves only that each intended account returned no cases in the bounded provider window.",
  ];
  if (collectionState !== "complete") {
    limitations.push(
      "At least one intended account, case pagination chain, or communication pagination chain is incomplete or unavailable.",
    );
  }

  return {
    schemaVersion: "sutra.aws-support-cases.snapshot.v1",
    scope: { ...boundary.scope },
    sourceId: "aws_support_cases_organization",
    captureId: input.captureId,
    observedAt: completedAt,
    collectionStartedAt: iso(input.startedAt) as string,
    collectionDurationMs:
      Date.parse(completedAt) - Date.parse(input.startedAt as string),
    window: { ...(input.window as unknown as AwsSupportCollectionWindow) },
    configurationState,
    collectionState,
    intendedAccounts: boundary.intendedAccounts.map((account) => ({ ...account })),
    accountCoverage,
    cases: normalizedCases.sort((left, right) =>
      left.accountId.localeCompare(right.accountId)
      || left.caseId.localeCompare(right.caseId)
    ),
    evidence: {
      readOperations: AWS_SUPPORT_CASES_READ_OPERATIONS,
      captureBytes,
      casePageCount,
      communicationPageCount,
      providerCaseRetentionMonths: 24,
      limitations,
    },
  };
}

export function awsSupportCasesSourceEvidence(
  snapshot: AwsSupportCasesSnapshot,
): FinopsSourceEvidence {
  if (
    !isRecord(snapshot)
    || !validScope(snapshot.scope)
    || !Array.isArray(snapshot.intendedAccounts)
  ) {
    reject("INVALID_INPUT");
  }
  validateIntendedAccounts(snapshot.intendedAccounts);
  validatePersistedSnapshot(snapshot, {
    scope: snapshot.scope,
    binding: "SERVER_RESOLVED_CONNECTIONS",
    intendedAccounts: snapshot.intendedAccounts,
  });
  const failed = snapshot.accountCoverage.filter((account) =>
    account.status !== "complete"
  );
  return {
    scope: snapshot.scope,
    sourceId: "aws_support_cases_organization",
    configured: snapshot.configurationState !== "unavailable",
    deliveryObserved: snapshot.collectionState !== "unavailable",
    lastAttemptAt: snapshot.observedAt,
    lastAttemptOutcome: snapshot.collectionState === "complete"
      ? "succeeded"
      : snapshot.collectionState === "partial"
        ? "partial"
        : "failed",
    lastSuccessAt: snapshot.collectionState === "complete"
      ? snapshot.observedAt
      : null,
    dataThroughAt: snapshot.collectionState === "complete"
      ? snapshot.window.nextWatermark
      : null,
    coverage: {
      assessment: snapshot.collectionState === "complete"
        ? "complete"
        : snapshot.collectionState === "partial"
          ? "partial"
          : "unknown",
      acceptedRecords: snapshot.accountCoverage.filter((account) =>
        account.status === "complete"
      ).length,
      expectedRecords: snapshot.intendedAccounts.length,
      rejectedRecords: failed.length,
    },
    lastError: failed.length === 0
      ? null
      : {
        code: "ACCOUNT_COVERAGE_INCOMPLETE",
        message: "AWS Support account coverage is incomplete.",
        at: snapshot.observedAt,
      },
    evidenceBasis:
      "Bounded account-local DescribeCases and DescribeCommunications captures for every server-resolved intended account. Raw correspondence and personal identifiers are excluded.",
    limitations: snapshot.evidence.limitations,
  };
}

export interface AwsSupportCasesDashboardOptions {
  readonly accountId?: string;
  readonly status?: AwsSupportCaseStatus;
  readonly severity?: AwsSupportCaseSeverity;
  readonly serviceCode?: string;
  readonly categoryCode?: string;
  readonly includeSafeSummaries?: boolean;
  readonly caseLimit?: number;
}

function validatePersistedCommunication(
  value: unknown,
  observedAt: string,
): asserts value is AwsSupportNormalizedCommunicationEvidence {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "createdAt",
      "submittedByKind",
      "bodyBytes",
      "bodyEvidenceHash",
      "submitterEvidenceHash",
      "attachmentCount",
      "attachmentEvidenceHash",
      "metadataEvidenceHash",
    ])
    || iso(value.createdAt) === null
    || Date.parse(value.createdAt as string)
      > Date.parse(observedAt) + MAX_CLOCK_SKEW_MS
    || typeof value.submittedByKind !== "string"
    || !ACTOR_KINDS.has(value.submittedByKind as AwsSupportActorKind)
    || !safeInteger(
      value.bodyBytes,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumTextBytes,
    )
    || !validateEvidenceHash(value.bodyEvidenceHash)
    || !validateEvidenceHash(value.submitterEvidenceHash)
    || !safeInteger(
      value.attachmentCount,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumAttachmentsPerCommunication,
    )
    || !validateEvidenceHash(value.attachmentEvidenceHash)
    || !validateEvidenceHash(value.metadataEvidenceHash)
  ) reject("UNSAFE_CONTENT");
}

function validatePersistedCase(
  value: unknown,
  intendedAccounts: readonly AwsSupportIntendedAccount[],
  observedAt: string,
): asserts value is AwsSupportNormalizedCase {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "accountId",
      "caseId",
      "displayId",
      "categoryCode",
      "language",
      "serviceCode",
      "severity",
      "status",
      "createdAt",
      "updatedAt",
      "resolvedObservedAt",
      "submittedByKind",
      "ccRecipientCount",
      "subjectBytes",
      "subjectEvidenceHash",
      "contactEvidenceHash",
      "metadataEvidenceHash",
      "communicationCount",
      "attachmentCount",
      "communications",
      "communicationsComplete",
    ])
    || typeof value.accountId !== "string"
    || !intendedAccounts.some((account) =>
      account.accountId === value.accountId
    )
    || typeof value.caseId !== "string"
    || !CASE_ID.test(value.caseId)
    || typeof value.displayId !== "string"
    || !DISPLAY_ID.test(value.displayId)
    || typeof value.categoryCode !== "string"
    || !SAFE_CODE.test(value.categoryCode)
    || typeof value.language !== "string"
    || !/^[a-z]{2}$/u.test(value.language)
    || typeof value.serviceCode !== "string"
    || !SAFE_CODE.test(value.serviceCode)
    || typeof value.severity !== "string"
    || !SEVERITIES.has(value.severity as AwsSupportCaseSeverity)
    || typeof value.status !== "string"
    || !CASE_STATUSES.has(value.status as AwsSupportCaseStatus)
    || iso(value.createdAt) === null
    || iso(value.updatedAt) === null
    || Date.parse(value.createdAt as string) > Date.parse(value.updatedAt as string)
    || Date.parse(value.updatedAt as string)
      > Date.parse(observedAt) + MAX_CLOCK_SKEW_MS
    || (
      value.resolvedObservedAt !== null
      && (
        iso(value.resolvedObservedAt) === null
        || value.status !== "resolved"
        || Date.parse(value.resolvedObservedAt as string)
          > Date.parse(observedAt) + MAX_CLOCK_SKEW_MS
      )
    )
    || ((value.status === "resolved") !== (value.resolvedObservedAt !== null))
    || typeof value.submittedByKind !== "string"
    || !ACTOR_KINDS.has(value.submittedByKind as AwsSupportActorKind)
    || !safeInteger(value.ccRecipientCount, 0, 10)
    || !safeInteger(
      value.subjectBytes,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumTextBytes,
    )
    || !validateEvidenceHash(value.subjectEvidenceHash)
    || !validateEvidenceHash(value.contactEvidenceHash)
    || !validateEvidenceHash(value.metadataEvidenceHash)
    || !safeInteger(
      value.communicationCount,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCommunications,
    )
    || !safeInteger(
      value.attachmentCount,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCommunications
        * AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumAttachmentsPerCommunication,
    )
    || !Array.isArray(value.communications)
    || value.communicationCount !== value.communications.length
    || typeof value.communicationsComplete !== "boolean"
  ) reject("UNSAFE_CONTENT");
  const communicationMap = new Map<
    string,
    AwsSupportNormalizedCommunicationEvidence
  >();
  for (const communication of value.communications) {
    validatePersistedCommunication(communication, observedAt);
    addDeterministic(
      communicationMap,
      communication.metadataEvidenceHash,
      communication,
    );
  }
  const expectedUpdatedAt = value.communications.reduce(
    (latest, communication) =>
      communication.createdAt > latest ? communication.createdAt : latest,
    value.createdAt as string,
  );
  if (
    communicationMap.size !== value.communications.length
    || value.updatedAt !== expectedUpdatedAt
    || value.attachmentCount !== value.communications.reduce(
      (total, communication) => total + communication.attachmentCount,
      0,
    )
  ) reject("INVALID_INPUT");
}

function validatePersistedSnapshot(
  value: unknown,
  boundary: AwsSupportCasesBoundary,
): asserts value is AwsSupportCasesSnapshot {
  if (
    !isRecord(value)
    || !hasExactKeys(value, [
      "schemaVersion",
      "scope",
      "sourceId",
      "captureId",
      "observedAt",
      "collectionStartedAt",
      "collectionDurationMs",
      "window",
      "configurationState",
      "collectionState",
      "intendedAccounts",
      "accountCoverage",
      "cases",
      "evidence",
    ])
    || value.schemaVersion !== "sutra.aws-support-cases.snapshot.v1"
    || value.sourceId !== "aws_support_cases_organization"
    || !validScope(value.scope)
    || !sameScope(value.scope, boundary.scope)
    || typeof value.captureId !== "string"
    || !CAPTURE_ID.test(value.captureId)
    || iso(value.observedAt) === null
    || iso(value.collectionStartedAt) === null
    || !safeInteger(
      value.collectionDurationMs,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumDurationMs,
    )
    || (
      value.configurationState !== "ready"
      && value.configurationState !== "partial"
      && value.configurationState !== "unavailable"
      && value.configurationState !== "unverified"
    )
    || (
      value.collectionState !== "complete"
      && value.collectionState !== "partial"
      && value.collectionState !== "unavailable"
    )
  ) reject("SCOPE_MISMATCH");
  validateWindow(value.window, Date.parse(value.observedAt as string));
  validateIntendedAccounts(value.intendedAccounts);
  if (!sameAccounts(value.intendedAccounts, boundary.intendedAccounts)) {
    reject("SCOPE_MISMATCH");
  }
  if (
    !Array.isArray(value.accountCoverage)
    || value.accountCoverage.length !== value.intendedAccounts.length
    || !Array.isArray(value.cases)
    || !isRecord(value.evidence)
    || !hasExactKeys(value.evidence, [
      "readOperations",
      "captureBytes",
      "casePageCount",
      "communicationPageCount",
      "providerCaseRetentionMonths",
      "limitations",
    ])
    || JSON.stringify(value.evidence.readOperations)
      !== JSON.stringify(AWS_SUPPORT_CASES_READ_OPERATIONS)
    || !safeInteger(
      value.evidence.captureBytes,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCaptureBytes,
    )
    || !safeInteger(
      value.evidence.casePageCount,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCasePages,
    )
    || !safeInteger(
      value.evidence.communicationPageCount,
      0,
      AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCommunicationPages,
    )
    || value.evidence.providerCaseRetentionMonths !== 24
    || !Array.isArray(value.evidence.limitations)
    || !value.evidence.limitations.every((limitation) =>
      typeof limitation === "string"
      && limitation.length > 0
      && limitation.length <= 1_000
      && !limitation.includes("\0")
    )
  ) reject("UNSAFE_CONTENT");
  const coveredAccounts = new Set<string>();
  for (const coverage of value.accountCoverage) {
    if (
      !isRecord(coverage)
      || !hasExactKeys(coverage, [
        "accountId",
        "connectionId",
        "supportPlan",
        "entitlementState",
        "readPermissionsValidated",
        "status",
        "casesExhausted",
        "communicationsExhausted",
        "caseCount",
        "communicationCount",
        "failureCode",
      ])
      || typeof coverage.accountId !== "string"
      || coveredAccounts.has(coverage.accountId)
      || !value.intendedAccounts.some((account) =>
        account.accountId === coverage.accountId
        && account.connectionId === coverage.connectionId
      )
      || typeof coverage.supportPlan !== "string"
      || !SUPPORT_PLANS.has(coverage.supportPlan as AwsSupportPlan)
      || typeof coverage.entitlementState !== "string"
      || !ENTITLEMENT_STATES.has(
        coverage.entitlementState as AwsSupportEntitlementState,
      )
      || typeof coverage.readPermissionsValidated !== "boolean"
      || (
        coverage.status !== "complete"
        && coverage.status !== "partial"
        && coverage.status !== "unavailable"
      )
      || typeof coverage.casesExhausted !== "boolean"
      || typeof coverage.communicationsExhausted !== "boolean"
      || !safeInteger(
        coverage.caseCount,
        0,
        AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCases,
      )
      || !safeInteger(
        coverage.communicationCount,
        0,
        AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCommunications,
      )
      || (
        coverage.failureCode !== null
        && (
          typeof coverage.failureCode !== "string"
          || !FAILURE_CODES.has(coverage.failureCode as AwsSupportFailureCode)
        )
      )
    ) reject("INVALID_INPUT");
    coveredAccounts.add(coverage.accountId);
  }
  const caseMap = new Map<string, AwsSupportNormalizedCase>();
  for (const supportCase of value.cases) {
    validatePersistedCase(
      supportCase,
      value.intendedAccounts,
      value.observedAt as string,
    );
    addDeterministic(
      caseMap,
      `${supportCase.accountId}\0${supportCase.caseId}`,
      supportCase,
    );
  }
  if (caseMap.size !== value.cases.length) reject("CONFLICTING_DUPLICATE");
  for (const coverage of value.accountCoverage) {
    const accountCases = value.cases.filter((supportCase) =>
      supportCase.accountId === coverage.accountId
    );
    if (
      coverage.caseCount !== accountCases.length
      || coverage.communicationCount !== accountCases.reduce(
        (total, supportCase) => total + supportCase.communicationCount,
        0,
      )
      || (
        coverage.status === "complete"
        && (
          coverage.entitlementState !== "QUALIFYING"
          || !coverage.readPermissionsValidated
          || !coverage.casesExhausted
          || !coverage.communicationsExhausted
          || coverage.failureCode !== null
        )
      )
      || (
        coverage.status === "unavailable"
        && coverage.failureCode === null
      )
    ) reject("INVALID_INPUT");
  }
}

export interface AwsSupportSafeCaseSummary {
  readonly synopsis: string;
  readonly evidenceHashes: readonly string[];
  readonly disclosure: string;
}

export interface AwsSupportDashboardCase extends AwsSupportNormalizedCase {
  readonly firstObservedAt: string;
  readonly resolvedObservedAt: string | null;
  readonly observationCount: number;
  readonly safeSummary: AwsSupportSafeCaseSummary | null;
}

export interface AwsSupportCasesRadarDashboard {
  readonly scope: AwsSupportCasesScope;
  readonly generatedAt: string;
  readonly source: {
    readonly sourceId: "aws_support_cases_organization";
    readonly latestCaptureId: string;
    readonly latestObservedAt: string;
    readonly configurationState: AwsSupportConfigurationState;
    readonly collectionState: AwsSupportCollectionState;
    readonly freshness: "fresh" | "stale";
    readonly historyCoverage: "observed_snapshots_only";
    readonly watermarkCoverage: "continuous" | "partial";
    readonly organizationCoverageClaimed: false;
    readonly accountCoverage: readonly AwsSupportAccountCoverage[];
    readonly limitations: readonly string[];
  };
  readonly summary: {
    readonly caseCount: number;
    readonly openCount: number;
    readonly resolvedCount: number;
    readonly pendingCustomerActionCount: number;
    readonly highUrgentCriticalCount: number;
    readonly communicationCount: number;
    readonly attachmentCount: number;
    readonly communicationActorCounts: Readonly<Record<AwsSupportActorKind, number>>;
    readonly responseCadence: {
      readonly awsResponseTransitions: number;
      readonly customerResponseTransitions: number;
      readonly averageAwsResponseMinutes: number | null;
      readonly averageCustomerResponseMinutes: number | null;
    };
    readonly openAgeBands: {
      readonly under7Days: number;
      readonly days7To30: number;
      readonly days31To90: number;
      readonly over90Days: number;
    };
    readonly intendedAccountCount: number;
    readonly completeAccountCount: number;
    readonly statusCounts: Readonly<Record<AwsSupportCaseStatus, number>>;
    readonly severityCounts: Readonly<Record<AwsSupportCaseSeverity, number>>;
    readonly serviceCounts: readonly { readonly code: string; readonly count: number }[];
    readonly categoryCounts: readonly { readonly code: string; readonly count: number }[];
  };
  readonly cases: readonly AwsSupportDashboardCase[];
  readonly casesTruncated: boolean;
  readonly disclosure: string;
}

function safeSummary(
  supportCase: AwsSupportDashboardCase,
): AwsSupportSafeCaseSummary {
  return {
    synopsis:
      `${supportCase.serviceCode}/${supportCase.categoryCode} is ${supportCase.status} at ${supportCase.severity} severity with ${supportCase.communicationCount} retained communication evidence record(s).`,
    evidenceHashes: [
      supportCase.metadataEvidenceHash,
      supportCase.subjectEvidenceHash,
      ...supportCase.communications.map((communication) =>
        communication.metadataEvidenceHash
      ),
    ].slice(0, 101),
    disclosure:
      "Generated only from allowlisted status, severity, service, category and count metadata; no subject or communication text was processed.",
  };
}

export function buildAwsSupportCasesRadar(input: {
  readonly snapshots: readonly AwsSupportCasesSnapshot[];
  readonly boundary: AwsSupportCasesBoundary;
  readonly options?: AwsSupportCasesDashboardOptions;
  readonly nowMs?: number;
}): AwsSupportCasesRadarDashboard {
  if (
    !isRecord(input)
    || !isRecord(input.boundary)
    || !hasExactKeys(input.boundary, [
      "scope",
      "binding",
      "intendedAccounts",
    ])
    || !validScope(input.boundary.scope)
    || input.boundary.binding !== "SERVER_RESOLVED_CONNECTIONS"
    || !Array.isArray(input.snapshots)
    || input.snapshots.length < 1
    || input.snapshots.length
      > AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumHistorySnapshots
  ) reject("INVALID_INPUT");
  validateIntendedAccounts(input.boundary.intendedAccounts);
  serializedBytes(
    input.snapshots,
    AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumDashboardInputBytes,
  );
  const byCapture = new Map<string, AwsSupportCasesSnapshot>();
  for (const rawSnapshot of input.snapshots as readonly unknown[]) {
    validatePersistedSnapshot(rawSnapshot, input.boundary);
    const snapshot = rawSnapshot as unknown as AwsSupportCasesSnapshot;
    addDeterministic(byCapture, snapshot.captureId, snapshot);
  }
  const ordered = [...byCapture.values()].sort((left, right) =>
    left.observedAt.localeCompare(right.observedAt)
    || left.captureId.localeCompare(right.captureId)
  );
  const latest = ordered.at(-1) as AwsSupportCasesSnapshot;
  const options: unknown = input.options ?? {};
  if (
    !isRecord(options)
    || (
      options.accountId !== undefined
      && (
        typeof options.accountId !== "string"
        || !ACCOUNT_ID.test(options.accountId)
        || !input.boundary.intendedAccounts.some((account) =>
          account.accountId === options.accountId
        )
      )
    )
    || (
      options.status !== undefined
      && (
        typeof options.status !== "string"
        || !CASE_STATUSES.has(options.status as AwsSupportCaseStatus)
      )
    )
    || (
      options.severity !== undefined
      && (
        typeof options.severity !== "string"
        || !SEVERITIES.has(options.severity as AwsSupportCaseSeverity)
      )
    )
    || (
      options.serviceCode !== undefined
      && (typeof options.serviceCode !== "string" || !SAFE_CODE.test(options.serviceCode))
    )
    || (
      options.categoryCode !== undefined
      && (typeof options.categoryCode !== "string" || !SAFE_CODE.test(options.categoryCode))
    )
    || (
      options.includeSafeSummaries !== undefined
      && typeof options.includeSafeSummaries !== "boolean"
    )
    || (
      options.caseLimit !== undefined
      && !safeInteger(
        options.caseLimit,
        1,
        AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumDashboardCases,
      )
    )
  ) reject("INVALID_INPUT");
  const parsedOptions = options as unknown as AwsSupportCasesDashboardOptions;
  const nowMs = input.nowMs ?? Date.now();
  if (!Number.isFinite(nowMs)) reject("INVALID_INPUT");
  const latestMs = Date.parse(latest.observedAt);
  if (!Number.isFinite(latestMs) || latestMs > nowMs + MAX_CLOCK_SKEW_MS) {
    reject("TIME_LIMIT_EXCEEDED");
  }

  const replay = new Map<string, AwsSupportDashboardCase>();
  const observedCaptureIds = new Map<string, Set<string>>();
  for (const snapshot of ordered) {
    for (const supportCase of snapshot.cases) {
      const key = `${supportCase.accountId}\0${supportCase.caseId}`;
      const seen = observedCaptureIds.get(key) ?? new Set<string>();
      seen.add(snapshot.captureId);
      observedCaptureIds.set(key, seen);
      const previous = replay.get(key);
      const communicationMap = new Map<
        string,
        AwsSupportNormalizedCommunicationEvidence
      >();
      for (const communication of previous?.communications ?? []) {
        addDeterministic(
          communicationMap,
          communication.metadataEvidenceHash,
          communication,
        );
      }
      for (const communication of supportCase.communications) {
        addDeterministic(
          communicationMap,
          communication.metadataEvidenceHash,
          communication,
        );
      }
      const communications = [...communicationMap.values()].sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt)
          || left.metadataEvidenceHash.localeCompare(
            right.metadataEvidenceHash,
          ),
      );
      replay.set(key, {
        ...supportCase,
        updatedAt: previous === undefined
          || supportCase.updatedAt > previous.updatedAt
          ? supportCase.updatedAt
          : previous.updatedAt,
        communications,
        communicationCount: communications.length,
        attachmentCount: communications.reduce(
          (total, communication) => total + communication.attachmentCount,
          0,
        ),
        communicationsComplete:
          (previous?.communicationsComplete ?? true)
          && supportCase.communicationsComplete,
        firstObservedAt: previous?.firstObservedAt ?? snapshot.observedAt,
        resolvedObservedAt: previous?.resolvedObservedAt
          ?? (supportCase.status === "resolved" ? snapshot.observedAt : null),
        observationCount: seen.size,
        safeSummary: null,
      });
    }
  }
  const allFiltered = [...replay.values()].filter((supportCase) =>
    (parsedOptions.accountId === undefined
      || supportCase.accountId === parsedOptions.accountId)
    && (parsedOptions.status === undefined
      || supportCase.status === parsedOptions.status)
    && (parsedOptions.severity === undefined
      || supportCase.severity === parsedOptions.severity)
    && (parsedOptions.serviceCode === undefined
      || supportCase.serviceCode === parsedOptions.serviceCode)
    && (parsedOptions.categoryCode === undefined
      || supportCase.categoryCode === parsedOptions.categoryCode)
  ).sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt)
    || left.accountId.localeCompare(right.accountId)
    || left.caseId.localeCompare(right.caseId)
  );
  const limit = parsedOptions.caseLimit ?? 100;
  const cases = allFiltered.slice(0, limit).map((supportCase) => ({
    ...supportCase,
    safeSummary: parsedOptions.includeSafeSummaries === true
      ? safeSummary(supportCase)
      : null,
  }));
  const statusCounts: Record<AwsSupportCaseStatus, number> = {
    "all-open": 0,
    "customer-action-completed": 0,
    opened: 0,
    "pending-customer-action": 0,
    reopened: 0,
    resolved: 0,
    unassigned: 0,
    "work-in-progress": 0,
  };
  const severityCounts: Record<AwsSupportCaseSeverity, number> = {
    low: 0,
    normal: 0,
    high: 0,
    urgent: 0,
    critical: 0,
  };
  const serviceCounts = new Map<string, number>();
  const categoryCounts = new Map<string, number>();
  const communicationActorCounts: Record<AwsSupportActorKind, number> = {
    AWS: 0,
    CUSTOMER: 0,
    UNKNOWN: 0,
  };
  let awsResponseTransitions = 0;
  let customerResponseTransitions = 0;
  let awsResponseMs = BigInt(0);
  let customerResponseMs = BigInt(0);
  const openAgeBands = {
    under7Days: 0,
    days7To30: 0,
    days31To90: 0,
    over90Days: 0,
  };
  for (const supportCase of allFiltered) {
    statusCounts[supportCase.status] += 1;
    severityCounts[supportCase.severity] += 1;
    serviceCounts.set(
      supportCase.serviceCode,
      (serviceCounts.get(supportCase.serviceCode) ?? 0) + 1,
    );
    categoryCounts.set(
      supportCase.categoryCode,
      (categoryCounts.get(supportCase.categoryCode) ?? 0) + 1,
    );
    let previousActor = supportCase.submittedByKind;
    let previousAt = supportCase.createdAt;
    for (const communication of supportCase.communications) {
      communicationActorCounts[communication.submittedByKind] += 1;
      if (previousActor === communication.submittedByKind) {
        previousAt = communication.createdAt;
        continue;
      }
      const elapsedMs = BigInt(
        Date.parse(communication.createdAt) - Date.parse(previousAt),
      );
      if (communication.submittedByKind === "AWS"
        && previousActor === "CUSTOMER") {
        awsResponseTransitions += 1;
        awsResponseMs += elapsedMs;
      } else if (communication.submittedByKind === "CUSTOMER"
        && previousActor === "AWS") {
        customerResponseTransitions += 1;
        customerResponseMs += elapsedMs;
      }
      previousActor = communication.submittedByKind;
      previousAt = communication.createdAt;
    }
    if (supportCase.status !== "resolved") {
      const ageDays = Math.floor(
        Math.max(0, nowMs - Date.parse(supportCase.createdAt)) / DAY_MS,
      );
      if (ageDays < 7) openAgeBands.under7Days += 1;
      else if (ageDays <= 30) openAgeBands.days7To30 += 1;
      else if (ageDays <= 90) openAgeBands.days31To90 += 1;
      else openAgeBands.over90Days += 1;
    }
  }
  const watermarkCoverage = ordered[0]?.window.mode === "INITIAL"
    && ordered.every((snapshot, index) =>
      index === 0
      || snapshot.window.priorWatermark === ordered[index - 1]?.window.nextWatermark
    )
    ? "continuous"
    : "partial";
  const ageHours = Math.max(0, (nowMs - latestMs) / HOUR_MS);
  return {
    scope: { ...latest.scope },
    generatedAt: new Date(nowMs).toISOString(),
    source: {
      sourceId: "aws_support_cases_organization",
      latestCaptureId: latest.captureId,
      latestObservedAt: latest.observedAt,
      configurationState: latest.configurationState,
      collectionState: latest.collectionState,
      freshness: ageHours
          <= AWS_SUPPORT_CASES_COLLECTION_BOUNDS.freshnessSlaHours
        ? "fresh"
        : "stale",
      historyCoverage: "observed_snapshots_only",
      watermarkCoverage,
      organizationCoverageClaimed: false,
      accountCoverage: latest.accountCoverage,
      limitations: latest.evidence.limitations,
    },
    summary: {
      caseCount: allFiltered.length,
      openCount: allFiltered.filter((supportCase) =>
        supportCase.status !== "resolved"
      ).length,
      resolvedCount: statusCounts.resolved,
      pendingCustomerActionCount: statusCounts["pending-customer-action"],
      highUrgentCriticalCount: severityCounts.high
        + severityCounts.urgent
        + severityCounts.critical,
      communicationCount: allFiltered.reduce(
        (total, supportCase) => total + supportCase.communicationCount,
        0,
      ),
      attachmentCount: allFiltered.reduce(
        (total, supportCase) => total + supportCase.attachmentCount,
        0,
      ),
      communicationActorCounts,
      responseCadence: {
        awsResponseTransitions,
        customerResponseTransitions,
        averageAwsResponseMinutes: awsResponseTransitions === 0
          ? null
          : Number(awsResponseMs / BigInt(awsResponseTransitions) / BigInt(60_000)),
        averageCustomerResponseMinutes: customerResponseTransitions === 0
          ? null
          : Number(customerResponseMs / BigInt(customerResponseTransitions) / BigInt(60_000)),
      },
      openAgeBands,
      intendedAccountCount: latest.intendedAccounts.length,
      completeAccountCount: latest.accountCoverage.filter((account) =>
        account.status === "complete"
      ).length,
      statusCounts,
      severityCounts,
      serviceCounts: [...serviceCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((left, right) =>
          right.count - left.count || left.code.localeCompare(right.code)
        ),
      categoryCounts: [...categoryCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((left, right) =>
          right.count - left.count || left.code.localeCompare(right.code)
        ),
    },
    cases,
    casesTruncated: cases.length < allFiltered.length,
    disclosure:
      "Support Cases Radar is a retention-limited, account-by-account evidence view. It excludes correspondence content and personal identifiers and never claims an AWS organization-wide case source.",
  };
}

export interface AwsSupportCasesBrokerRequest {
  readonly tenantId: string;
  readonly customerId: string;
  readonly parentConnectionId: string;
  readonly partition: AwsSupportPartition;
  readonly endpointRegion: AwsSupportEndpointRegion;
  readonly jobId: string;
  readonly window: AwsSupportCollectionWindow;
  readonly intendedAccounts: readonly AwsSupportIntendedAccount[];
  readonly readOperations: typeof AWS_SUPPORT_CASES_READ_OPERATIONS;
  readonly entitlementProbe: "DESCRIBE_CASES_AUTHORIZATION_OUTCOME";
  readonly credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS";
  readonly sanitizeBeforeBroker: true;
  readonly includeRawSubjects: false;
  readonly includeRawCommunications: false;
  readonly includeContactIdentifiers: false;
  readonly includeAttachmentMetadata: false;
  readonly includeProviderMessages: false;
  readonly includeRawPaginationTokens: false;
  readonly limits: {
    readonly casePageSize: 100;
    readonly communicationPageSize: 100;
    readonly maximumRequestsPerSecondPerAccount: 4;
    readonly maximumConcurrency: 2;
    readonly maximumDurationMs: number;
    readonly maximumBytes: number;
    readonly maximumCasePages: number;
    readonly maximumCommunicationPages: number;
    readonly maximumCases: number;
    readonly maximumCommunications: number;
  };
}

export interface AwsSupportCasesTransport {
  collect(request: AwsSupportCasesBrokerRequest): Promise<unknown>;
}

export type AwsSupportCasesQueryErrorCode =
  | "INVALID_QUERY"
  | "COLLECTION_FAILED"
  | "INVALID_EVIDENCE";

export class AwsSupportCasesQueryError extends Error {
  public readonly code: AwsSupportCasesQueryErrorCode;

  public constructor(code: AwsSupportCasesQueryErrorCode) {
    super("AWS Support cases query failed");
    this.name = "AwsSupportCasesQueryError";
    this.code = code;
  }
}

export function createAwsSupportCasesQueryService(
  boundary: AwsSupportCasesBoundary,
  transport: AwsSupportCasesTransport,
  dependencies: {
    readonly now?: () => Date;
    readonly createJobId?: () => string;
  } = {},
): {
  query(window: AwsSupportCollectionWindow): Promise<AwsSupportCasesSnapshot>;
} {
  if (
    !isRecord(boundary)
    || !validScope(boundary.scope)
    || boundary.binding !== "SERVER_RESOLVED_CONNECTIONS"
    || !isRecord(transport)
  ) reject("INVALID_INPUT");
  validateIntendedAccounts(boundary.intendedAccounts);
  const pinnedBoundary: AwsSupportCasesBoundary = {
    scope: { ...boundary.scope },
    binding: "SERVER_RESOLVED_CONNECTIONS",
    intendedAccounts: boundary.intendedAccounts.map((account) => ({ ...account })),
  };
  const now = dependencies.now ?? (() => new Date());
  const createJobId = dependencies.createJobId
    ?? (() => `supportjob_${crypto.randomUUID().replaceAll("-", "")}`);
  return {
    async query(
      window: AwsSupportCollectionWindow,
    ): Promise<AwsSupportCasesSnapshot> {
      const observedNow = now();
      if (
        !(observedNow instanceof Date)
        || !Number.isFinite(observedNow.getTime())
      ) throw new AwsSupportCasesQueryError("COLLECTION_FAILED");
      try {
        validateWindow(window, observedNow.getTime());
      } catch {
        throw new AwsSupportCasesQueryError("INVALID_QUERY");
      }
      const jobId = createJobId();
      if (!JOB_ID.test(jobId)) {
        throw new AwsSupportCasesQueryError("COLLECTION_FAILED");
      }
      const request: AwsSupportCasesBrokerRequest = {
        tenantId: pinnedBoundary.scope.orgId,
        customerId: pinnedBoundary.scope.customerId,
        parentConnectionId: pinnedBoundary.scope.connectionId,
        partition: pinnedBoundary.scope.partition,
        endpointRegion: pinnedBoundary.scope.endpointRegion,
        jobId,
        window: { ...window },
        intendedAccounts: pinnedBoundary.intendedAccounts.map((account) => ({
          ...account,
        })),
        readOperations: AWS_SUPPORT_CASES_READ_OPERATIONS,
        entitlementProbe: "DESCRIBE_CASES_AUTHORIZATION_OUTCOME",
        credentials: "SERVER_OWNED_TRUST_ROLE_SESSIONS",
        sanitizeBeforeBroker: true,
        includeRawSubjects: false,
        includeRawCommunications: false,
        includeContactIdentifiers: false,
        includeAttachmentMetadata: false,
        includeProviderMessages: false,
        includeRawPaginationTokens: false,
        limits: {
          casePageSize: 100,
          communicationPageSize: 100,
          maximumRequestsPerSecondPerAccount: 4,
          maximumConcurrency: 2,
          maximumDurationMs:
            AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumDurationMs,
          maximumBytes:
            AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCaptureBytes,
          maximumCasePages:
            AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCasePages,
          maximumCommunicationPages:
            AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCommunicationPages,
          maximumCases: AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCases,
          maximumCommunications:
            AWS_SUPPORT_CASES_COLLECTION_BOUNDS.maximumCommunications,
        },
      };
      let raw: unknown;
      try {
        raw = await transport.collect(request);
      } catch {
        throw new AwsSupportCasesQueryError("COLLECTION_FAILED");
      }
      try {
        return normalizeAwsSupportCasesCapture(
          raw,
          pinnedBoundary,
          observedNow.getTime(),
        );
      } catch {
        throw new AwsSupportCasesQueryError("INVALID_EVIDENCE");
      }
    },
  };
}
