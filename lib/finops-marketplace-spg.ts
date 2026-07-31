/**
 * Evidence-honest AWS Marketplace Single Pane of Glass normalization.
 *
 * The credential-owning collector is deliberately outside this module. It
 * must emit this minimized capture through the authenticated broker. This
 * module performs no AWS/network/database I/O, accepts no credentials, and
 * never derives organization-wide coverage from a single buyer account.
 */
import { toMicros } from "./finops-cur.ts";
import type {
  FinopsSourceEvidence,
  FinopsSourceScope,
} from "./finops-source-health.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const AWS_ORGANIZATION_ID = /^o-[a-z0-9]{10,32}$/u;
const CAPTURE_ID = /^marketplace_[a-f0-9]{64}$/u;
const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:@+\/-]{0,511}$/u;
const PROVIDER_ID = /^[A-Za-z0-9][A-Za-z0-9_\/-]{0,255}$/u;
const PRODUCT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,254}$/u;
const SAFE_TEXT = /^[^\0\r\n<>]{1,1024}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const INTEGER_MICROS = /^-?(?:0|[1-9]\d{0,30})$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const ARN = /^arn:(aws|aws-us-gov|aws-cn):[A-Za-z0-9-]+:[A-Za-z0-9-]*:[0-9]*:[A-Za-z0-9][A-Za-z0-9:_/+=,.@-]{0,1023}$/u;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

const AGREEMENT_STATUSES = new Set([
  "ACTIVE", "ARCHIVED", "CANCELLED", "EXPIRED", "RENEWED", "REPLACED", "TERMINATED",
]);
const TERM_TYPES = new Set([
  "LEGAL", "SUPPORT", "RENEWAL", "VALIDITY", "USAGE_BASED_PRICING",
  "CONFIGURABLE_UPFRONT_PRICING", "FIXED_UPFRONT_PRICING",
  "RECURRING_PAYMENT", "PAYMENT_SCHEDULE", "FREE_TRIAL", "BYOL",
  "VARIABLE_PAYMENT",
]);
const AGREEMENT_ENTITLEMENT_STATUSES = new Set([
  "PROVISIONED", "SCHEDULED", "PENDING", "FAILED", "DEPROVISIONED",
]);
const AGREEMENT_ENTITLEMENT_REASON_CODES = new Set([
  "PROVISIONING_IN_PROGRESS", "FUTURE_START_DATE", "INVALID_PAYMENT_INSTRUMENT",
  "INCOMPATIBLE_CURRENCY", "ACCOUNT_SUSPENDED", "UNSUPPORTED_OPERATION",
  "AGREEMENT_INACTIVE", "AGREEMENT_ACTIVE", "PRODUCT_RESTRICTED",
]);
const LICENSE_STATUSES = new Set([
  "AVAILABLE", "PENDING_AVAILABLE", "DEACTIVATED", "SUSPENDED", "EXPIRED",
  "PENDING_DELETE", "DELETED",
]);
const LICENSE_ENTITLEMENT_UNITS = new Set([
  "Count", "None", "Seconds", "Microseconds", "Milliseconds", "Bytes",
  "Kilobytes", "Megabytes", "Gigabytes", "Terabytes", "Bits", "Kilobits",
  "Megabits", "Gigabits", "Terabits", "Percent", "Bytes/Second",
  "Kilobytes/Second", "Megabytes/Second", "Gigabytes/Second",
]);
const GRANT_STATUSES = new Set([
  "PENDING_WORKFLOW", "PENDING_ACCEPT", "REJECTED", "ACTIVE", "FAILED_WORKFLOW",
  "DELETED", "PENDING_DELETE", "DISABLED", "WORKFLOW_COMPLETED",
]);

export const AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS = Object.freeze({
  agreementApiPageSize: 50,
  licenseManagerApiPageSize: 100,
  maximumPagesPerSequence: 5_000,
  maximumOrganizationAccounts: 10_000,
  maximumAgreements: 50_000,
  maximumTermsPerAgreement: 100,
  maximumEntitlementsPerAgreement: 100,
  maximumChargesPerAgreement: 10_000,
  maximumLicenses: 50_000,
  maximumLicenseEntitlements: 100,
  maximumGrants: 250_000,
  maximumSpendRows: 500_000,
  maximumCaptureBytes: 96 * 1_024 * 1_024,
  maximumDashboardBytes: 16 * 1_024 * 1_024,
  maximumTextCharacters: 1_024,
  agreementFreshnessSlaHours: 48,
  licenseFreshnessSlaHours: 48,
  cur2FreshnessSlaHours: 48,
} as const);

/** Agreement Service is currently documented at its us-east-1 endpoint. */
export const AWS_MARKETPLACE_AGREEMENT_REGION = "us-east-1" as const;
export const AWS_MARKETPLACE_DISCOVERY_REGION = "us-east-1" as const;

export const AWS_MARKETPLACE_BUYER_API_OPERATIONS = Object.freeze([
  "SearchAgreements",
  "DescribeAgreement",
  "GetAgreementTerms",
  "GetAgreementEntitlements",
  "ListAgreementCharges",
  "GetProduct",
] as const);

export const AWS_MARKETPLACE_BUYER_IAM_ACTIONS = Object.freeze([
  "aws-marketplace:SearchAgreements",
  "aws-marketplace:DescribeAgreement",
  "aws-marketplace:GetAgreementTerms",
  "aws-marketplace:GetAgreementEntitlements",
  "aws-marketplace:ListAgreementCharges",
  "aws-marketplace:GetProduct",
] as const);

export const AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS = Object.freeze([
  "GetServiceSettings",
  "ListReceivedLicenses",
  "ListReceivedGrants",
  "ListReceivedLicensesForOrganization",
  "ListReceivedGrantsForOrganization",
] as const);

export const AWS_MARKETPLACE_LICENSE_MANAGER_IAM_ACTIONS = Object.freeze([
  "license-manager:GetServiceSettings",
  "license-manager:ListReceivedLicenses",
  "license-manager:ListReceivedGrants",
  "license-manager:ListReceivedLicensesForOrganization",
  "license-manager:ListReceivedGrantsForOrganization",
] as const);

/** Supplied by Sutra's canonical account-coverage source, not re-invented here. */
export const AWS_MARKETPLACE_ACCOUNT_COVERAGE_IAM_ACTIONS = Object.freeze([
  "organizations:DescribeOrganization",
  "organizations:ListAccounts",
] as const);

/** Seller/provider APIs are intentionally forbidden in the buyer collector. */
export const AWS_MARKETPLACE_SELLER_ONLY_EXCLUDED_ACTIONS = Object.freeze([
  "aws-marketplace:GetEntitlements",
  "aws-marketplace:ListAgreementInvoiceLineItems",
] as const);

export type AwsMarketplaceSpgBoundaryErrorCode =
  | "INVALID_INPUT"
  | "SCOPE_MISMATCH"
  | "UNSUPPORTED_PARTITION"
  | "ACCOUNT_COVERAGE_MISMATCH"
  | "COLLECTION_POLICY_VIOLATION"
  | "LIMIT_EXCEEDED"
  | "CONFLICTING_DUPLICATE"
  | "SENSITIVE_DATA_REJECTED";

export class AwsMarketplaceSpgError extends Error {
  readonly code: AwsMarketplaceSpgBoundaryErrorCode;

  constructor(code: AwsMarketplaceSpgBoundaryErrorCode) {
    super("AWS Marketplace SPG evidence is invalid.");
    this.name = "AwsMarketplaceSpgError";
    this.code = code;
  }
}

export interface AwsMarketplaceSpgScope extends FinopsSourceScope {
  /** Registered AWS payer/management account for this connection. */
  readonly accountId: string;
  readonly partition: "aws" | "aws-us-gov" | "aws-cn";
  readonly awsOrganizationId: string | null;
}

export type AwsMarketplaceOperation =
  | typeof AWS_MARKETPLACE_BUYER_API_OPERATIONS[number]
  | typeof AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS[number];
export type AwsMarketplaceOperationState =
  | "SUCCEEDED"
  | "PARTIAL"
  | "ACCESS_DENIED"
  | "CONFIGURATION_REQUIRED"
  | "UNAVAILABLE";
export type AwsMarketplaceFailureCode =
  | "ACCESS_DENIED"
  | "EXPIRED_TOKEN"
  | "THROTTLED"
  | "TIMEOUT"
  | "BOUND_REACHED"
  | "SERVICE_NOT_ENABLED"
  | "UNSUPPORTED_PARTITION"
  | "PROVIDER_UNAVAILABLE"
  | "UNKNOWN";

export interface AwsMarketplaceOperationCoverage {
  readonly operation: AwsMarketplaceOperation;
  readonly state: AwsMarketplaceOperationState;
  readonly recordCount: number;
  readonly pageCount: number;
  readonly failureCode: AwsMarketplaceFailureCode | null;
}

export interface AwsMarketplaceAccountCoverage {
  readonly basis:
    | "AWS_ORGANIZATIONS_ACTIVE_ACCOUNTS"
    | "OPERATOR_APPROVED_ACCOUNT_SET"
    | "SINGLE_CONNECTED_ACCOUNT";
  readonly evidenceId: string;
  readonly observedAt: string;
  readonly expectedAccountIds: readonly string[];
  /** Accounts on which the acceptor-side Agreement API actually completed. */
  readonly capturedAgreementAccountIds: readonly string[];
}

export type AwsMarketplaceAgreementStatus =
  | "ACTIVE"
  | "ARCHIVED"
  | "CANCELLED"
  | "EXPIRED"
  | "RENEWED"
  | "REPLACED"
  | "TERMINATED";

export interface AwsMarketplaceMoneyCapture {
  readonly amount: string;
  readonly currencyCode: string;
}

export interface AwsMarketplaceTermCapture {
  readonly termId: string;
  readonly type:
    | "LEGAL"
    | "SUPPORT"
    | "RENEWAL"
    | "VALIDITY"
    | "USAGE_BASED_PRICING"
    | "CONFIGURABLE_UPFRONT_PRICING"
    | "FIXED_UPFRONT_PRICING"
    | "RECURRING_PAYMENT"
    | "PAYMENT_SCHEDULE"
    | "FREE_TRIAL"
    | "BYOL"
    | "VARIABLE_PAYMENT";
  /** Document types only. Document URLs and document contents are forbidden. */
  readonly legalDocumentTypes: readonly string[];
  readonly autoRenew: boolean | null;
  readonly validity: { readonly startAt: string; readonly endAt: string } | null;
  readonly pricingCurrency: string | null;
  readonly committedAmount: string | null;
  readonly dimensionCount: number | null;
  readonly paymentSchedule: readonly {
    readonly chargeAt: string;
    readonly amount: string;
  }[];
}

export interface AwsMarketplaceAgreementEntitlementCapture {
  readonly type: string;
  readonly status:
    | "PROVISIONED"
    | "SCHEDULED"
    | "PENDING"
    | "FAILED"
    | "DEPROVISIONED";
  readonly statusReasonCode:
    | "PROVISIONING_IN_PROGRESS"
    | "FUTURE_START_DATE"
    | "INVALID_PAYMENT_INSTRUMENT"
    | "INCOMPATIBLE_CURRENCY"
    | "ACCOUNT_SUSPENDED"
    | "UNSUPPORTED_OPERATION"
    | "AGREEMENT_INACTIVE"
    | "AGREEMENT_ACTIVE"
    | "PRODUCT_RESTRICTED"
    | null;
  readonly resourceType: string | null;
  readonly resourceId: string | null;
  readonly licenseArn: string | null;
  /** The 30-minute registrationToken returned by AWS must never be captured. */
}

export interface AwsMarketplaceAgreementChargeCapture {
  readonly chargeId: string;
  readonly revision: number;
  readonly chargeAt: string | null;
  readonly money: AwsMarketplaceMoneyCapture;
  /** purchaseOrderReference is deliberately not represented. */
}

export interface AwsMarketplaceProductCapture {
  readonly productId: string;
  readonly productName: string;
  readonly sellerDisplayName: string;
  readonly sellerProfileId: string | null;
  readonly deployedOnAws: "DEPLOYED" | "NOT_DEPLOYED" | "NOT_APPLICABLE";
  readonly fulfillmentTypes: readonly string[];
  /** Descriptions, media, support contacts, phone numbers and emails are omitted. */
}

export interface AwsMarketplaceAgreementCapture {
  readonly sourceAccountId: string;
  readonly agreementId: string;
  readonly agreementType: "PurchaseAgreement";
  readonly acceptorAccountId: string;
  readonly status: AwsMarketplaceAgreementStatus;
  readonly acceptanceAt: string | null;
  readonly startAt: string | null;
  readonly endAt: string | null;
  readonly offerId: string | null;
  readonly productId: string | null;
  readonly estimatedCharges: AwsMarketplaceMoneyCapture | null;
  readonly product: AwsMarketplaceProductCapture | null;
  readonly terms: readonly AwsMarketplaceTermCapture[];
  readonly entitlements: readonly AwsMarketplaceAgreementEntitlementCapture[];
  readonly charges: readonly AwsMarketplaceAgreementChargeCapture[];
}

export type AwsMarketplaceLicenseStatus =
  | "AVAILABLE"
  | "PENDING_AVAILABLE"
  | "DEACTIVATED"
  | "SUSPENDED"
  | "EXPIRED"
  | "PENDING_DELETE"
  | "DELETED";

export interface AwsMarketplaceLicenseEntitlementCapture {
  readonly name: string;
  readonly unit:
    | "Count"
    | "None"
    | "Seconds"
    | "Microseconds"
    | "Milliseconds"
    | "Bytes"
    | "Kilobytes"
    | "Megabytes"
    | "Gigabytes"
    | "Terabytes"
    | "Bits"
    | "Kilobits"
    | "Megabits"
    | "Gigabits"
    | "Terabits"
    | "Percent"
    | "Bytes/Second"
    | "Kilobytes/Second"
    | "Megabytes/Second"
    | "Gigabytes/Second";
  readonly value: string | null;
  readonly maxCount: string | null;
  readonly overageAllowed: boolean | null;
}

export interface AwsMarketplaceLicenseCapture {
  readonly licenseArn: string;
  /** Exact account parsed by the collector from the beneficiary ARN/string. */
  readonly beneficiaryAccountId: string;
  readonly homeRegion: string;
  readonly issuerName: "AWS/Marketplace";
  readonly productSku: string;
  readonly productName: string;
  readonly licenseName: string;
  readonly status: AwsMarketplaceLicenseStatus;
  readonly receivedStatus: string | null;
  readonly validity: { readonly startAt: string; readonly endAt: string } | null;
  readonly entitlements: readonly AwsMarketplaceLicenseEntitlementCapture[];
  /** Issuer keys/fingerprints, free-form metadata and status reasons are omitted. */
}

export type AwsMarketplaceGrantStatus =
  | "PENDING_WORKFLOW"
  | "PENDING_ACCEPT"
  | "REJECTED"
  | "ACTIVE"
  | "FAILED_WORKFLOW"
  | "DELETED"
  | "PENDING_DELETE"
  | "DISABLED"
  | "WORKFLOW_COMPLETED";

export interface AwsMarketplaceGrantCapture {
  readonly grantArn: string;
  readonly licenseArn: string;
  readonly granteeAccountId: string;
  readonly homeRegion: string;
  readonly status: AwsMarketplaceGrantStatus;
  readonly version: string;
  readonly operations: readonly string[];
  readonly activationOverrideBehavior:
    | "DISTRIBUTED_GRANTS_ONLY"
    | "ALL_GRANTS_PERMITTED_BY_ISSUER"
    | null;
  /** Grant names, principal ARNs, parent ARNs and status reasons are omitted. */
}

export interface AwsMarketplaceCur2SpendRow {
  readonly linkedAccountId: string;
  readonly billingPeriod: string;
  readonly invoiceId: string | null;
  readonly productCode: string | null;
  readonly productName: string;
  readonly sellerName: string;
  readonly chargeCategory:
    | "usage"
    | "subscription"
    | "upfront"
    | "recurring"
    | "tax"
    | "credit"
    | "refund"
    | "other";
  readonly currency: string;
  readonly billedAmountMicros: string;
  readonly amortizedAmountMicros: string | null;
}

export interface AwsMarketplaceCur2Evidence {
  readonly scope: AwsMarketplaceSpgScope;
  readonly generationId: string;
  readonly sourceEvidenceId: string;
  readonly dataThroughAt: string;
  readonly reconciliationState: "reconciled" | "partial" | "failed";
  readonly predicate:
    | "CUR2_BILLING_ENTITY_AWS_MARKETPLACE"
    | "CUR2_PRODUCT_FAMILY_AWS_MARKETPLACE";
  readonly rows: readonly AwsMarketplaceCur2SpendRow[];
}

export interface AwsMarketplaceSpgCapture {
  readonly schemaVersion: "sutra.aws-marketplace-spg.v1";
  readonly scope: AwsMarketplaceSpgScope;
  readonly captureId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly agreementRegion: "us-east-1";
  readonly discoveryRegion: "us-east-1";
  readonly licenseManagerRegion: string;
  readonly agreementParty: "Acceptor";
  readonly agreementAccountCoverage: AwsMarketplaceAccountCoverage;
  readonly licenseCollectionMode: "ACCOUNT" | "ORGANIZATION";
  readonly licenseManagerSettings: {
    readonly organizationIntegrationEnabled: boolean | null;
    readonly crossAccountDiscoveryEnabled: boolean | null;
  };
  readonly operationCoverage: readonly AwsMarketplaceOperationCoverage[];
  readonly agreements: readonly AwsMarketplaceAgreementCapture[];
  readonly licenses: readonly AwsMarketplaceLicenseCapture[];
  readonly grants: readonly AwsMarketplaceGrantCapture[];
  readonly cur2: AwsMarketplaceCur2Evidence | null;
}

export interface NormalizedAwsMarketplaceTerm
  extends Omit<AwsMarketplaceTermCapture, "committedAmount" | "paymentSchedule"> {
  readonly committedAmountMicros: string | null;
  readonly paymentSchedule: readonly {
    readonly chargeAt: string;
    readonly amountMicros: string;
  }[];
}

export interface NormalizedAwsMarketplaceAgreement
  extends Omit<AwsMarketplaceAgreementCapture, "estimatedCharges" | "terms"> {
  readonly estimatedCharges: {
    readonly amountMicros: string;
    readonly currency: string;
    readonly meaning: "KNOWN_LIFECYCLE_COMMITMENT_NOT_USAGE_ACTUAL";
  } | null;
  readonly terms: readonly NormalizedAwsMarketplaceTerm[];
  readonly expirationState:
    | "NO_END_DATE"
    | "EXPIRED"
    | "EXPIRING_30_DAYS"
    | "EXPIRING_60_DAYS"
    | "EXPIRING_90_DAYS"
    | "ACTIVE_BEYOND_90_DAYS";
}

export interface AwsMarketplaceSpendSummary {
  readonly currency: string;
  readonly billedAmountMicros: string;
  readonly amortizedAmountMicros: string | null;
  readonly rowCount: number;
}

export interface AwsMarketplaceSpgSnapshot {
  readonly schemaVersion: "sutra.aws-marketplace-spg.snapshot.v1";
  readonly scope: AwsMarketplaceSpgScope;
  readonly captureId: string;
  readonly capturedAt: string;
  readonly state:
    | "READY"
    | "EMPTY"
    | "PARTIAL"
    | "CONFIGURATION_REQUIRED"
    | "STALE";
  readonly organizationCoverage:
    | "COMPLETE"
    | "PARTIAL"
    | "SINGLE_ACCOUNT_ONLY";
  readonly channelStates: {
    readonly agreements: "READY" | "EMPTY" | "PARTIAL";
    readonly licenses:
      | "READY"
      | "EMPTY"
      | "PARTIAL"
      | "CONFIGURATION_REQUIRED";
    readonly spend:
      | "READY"
      | "EMPTY"
      | "PARTIAL"
      | "CONFIGURATION_REQUIRED";
  };
  readonly freshness: {
    readonly status: "FRESH" | "STALE";
    readonly dataThroughAt: string;
    readonly ageHours: number;
  };
  readonly agreements: readonly NormalizedAwsMarketplaceAgreement[];
  readonly licenses: readonly AwsMarketplaceLicenseCapture[];
  readonly grants: readonly AwsMarketplaceGrantCapture[];
  readonly spend: {
    readonly sourceEvidenceId: string | null;
    readonly generationId: string | null;
    readonly predicate: AwsMarketplaceCur2Evidence["predicate"] | null;
    readonly summaries: readonly AwsMarketplaceSpendSummary[];
  };
  readonly counts: {
    readonly expectedAgreementAccounts: number;
    readonly capturedAgreementAccounts: number;
    readonly agreements: number;
    readonly expiringWithin90Days: number;
    readonly licenses: number;
    readonly grants: number;
    readonly activeGrants: number;
    readonly cur2Rows: number;
  };
  readonly limitations: readonly string[];
}

function fail(code: AwsMarketplaceSpgBoundaryErrorCode): never {
  throw new AwsMarketplaceSpgError(code);
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return fail("INVALID_INPUT");
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: unknown, allowed: readonly string[]): void {
  const record = object(value);
  if (Object.keys(record).some((key) => !allowed.includes(key))) {
    fail("SENSITIVE_DATA_REJECTED");
  }
}

function text(value: unknown, expression = SAFE_TEXT): string {
  if (typeof value !== "string" || !expression.test(value)) fail("INVALID_INPUT");
  return value;
}

function integer(value: unknown, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) {
    fail("INVALID_INPUT");
  }
  return Number(value);
}

function timestamp(value: unknown): string {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    fail("INVALID_INPUT");
  }
  return new Date(value).toISOString();
}

function optionalTimestamp(value: unknown): string | null {
  return value === null ? null : timestamp(value);
}

function scope(value: unknown): AwsMarketplaceSpgScope {
  exactKeys(value, [
    "orgId",
    "customerId",
    "connectionId",
    "accountId",
    "partition",
    "awsOrganizationId",
  ]);
  const record = object(value);
  const parsed = {
    orgId: text(record.orgId, IDENTIFIER),
    customerId: text(record.customerId, IDENTIFIER),
    connectionId: text(record.connectionId, CONNECTION_ID),
    accountId: text(record.accountId, ACCOUNT_ID),
    partition: record.partition,
    awsOrganizationId: record.awsOrganizationId === null
      ? null
      : text(record.awsOrganizationId, AWS_ORGANIZATION_ID),
  };
  if (parsed.partition !== "aws" && parsed.partition !== "aws-us-gov" && parsed.partition !== "aws-cn") {
    fail("INVALID_INPUT");
  }
  return parsed as AwsMarketplaceSpgScope;
}

function sameScope(left: AwsMarketplaceSpgScope, right: AwsMarketplaceSpgScope): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId
    && left.accountId === right.accountId
    && left.partition === right.partition
    && left.awsOrganizationId === right.awsOrganizationId;
}

function assertArnPartition(value: string, partition: AwsMarketplaceSpgScope["partition"]): void {
  if (!ARN.test(value) || !value.startsWith(`arn:${partition}:`)) fail("INVALID_INPUT");
}

function money(value: unknown): { amountMicros: string; currency: string } {
  exactKeys(value, ["amount", "currencyCode"]);
  const record = object(value);
  const amount = text(record.amount, /^-?(?:0|[1-9]\d{0,23})(?:\.\d{1,6})?$/u);
  const amountMicros = toMicros(amount);
  if (amountMicros === null) fail("INVALID_INPUT");
  return { amountMicros, currency: text(record.currencyCode, CURRENCY) };
}

function uniqueStrings(values: unknown, maximum: number): string[] {
  if (!Array.isArray(values) || values.length > maximum) fail("LIMIT_EXCEEDED");
  const parsed = values.map((entry) => text(entry));
  if (new Set(parsed).size !== parsed.length) fail("CONFLICTING_DUPLICATE");
  return parsed;
}

function normalizeTerm(value: AwsMarketplaceTermCapture): NormalizedAwsMarketplaceTerm {
  exactKeys(value, [
    "termId",
    "type",
    "legalDocumentTypes",
    "autoRenew",
    "validity",
    "pricingCurrency",
    "committedAmount",
    "dimensionCount",
    "paymentSchedule",
  ]);
  text(value.termId, PROVIDER_ID);
  if (!TERM_TYPES.has(value.type)) fail("INVALID_INPUT");
  const legalDocumentTypes = uniqueStrings(value.legalDocumentTypes, 20);
  if (value.autoRenew !== null && typeof value.autoRenew !== "boolean") fail("INVALID_INPUT");
  const validity = value.validity === null ? null : {
    startAt: timestamp(value.validity.startAt),
    endAt: timestamp(value.validity.endAt),
  };
  if (validity !== null && Date.parse(validity.endAt) < Date.parse(validity.startAt)) {
    fail("INVALID_INPUT");
  }
  const pricingCurrency = value.pricingCurrency === null
    ? null
    : text(value.pricingCurrency, CURRENCY);
  const committedAmountMicros = value.committedAmount === null
    ? null
    : toMicros(text(value.committedAmount, /^-?(?:0|[1-9]\d{0,23})(?:\.\d{1,6})?$/u));
  if (value.committedAmount !== null && committedAmountMicros === null) fail("INVALID_INPUT");
  if ((committedAmountMicros !== null || value.paymentSchedule.length > 0) && pricingCurrency === null) {
    fail("INVALID_INPUT");
  }
  const paymentSchedule = value.paymentSchedule.map((entry) => {
    exactKeys(entry, ["chargeAt", "amount"]);
    const parsed = toMicros(text(entry.amount, /^-?(?:0|[1-9]\d{0,23})(?:\.\d{1,6})?$/u));
    if (parsed === null) return fail("INVALID_INPUT");
    return { chargeAt: timestamp(entry.chargeAt), amountMicros: parsed };
  });
  if (paymentSchedule.length > 100) fail("LIMIT_EXCEEDED");
  const dimensionCount = value.dimensionCount === null
    ? null
    : integer(value.dimensionCount, 0, 100_000);
  return {
    termId: value.termId,
    type: value.type,
    legalDocumentTypes,
    autoRenew: value.autoRenew,
    validity,
    pricingCurrency,
    committedAmountMicros,
    dimensionCount,
    paymentSchedule,
  };
}

function expirationState(endAt: string | null, nowEpochMs: number): NormalizedAwsMarketplaceAgreement["expirationState"] {
  if (endAt === null) return "NO_END_DATE";
  const remaining = Date.parse(endAt) - nowEpochMs;
  if (remaining < 0) return "EXPIRED";
  if (remaining <= 30 * DAY_MS) return "EXPIRING_30_DAYS";
  if (remaining <= 60 * DAY_MS) return "EXPIRING_60_DAYS";
  if (remaining <= 90 * DAY_MS) return "EXPIRING_90_DAYS";
  return "ACTIVE_BEYOND_90_DAYS";
}

function normalizeAgreement(
  value: AwsMarketplaceAgreementCapture,
  expectedAccounts: ReadonlySet<string>,
  partition: AwsMarketplaceSpgScope["partition"],
  nowEpochMs: number,
): NormalizedAwsMarketplaceAgreement {
  exactKeys(value, [
    "sourceAccountId", "agreementId", "agreementType", "acceptorAccountId",
    "status", "acceptanceAt", "startAt", "endAt", "offerId", "productId",
    "estimatedCharges", "product", "terms", "entitlements", "charges",
  ]);
  text(value.sourceAccountId, ACCOUNT_ID);
  text(value.agreementId, PROVIDER_ID);
  if (value.agreementType !== "PurchaseAgreement"
    || value.acceptorAccountId !== value.sourceAccountId
    || !expectedAccounts.has(value.sourceAccountId)) {
    fail("ACCOUNT_COVERAGE_MISMATCH");
  }
  if (!AGREEMENT_STATUSES.has(value.status)) fail("INVALID_INPUT");
  const acceptanceAt = optionalTimestamp(value.acceptanceAt);
  const startAt = optionalTimestamp(value.startAt);
  const endAt = optionalTimestamp(value.endAt);
  if (startAt !== null && endAt !== null && Date.parse(endAt) < Date.parse(startAt)) {
    fail("INVALID_INPUT");
  }
  const offerId = value.offerId === null ? null : text(value.offerId, PROVIDER_ID);
  const productId = value.productId === null ? null : text(value.productId, PRODUCT_ID);
  if (value.terms.length > AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.maximumTermsPerAgreement
    || value.entitlements.length > AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.maximumEntitlementsPerAgreement
    || value.charges.length > AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.maximumChargesPerAgreement) {
    fail("LIMIT_EXCEEDED");
  }
  const terms = value.terms.map(normalizeTerm);
  const entitlements = value.entitlements.map((entry) => {
    exactKeys(entry, ["type", "status", "statusReasonCode", "resourceType", "resourceId", "licenseArn"]);
    text(entry.type);
    if (!AGREEMENT_ENTITLEMENT_STATUSES.has(entry.status)
      || (entry.statusReasonCode !== null
        && !AGREEMENT_ENTITLEMENT_REASON_CODES.has(entry.statusReasonCode))) {
      fail("INVALID_INPUT");
    }
    if (entry.resourceType !== null) text(entry.resourceType);
    if (entry.resourceId !== null) text(entry.resourceId, PROVIDER_ID);
    if (entry.licenseArn !== null) assertArnPartition(entry.licenseArn, partition);
    return { ...entry };
  });
  const chargeIds = new Set<string>();
  const charges = value.charges.map((entry) => {
    exactKeys(entry, ["chargeId", "revision", "chargeAt", "money"]);
    text(entry.chargeId, PROVIDER_ID);
    if (chargeIds.has(entry.chargeId)) fail("CONFLICTING_DUPLICATE");
    chargeIds.add(entry.chargeId);
    integer(entry.revision, 1, Number.MAX_SAFE_INTEGER);
    if (entry.chargeAt !== null) timestamp(entry.chargeAt);
    money(entry.money);
    return { ...entry };
  });
  const product = value.product;
  if (product !== null) {
    exactKeys(product, [
      "productId", "productName", "sellerDisplayName", "sellerProfileId",
      "deployedOnAws", "fulfillmentTypes",
    ]);
    text(product.productId, PRODUCT_ID);
    text(product.productName);
    text(product.sellerDisplayName);
    if (product.sellerProfileId !== null) text(product.sellerProfileId, PRODUCT_ID);
    if (!new Set(["DEPLOYED", "NOT_DEPLOYED", "NOT_APPLICABLE"]).has(product.deployedOnAws)) {
      fail("INVALID_INPUT");
    }
    uniqueStrings(product.fulfillmentTypes, 20);
    if (productId !== null && product.productId !== productId) fail("INVALID_INPUT");
  }
  const estimated = value.estimatedCharges === null ? null : money(value.estimatedCharges);
  return {
    ...value,
    acceptanceAt,
    startAt,
    endAt,
    offerId,
    productId,
    estimatedCharges: estimated === null ? null : {
      ...estimated,
      meaning: "KNOWN_LIFECYCLE_COMMITMENT_NOT_USAGE_ACTUAL",
    },
    product,
    terms,
    entitlements,
    charges,
    expirationState: expirationState(endAt, nowEpochMs),
  };
}

function normalizeLicense(
  value: AwsMarketplaceLicenseCapture,
  allowedAccounts: ReadonlySet<string>,
  partition: AwsMarketplaceSpgScope["partition"],
): AwsMarketplaceLicenseCapture {
  exactKeys(value, [
    "licenseArn", "beneficiaryAccountId", "homeRegion", "issuerName",
    "productSku", "productName", "licenseName", "status", "receivedStatus",
    "validity", "entitlements",
  ]);
  assertArnPartition(value.licenseArn, partition);
  if (!allowedAccounts.has(text(value.beneficiaryAccountId, ACCOUNT_ID))) {
    fail("ACCOUNT_COVERAGE_MISMATCH");
  }
  text(value.homeRegion, REGION);
  if (value.issuerName !== "AWS/Marketplace") fail("COLLECTION_POLICY_VIOLATION");
  text(value.productSku);
  text(value.productName);
  text(value.licenseName);
  if (!LICENSE_STATUSES.has(value.status)) fail("INVALID_INPUT");
  if (value.receivedStatus !== null) text(value.receivedStatus);
  const validity = value.validity === null ? null : {
    startAt: timestamp(value.validity.startAt),
    endAt: timestamp(value.validity.endAt),
  };
  if (validity !== null && Date.parse(validity.endAt) < Date.parse(validity.startAt)) {
    fail("INVALID_INPUT");
  }
  if (value.entitlements.length > AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.maximumLicenseEntitlements) {
    fail("LIMIT_EXCEEDED");
  }
  const entitlements = value.entitlements.map((entry) => {
    exactKeys(entry, ["name", "unit", "value", "maxCount", "overageAllowed"]);
    text(entry.name);
    if (!LICENSE_ENTITLEMENT_UNITS.has(entry.unit)) fail("INVALID_INPUT");
    if (entry.value !== null) text(entry.value);
    if (entry.maxCount !== null && !/^\d{1,30}$/u.test(entry.maxCount)) fail("INVALID_INPUT");
    if (entry.overageAllowed !== null && typeof entry.overageAllowed !== "boolean") fail("INVALID_INPUT");
    return { ...entry };
  });
  return { ...value, validity, entitlements };
}

function normalizeGrant(
  value: AwsMarketplaceGrantCapture,
  licenseArns: ReadonlySet<string>,
  allowedAccounts: ReadonlySet<string>,
  partition: AwsMarketplaceSpgScope["partition"],
): AwsMarketplaceGrantCapture {
  exactKeys(value, [
    "grantArn", "licenseArn", "granteeAccountId", "homeRegion", "status",
    "version", "operations", "activationOverrideBehavior",
  ]);
  assertArnPartition(value.grantArn, partition);
  assertArnPartition(value.licenseArn, partition);
  if (!licenseArns.has(value.licenseArn)) fail("INVALID_INPUT");
  if (!allowedAccounts.has(text(value.granteeAccountId, ACCOUNT_ID))) {
    fail("ACCOUNT_COVERAGE_MISMATCH");
  }
  text(value.homeRegion, REGION);
  text(value.version);
  if (!GRANT_STATUSES.has(value.status)
    || (value.activationOverrideBehavior !== null
      && value.activationOverrideBehavior !== "DISTRIBUTED_GRANTS_ONLY"
      && value.activationOverrideBehavior !== "ALL_GRANTS_PERMITTED_BY_ISSUER")) {
    fail("INVALID_INPUT");
  }
  const operations = uniqueStrings(value.operations, 8);
  return { ...value, operations };
}

function channelState(
  operations: readonly AwsMarketplaceOperationCoverage[],
  names: readonly AwsMarketplaceOperation[],
  count: number,
): "READY" | "EMPTY" | "PARTIAL" {
  const selected = operations.filter((entry) => names.includes(entry.operation));
  const complete = names.every((name) => selected.some((entry) => entry.operation === name && entry.state === "SUCCEEDED"));
  if (!complete) return "PARTIAL";
  return count === 0 ? "EMPTY" : "READY";
}

function spendSummary(cur2: AwsMarketplaceCur2Evidence | null): AwsMarketplaceSpendSummary[] {
  if (cur2 === null) return [];
  const totals = new Map<string, { billed: bigint; amortized: bigint; hasAmortized: boolean; rows: number }>();
  for (const row of cur2.rows) {
    const bucket = totals.get(row.currency) ?? {
      billed: BigInt(0),
      amortized: BigInt(0),
      hasAmortized: false,
      rows: 0,
    };
    bucket.billed += BigInt(row.billedAmountMicros);
    if (row.amortizedAmountMicros !== null) {
      bucket.amortized += BigInt(row.amortizedAmountMicros);
      bucket.hasAmortized = true;
    }
    bucket.rows += 1;
    totals.set(row.currency, bucket);
  }
  return [...totals.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([currency, value]) => ({
    currency,
    billedAmountMicros: value.billed.toString(),
    amortizedAmountMicros: value.hasAmortized ? value.amortized.toString() : null,
    rowCount: value.rows,
  }));
}

export function normalizeAwsMarketplaceSpgCapture(
  capture: AwsMarketplaceSpgCapture,
  expectedScope: AwsMarketplaceSpgScope,
  nowEpochMs = Date.now(),
): AwsMarketplaceSpgSnapshot {
  if (!Number.isFinite(nowEpochMs)) fail("INVALID_INPUT");
  exactKeys(capture, [
    "schemaVersion", "scope", "captureId", "startedAt", "completedAt",
    "agreementRegion", "discoveryRegion", "licenseManagerRegion",
    "agreementParty", "agreementAccountCoverage", "licenseCollectionMode",
    "licenseManagerSettings", "operationCoverage", "agreements", "licenses",
    "grants", "cur2",
  ]);
  if (capture.schemaVersion !== "sutra.aws-marketplace-spg.v1") fail("INVALID_INPUT");
  const normalizedScope = scope(capture.scope);
  const normalizedExpectedScope = scope(expectedScope);
  if (!sameScope(normalizedScope, normalizedExpectedScope)) fail("SCOPE_MISMATCH");
  if (normalizedScope.partition !== "aws") fail("UNSUPPORTED_PARTITION");
  text(capture.captureId, CAPTURE_ID);
  const startedAt = timestamp(capture.startedAt);
  const completedAt = timestamp(capture.completedAt);
  if (Date.parse(completedAt) < Date.parse(startedAt)
    || Date.parse(completedAt) > nowEpochMs + MAX_CLOCK_SKEW_MS) fail("INVALID_INPUT");
  if (capture.agreementRegion !== AWS_MARKETPLACE_AGREEMENT_REGION
    || capture.discoveryRegion !== AWS_MARKETPLACE_DISCOVERY_REGION
    || capture.agreementParty !== "Acceptor") fail("COLLECTION_POLICY_VIOLATION");
  text(capture.licenseManagerRegion, REGION);

  exactKeys(capture.agreementAccountCoverage, [
    "basis", "evidenceId", "observedAt", "expectedAccountIds", "capturedAgreementAccountIds",
  ]);
  text(capture.agreementAccountCoverage.evidenceId, EVIDENCE_ID);
  timestamp(capture.agreementAccountCoverage.observedAt);
  const expectedAccounts = uniqueStrings(
    capture.agreementAccountCoverage.expectedAccountIds,
    AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.maximumOrganizationAccounts,
  );
  const capturedAccounts = uniqueStrings(
    capture.agreementAccountCoverage.capturedAgreementAccountIds,
    AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.maximumOrganizationAccounts,
  );
  if (expectedAccounts.length === 0
    || !expectedAccounts.includes(normalizedScope.accountId)
    || expectedAccounts.some((id) => !ACCOUNT_ID.test(id))
    || capturedAccounts.some((id) => !expectedAccounts.includes(id))) {
    fail("ACCOUNT_COVERAGE_MISMATCH");
  }
  if (capture.agreementAccountCoverage.basis === "SINGLE_CONNECTED_ACCOUNT"
    && (expectedAccounts.length !== 1 || expectedAccounts[0] !== normalizedScope.accountId)) {
    fail("ACCOUNT_COVERAGE_MISMATCH");
  }
  const expectedSet = new Set(expectedAccounts);
  const capturedSet = new Set(capturedAccounts);

  if (capture.operationCoverage.length > AWS_MARKETPLACE_BUYER_API_OPERATIONS.length
      + AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS.length) fail("LIMIT_EXCEEDED");
  const operationSet = new Set<string>();
  for (const operation of capture.operationCoverage) {
    exactKeys(operation, ["operation", "state", "recordCount", "pageCount", "failureCode"]);
    if (operationSet.has(operation.operation)) fail("CONFLICTING_DUPLICATE");
    operationSet.add(operation.operation);
    if (![...AWS_MARKETPLACE_BUYER_API_OPERATIONS, ...AWS_MARKETPLACE_LICENSE_MANAGER_API_OPERATIONS]
      .includes(operation.operation)
      || !new Set(["SUCCEEDED", "PARTIAL", "ACCESS_DENIED", "CONFIGURATION_REQUIRED", "UNAVAILABLE"])
        .has(operation.state)
      || (operation.failureCode !== null
        && !new Set([
          "ACCESS_DENIED", "EXPIRED_TOKEN", "THROTTLED", "TIMEOUT", "BOUND_REACHED",
          "SERVICE_NOT_ENABLED", "UNSUPPORTED_PARTITION", "PROVIDER_UNAVAILABLE", "UNKNOWN",
        ]).has(operation.failureCode))) {
      fail("INVALID_INPUT");
    }
    integer(operation.recordCount, 0, 1_000_000);
    integer(operation.pageCount, 0, AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.maximumPagesPerSequence);
    if ((operation.state === "SUCCEEDED") !== (operation.failureCode === null)) fail("INVALID_INPUT");
  }

  if (capture.agreements.length > AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.maximumAgreements
    || capture.licenses.length > AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.maximumLicenses
    || capture.grants.length > AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.maximumGrants) {
    fail("LIMIT_EXCEEDED");
  }
  const agreementIds = new Set<string>();
  const agreements = capture.agreements.map((entry) => {
    const normalized = normalizeAgreement(entry, capturedSet, normalizedScope.partition, nowEpochMs);
    if (agreementIds.has(normalized.agreementId)) fail("CONFLICTING_DUPLICATE");
    agreementIds.add(normalized.agreementId);
    return normalized;
  }).sort((left, right) => left.agreementId.localeCompare(right.agreementId));

  exactKeys(capture.licenseManagerSettings, ["organizationIntegrationEnabled", "crossAccountDiscoveryEnabled"]);
  for (const setting of [
    capture.licenseManagerSettings.organizationIntegrationEnabled,
    capture.licenseManagerSettings.crossAccountDiscoveryEnabled,
  ]) if (setting !== null && typeof setting !== "boolean") fail("INVALID_INPUT");
  if (capture.licenseCollectionMode === "ORGANIZATION"
    && capture.licenseManagerSettings.organizationIntegrationEnabled !== true
    && (capture.licenses.length > 0 || capture.grants.length > 0)) {
    fail("COLLECTION_POLICY_VIOLATION");
  }
  const allowedLicenseAccounts = capture.licenseCollectionMode === "ORGANIZATION"
    ? expectedSet
    : new Set([normalizedScope.accountId]);
  const licenseArns = new Set<string>();
  const licenses = capture.licenses.map((entry) => {
    const normalized = normalizeLicense(entry, allowedLicenseAccounts, normalizedScope.partition);
    if (licenseArns.has(normalized.licenseArn)) fail("CONFLICTING_DUPLICATE");
    licenseArns.add(normalized.licenseArn);
    return normalized;
  }).sort((left, right) => left.licenseArn.localeCompare(right.licenseArn));
  const grantArns = new Set<string>();
  const grants = capture.grants.map((entry) => {
    const normalized = normalizeGrant(entry, licenseArns, allowedLicenseAccounts, normalizedScope.partition);
    if (grantArns.has(normalized.grantArn)) fail("CONFLICTING_DUPLICATE");
    grantArns.add(normalized.grantArn);
    return normalized;
  }).sort((left, right) => left.grantArn.localeCompare(right.grantArn));

  const cur2 = capture.cur2;
  if (cur2 !== null) {
    exactKeys(cur2, [
      "scope", "generationId", "sourceEvidenceId", "dataThroughAt",
      "reconciliationState", "predicate", "rows",
    ]);
    if (!sameScope(scope(cur2.scope), normalizedScope)) fail("SCOPE_MISMATCH");
    text(cur2.generationId, EVIDENCE_ID);
    text(cur2.sourceEvidenceId, EVIDENCE_ID);
    timestamp(cur2.dataThroughAt);
    if (!new Set(["reconciled", "partial", "failed"]).has(cur2.reconciliationState)
      || !new Set([
        "CUR2_BILLING_ENTITY_AWS_MARKETPLACE",
        "CUR2_PRODUCT_FAMILY_AWS_MARKETPLACE",
      ]).has(cur2.predicate)) fail("INVALID_INPUT");
    if (cur2.rows.length > AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.maximumSpendRows) fail("LIMIT_EXCEEDED");
    cur2.rows.forEach((row) => {
      exactKeys(row, [
        "linkedAccountId", "billingPeriod", "invoiceId", "productCode",
        "productName", "sellerName", "chargeCategory", "currency",
        "billedAmountMicros", "amortizedAmountMicros",
      ]);
      if (!expectedSet.has(text(row.linkedAccountId, ACCOUNT_ID))) fail("ACCOUNT_COVERAGE_MISMATCH");
      text(row.billingPeriod, /^\d{4}-(?:0[1-9]|1[0-2])$/u);
      if (row.invoiceId !== null) text(row.invoiceId, PROVIDER_ID);
      if (row.productCode !== null) text(row.productCode, PRODUCT_ID);
      text(row.productName);
      text(row.sellerName);
      if (!new Set([
        "usage", "subscription", "upfront", "recurring", "tax", "credit", "refund", "other",
      ]).has(row.chargeCategory)) fail("INVALID_INPUT");
      text(row.currency, CURRENCY);
      text(row.billedAmountMicros, INTEGER_MICROS);
      if (row.amortizedAmountMicros !== null) text(row.amortizedAmountMicros, INTEGER_MICROS);
    });
  }

  const agreementState = channelState(capture.operationCoverage, [
    "SearchAgreements", "DescribeAgreement", "GetAgreementTerms",
    "GetAgreementEntitlements", "ListAgreementCharges", "GetProduct",
  ], agreements.length);
  const licenseOperations: readonly AwsMarketplaceOperation[] = capture.licenseCollectionMode === "ORGANIZATION"
    ? ["GetServiceSettings", "ListReceivedLicensesForOrganization", "ListReceivedGrantsForOrganization"]
    : ["GetServiceSettings", "ListReceivedLicenses", "ListReceivedGrants"];
  let licenseState: AwsMarketplaceSpgSnapshot["channelStates"]["licenses"];
  if (capture.licenseCollectionMode === "ORGANIZATION"
    && capture.licenseManagerSettings.organizationIntegrationEnabled !== true) {
    licenseState = "CONFIGURATION_REQUIRED";
  } else {
    licenseState = channelState(capture.operationCoverage, licenseOperations, licenses.length);
  }
  const spendState: AwsMarketplaceSpgSnapshot["channelStates"]["spend"] = cur2 === null
    ? "CONFIGURATION_REQUIRED"
    : cur2.reconciliationState === "reconciled"
    ? (cur2.rows.length === 0 ? "EMPTY" : "READY")
    : "PARTIAL";
  const organizationCoverage: AwsMarketplaceSpgSnapshot["organizationCoverage"] =
    capture.agreementAccountCoverage.basis === "SINGLE_CONNECTED_ACCOUNT"
      ? "SINGLE_ACCOUNT_ONLY"
      : capture.agreementAccountCoverage.basis === "AWS_ORGANIZATIONS_ACTIVE_ACCOUNTS"
        && capturedAccounts.length === expectedAccounts.length
        && capture.licenseCollectionMode === "ORGANIZATION"
        && capture.licenseManagerSettings.organizationIntegrationEnabled === true
      ? "COMPLETE"
      : "PARTIAL";
  const dataThroughAt = [
    completedAt,
    capture.agreementAccountCoverage.observedAt,
    cur2?.dataThroughAt,
  ].filter((value): value is string => value !== undefined)
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0]!;
  const ageHours = Math.max(0, (nowEpochMs - Date.parse(dataThroughAt)) / (60 * 60 * 1_000));
  const freshnessStatus = ageHours > AWS_MARKETPLACE_SPG_COLLECTION_BOUNDS.agreementFreshnessSlaHours
    ? "STALE" as const
    : "FRESH" as const;
  const allEmpty = agreementState === "EMPTY" && licenseState === "EMPTY" && spendState === "EMPTY";
  const configuredRequired = licenseState === "CONFIGURATION_REQUIRED" || spendState === "CONFIGURATION_REQUIRED";
  const partial = agreementState === "PARTIAL" || licenseState === "PARTIAL" || spendState === "PARTIAL"
    || organizationCoverage === "PARTIAL";
  const state: AwsMarketplaceSpgSnapshot["state"] = freshnessStatus === "STALE"
    ? "STALE"
    : configuredRequired
    ? "CONFIGURATION_REQUIRED"
    : partial
    ? "PARTIAL"
    : allEmpty
    ? "EMPTY"
    : "READY";
  const limitations = [
    "Agreement API evidence is acceptor-side buyer evidence. Sutra does not claim seller/proposer API coverage.",
    "Agreement estimated charges are known lifecycle commitment, not reconciled realized spend; CUR2 remains authoritative for billed spend.",
    "Registration tokens, purchase-order references, legal-document URLs/content, contacts, issuer keys, free-form metadata, and provider error text are excluded.",
    "GetBuyerDashboard returns a temporary embed URL, not ingestible source rows, and is outside this data contract.",
  ];
  if (organizationCoverage !== "COMPLETE") {
    limitations.push("Organization-wide Marketplace coverage has not been proven for every active account.");
  }
  if (capture.licenseCollectionMode !== "ORGANIZATION") {
    limitations.push("License and grant evidence covers only the connected account; enable License Manager organization integration for organization coverage.");
  }
  if (cur2 === null) limitations.push("CUR2 Marketplace spend evidence is not configured; agreement amounts must not be shown as realized spend.");

  return {
    schemaVersion: "sutra.aws-marketplace-spg.snapshot.v1",
    scope: normalizedScope,
    captureId: capture.captureId,
    capturedAt: completedAt,
    state,
    organizationCoverage,
    channelStates: { agreements: agreementState, licenses: licenseState, spend: spendState },
    freshness: { status: freshnessStatus, dataThroughAt, ageHours },
    agreements,
    licenses,
    grants,
    spend: {
      sourceEvidenceId: cur2?.sourceEvidenceId ?? null,
      generationId: cur2?.generationId ?? null,
      predicate: cur2?.predicate ?? null,
      summaries: spendSummary(cur2),
    },
    counts: {
      expectedAgreementAccounts: expectedAccounts.length,
      capturedAgreementAccounts: capturedAccounts.length,
      agreements: agreements.length,
      expiringWithin90Days: agreements.filter((entry) =>
        entry.expirationState === "EXPIRING_30_DAYS"
        || entry.expirationState === "EXPIRING_60_DAYS"
        || entry.expirationState === "EXPIRING_90_DAYS"
      ).length,
      licenses: licenses.length,
      grants: grants.length,
      activeGrants: grants.filter((entry) => entry.status === "ACTIVE").length,
      cur2Rows: cur2?.rows.length ?? 0,
    },
    limitations,
  };
}

export function awsMarketplaceSpgSourceEvidence(
  snapshot: AwsMarketplaceSpgSnapshot,
): FinopsSourceEvidence {
  const failed = snapshot.state === "PARTIAL" || snapshot.state === "CONFIGURATION_REQUIRED";
  const accepted = snapshot.counts.agreements + snapshot.counts.licenses
    + snapshot.counts.grants + snapshot.counts.cur2Rows;
  return {
    scope: snapshot.scope,
    sourceId: "aws_marketplace_intelligence",
    configured: true,
    deliveryObserved: true,
    lastAttemptAt: snapshot.capturedAt,
    lastAttemptOutcome: failed ? "partial" : "succeeded",
    lastSuccessAt: failed ? null : snapshot.capturedAt,
    dataThroughAt: snapshot.freshness.dataThroughAt,
    coverage: {
      assessment: snapshot.organizationCoverage === "COMPLETE"
          && !failed ? "complete" : "partial",
      acceptedRecords: accepted,
      expectedRecords: snapshot.organizationCoverage === "COMPLETE" && !failed
        ? accepted
        : null,
      rejectedRecords: 0,
    },
    lastError: null,
    evidenceBasis: `AWS Marketplace buyer capture ${snapshot.captureId}; CUR2 generation ${snapshot.spend.generationId ?? "not-configured"}.`,
    limitations: snapshot.limitations,
  };
}
