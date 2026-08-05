/**
 * Pure, deterministic query projections over one reconciled active billing
 * generation. Persistence must bind the requested scope to the active
 * generation before calling this module; every supplied row is checked again.
 *
 * Evidence-honesty guarantees:
 * - currencies are independent buckets and are never converted or combined;
 * - all cost and quantity arithmetic uses signed integer micro-units via BigInt;
 * - usage quantities remain separate by unit, including an explicit null unit;
 * - missing dimensions and missing cost bases remain visible as null/coverage;
 * - pagination and filters use a bounded exact-match allowlist.
 */
import type { CanonicalCurLine, CurChargeKind } from "./finops-cur";
import {
  FINOPS_RECONCILIATION_CURRENCIES,
  type FinopsReconciliationScope,
  type ScopedCanonicalBillingRow,
} from "./finops-reconciliation.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const GENERATION_ID = /^fbg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INTEGER_MICROS = /^-?(?:0|[1-9]\d{0,127})$/u;
const DAY = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u;
const MAX_ACTIVE_ROWS = 250_000;
const MAX_BUCKETS = 50_000;
const MAX_FILTER_VALUES_PER_FIELD = 100;
const MAX_FILTER_PREDICATES = 20;
const MAX_TOTAL_FILTER_VALUES = 250;
const MAX_PAGE_SIZE = 500;
const DEFAULT_PAGE_SIZE = 100;
const MAX_CURSOR_LENGTH = 16_384;
const DEFAULT_STALE_AFTER_SECONDS = 36 * 60 * 60;
const MAX_STALE_AFTER_SECONDS = 31 * 24 * 60 * 60;

export const FINOPS_PROJECTION_DIMENSIONS = [
  "hourly",
  "daily",
  "monthly",
  "account",
  "service",
  "region",
  "resource",
  "charge_kind",
  "charge_category",
  "commitment",
  "invoice",
  "legal_entity",
  "billing_entity",
  "tag",
  "cost_category",
] as const;

export type FinopsProjectionDimension =
  typeof FINOPS_PROJECTION_DIMENSIONS[number];

export const FINOPS_COST_BASES = [
  "unblended",
  "net",
  "amortized",
  "list",
  "contracted",
  "public",
] as const;

export type FinopsCostBasis = typeof FINOPS_COST_BASES[number];

export interface FinopsBillingProjectionEvidenceInput {
  readonly sourceEvidenceId: string;
  readonly manifestSha256: string;
  readonly sourceUpdatedAtIso: string | null;
  readonly observedAtIso: string;
  readonly committedAtIso: string;
  readonly evaluatedAtIso: string;
  readonly reconciledRowCount: number;
  readonly staleAfterSeconds?: number;
}

export interface FinopsProjectionTagPredicate {
  readonly key: string;
  readonly value: string;
}

export interface FinopsBillingProjectionFilters {
  readonly currencies?: readonly string[];
  readonly accountIds?: readonly string[];
  readonly services?: readonly string[];
  readonly regions?: readonly string[];
  readonly resourceIds?: readonly string[];
  readonly chargeKinds?: readonly CurChargeKind[];
  readonly chargeCategories?: readonly string[];
  readonly commitmentIds?: readonly string[];
  readonly invoiceIds?: readonly string[];
  readonly legalEntities?: readonly string[];
  readonly billingEntities?: readonly string[];
  readonly tags?: readonly FinopsProjectionTagPredicate[];
  readonly costCategories?: readonly FinopsProjectionTagPredicate[];
  readonly fromDayInclusive?: string;
  readonly toDayExclusive?: string;
}

export interface FinopsBillingProjectionQuery {
  readonly dimension: FinopsProjectionDimension;
  /** Required only for tag and cost_category dimensions. */
  readonly dimensionKey?: string;
  /** Primary amount displayed in each bucket; all six bases remain disclosed. */
  readonly costBasis?: FinopsCostBasis;
  readonly filters?: FinopsBillingProjectionFilters;
  readonly page?: {
    readonly limit?: number;
    readonly cursor?: string;
  };
}

export interface FinopsBillingProjectionInput {
  readonly scope: FinopsReconciliationScope;
  readonly evidence: FinopsBillingProjectionEvidenceInput;
  readonly rows: readonly ScopedCanonicalBillingRow[];
  readonly query: FinopsBillingProjectionQuery;
}

export type FinopsBillingProjectionFailureCode =
  | "INVALID_SCOPE"
  | "INVALID_EVIDENCE"
  | "EVIDENCE_ROW_COUNT_MISMATCH"
  | "INVALID_QUERY"
  | "UNSAFE_FILTER"
  | "INVALID_CURSOR"
  | "ACTIVE_ROW_LIMIT_EXCEEDED"
  | "BUCKET_LIMIT_EXCEEDED"
  | "ROW_SCOPE_MISMATCH"
  | "INVALID_CANONICAL_ROW"
  | "UNKNOWN_CURRENCY";

export interface FinopsBillingProjectionFailure {
  readonly code: FinopsBillingProjectionFailureCode;
  readonly field: string;
  readonly rowIndex?: number;
}

export interface FinopsProjectionCostSummary {
  readonly basis: FinopsCostBasis;
  readonly totalMicros: string | null;
  readonly contributingRowCount: number;
  readonly missingRowCount: number;
  readonly coverage: "complete" | "partial" | "unavailable";
}

export interface FinopsProjectionUsageSummary {
  /** null is an explicit unknown unit and is never combined with a named unit. */
  readonly unit: string | null;
  readonly quantityMicros: string;
  readonly rowCount: number;
}

export interface FinopsBillingProjectionBucket {
  readonly currency: string;
  readonly dimension: FinopsProjectionDimension;
  readonly dimensionValues: Readonly<Record<string, string | null>>;
  readonly rowCount: number;
  readonly selectedCostBasis: FinopsCostBasis;
  readonly selectedTotalMicros: string | null;
  readonly costs: readonly FinopsProjectionCostSummary[];
  /**
   * amortized - unblended when every row carries an amortized basis; otherwise
   * null so an incomplete commitment true-up is never represented as zero.
   */
  readonly amortizedTrueUpMicros: string | null;
  readonly usage: readonly FinopsProjectionUsageSummary[];
  readonly usageQuantityRowCount: number;
  readonly missingUsageQuantityRowCount: number;
  readonly mixedUsageUnits: boolean;
}

export interface FinopsProjectionFreshness {
  readonly status: "fresh" | "stale" | "future" | "unknown";
  readonly sourceUpdatedAtIso: string | null;
  readonly evaluatedAtIso: string;
  readonly ageSeconds: number | null;
  readonly staleAfterSeconds: number;
}

export interface FinopsProjectionSourceEvidence {
  readonly sourceFormat: CanonicalCurLine["sourceFormat"];
  readonly sourceVersion: CanonicalCurLine["sourceVersion"];
  readonly rowCount: number;
}

export interface FinopsProjectionAvailability {
  readonly resource: "complete" | "partial" | "unavailable";
  readonly resourceRowCount: number;
  readonly hourly: "complete" | "partial" | "unavailable";
  readonly hourlyRowCount: number;
}

export interface FinopsBillingProjectionEvidence {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly exportName: string;
  readonly billingPeriod: string;
  readonly generationId: string;
  readonly sourceEvidenceId: string;
  readonly manifestSha256: string;
  readonly observedAtIso: string;
  readonly committedAtIso: string;
  readonly activeRowCount: number;
  readonly matchedRowCount: number;
  readonly sources: readonly FinopsProjectionSourceEvidence[];
  readonly freshness: FinopsProjectionFreshness;
  readonly availability: FinopsProjectionAvailability;
}

export type FinopsBillingProjectionResult =
  | {
      readonly ok: true;
      readonly schema: "sutra.finops-billing-projection.v1";
      readonly evidence: FinopsBillingProjectionEvidence;
      readonly query: {
        readonly dimension: FinopsProjectionDimension;
        readonly dimensionKey: string | null;
        readonly costBasis: FinopsCostBasis;
        readonly filtersApplied: number;
        readonly pageSize: number;
      };
      readonly buckets: readonly FinopsBillingProjectionBucket[];
      readonly totalBuckets: number;
      readonly nextCursor: string | null;
      readonly failures: readonly [];
    }
  | {
      readonly ok: false;
      readonly schema: "sutra.finops-billing-projection.v1";
      readonly failures: readonly FinopsBillingProjectionFailure[];
    };

interface NormalizedFilters {
  readonly currencies: readonly string[];
  readonly accountIds: readonly string[];
  readonly services: readonly string[];
  readonly regions: readonly string[];
  readonly resourceIds: readonly string[];
  readonly chargeKinds: readonly CurChargeKind[];
  readonly chargeCategories: readonly string[];
  readonly commitmentIds: readonly string[];
  readonly invoiceIds: readonly string[];
  readonly legalEntities: readonly string[];
  readonly billingEntities: readonly string[];
  readonly tags: readonly FinopsProjectionTagPredicate[];
  readonly costCategories: readonly FinopsProjectionTagPredicate[];
  readonly fromDayInclusive: string | null;
  readonly toDayExclusive: string | null;
}

interface NormalizedQuery {
  readonly dimension: FinopsProjectionDimension;
  readonly dimensionKey: string | null;
  readonly costBasis: FinopsCostBasis;
  readonly filters: NormalizedFilters;
  readonly filtersApplied: number;
  readonly pageSize: number;
  readonly cursor: string | null;
  readonly signature: string;
}

interface MutableCost {
  total: bigint;
  contributingRowCount: number;
}

interface MutableUsage {
  total: bigint;
  rowCount: number;
}

interface MutableBucket {
  readonly currency: string;
  readonly dimensionValues: Readonly<Record<string, string | null>>;
  rowCount: number;
  readonly costs: Record<FinopsCostBasis, MutableCost>;
  readonly usage: Map<string, MutableUsage>;
  usageQuantityRowCount: number;
}

const QUERY_KEYS = new Set([
  "dimension",
  "dimensionKey",
  "costBasis",
  "filters",
  "page",
]);
const PAGE_KEYS = new Set(["limit", "cursor"]);
const FILTER_KEYS = new Set([
  "currencies",
  "accountIds",
  "services",
  "regions",
  "resourceIds",
  "chargeKinds",
  "chargeCategories",
  "commitmentIds",
  "invoiceIds",
  "legalEntities",
  "billingEntities",
  "tags",
  "costCategories",
  "fromDayInclusive",
  "toDayExclusive",
]);
const CHARGE_KINDS = new Set<CurChargeKind>([
  "usage",
  "purchase",
  "tax",
  "credit",
  "refund",
  "discount",
  "adjustment",
  "other",
]);
const SOURCE_FORMATS = new Set(["aws-cur", "focus"]);
const SOURCE_VERSIONS = new Set(["2.0", "1.0", "1.2"]);
const UNSAFE_EXACT_FILTER = /[*?%]/u;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, maxLength = 1_024): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !value.includes("\0");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validDay(value: unknown): value is string {
  if (typeof value !== "string" || !DAY.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed)
    && new Date(parsed).toISOString().slice(0, 10) === value;
}

function validScope(scope: unknown): scope is FinopsReconciliationScope {
  if (!isRecord(scope)) return false;
  return typeof scope.organizationId === "string"
    && IDENTIFIER.test(scope.organizationId)
    && typeof scope.customerId === "string"
    && IDENTIFIER.test(scope.customerId)
    && typeof scope.connectionId === "string"
    && IDENTIFIER.test(scope.connectionId)
    && validText(scope.exportName, 256)
    && typeof scope.billingPeriod === "string"
    && PERIOD.test(scope.billingPeriod)
    && typeof scope.generationId === "string"
    && GENERATION_ID.test(scope.generationId);
}

function sameScope(
  left: FinopsReconciliationScope,
  right: FinopsReconciliationScope,
): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId
    && left.exportName === right.exportName
    && left.billingPeriod === right.billingPeriod
    && left.generationId === right.generationId;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function safeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function fail(
  code: FinopsBillingProjectionFailureCode,
  field: string,
  rowIndex?: number,
): FinopsBillingProjectionResult {
  return {
    ok: false,
    schema: "sutra.finops-billing-projection.v1",
    failures: [{ code, field, ...(rowIndex === undefined ? {} : { rowIndex }) }],
  };
}

function normalizeStringList(
  value: unknown,
  field: string,
  validator?: (entry: string) => boolean,
): string[] | FinopsBillingProjectionResult {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > MAX_FILTER_VALUES_PER_FIELD
  ) return fail("UNSAFE_FILTER", field);
  const normalized = new Set<string>();
  for (const entry of value) {
    if (
      !validText(entry, 1_024)
      || UNSAFE_EXACT_FILTER.test(entry)
      || (validator !== undefined && !validator(entry))
    ) return fail("UNSAFE_FILTER", field);
    normalized.add(entry);
  }
  return [...normalized].sort(compareText);
}

function normalizePredicates(
  value: unknown,
  field: string,
): FinopsProjectionTagPredicate[] | FinopsBillingProjectionResult {
  if (value === undefined) return [];
  if (
    !Array.isArray(value)
    || value.length === 0
    || value.length > MAX_FILTER_PREDICATES
  ) return fail("UNSAFE_FILTER", field);
  const normalized = new Map<string, FinopsProjectionTagPredicate>();
  for (const predicate of value) {
    if (
      !isRecord(predicate)
      || Object.keys(predicate).some((key) => key !== "key" && key !== "value")
      || !validText(predicate.key, 256)
      || !validText(predicate.value, 1_024)
      || UNSAFE_EXACT_FILTER.test(predicate.key)
      || UNSAFE_EXACT_FILTER.test(predicate.value)
    ) return fail("UNSAFE_FILTER", field);
    normalized.set(
      JSON.stringify([predicate.key, predicate.value]),
      { key: predicate.key, value: predicate.value },
    );
  }
  return [...normalized.values()].sort((left, right) =>
    compareText(left.key, right.key) || compareText(left.value, right.value));
}

function normalizedFilters(
  value: unknown,
): NormalizedFilters | FinopsBillingProjectionResult {
  if (value === undefined) {
    return {
      currencies: [],
      accountIds: [],
      services: [],
      regions: [],
      resourceIds: [],
      chargeKinds: [],
      chargeCategories: [],
      commitmentIds: [],
      invoiceIds: [],
      legalEntities: [],
      billingEntities: [],
      tags: [],
      costCategories: [],
      fromDayInclusive: null,
      toDayExclusive: null,
    };
  }
  if (!isRecord(value) || Object.keys(value).some((key) => !FILTER_KEYS.has(key))) {
    return fail("UNSAFE_FILTER", "query.filters");
  }
  const currencies = normalizeStringList(
    value.currencies,
    "query.filters.currencies",
    (entry) => FINOPS_RECONCILIATION_CURRENCIES.has(
      entry as (typeof FINOPS_RECONCILIATION_CURRENCIES extends Set<infer T> ? T : never),
    ),
  );
  if (!Array.isArray(currencies)) return currencies;
  const accountIds = normalizeStringList(value.accountIds, "query.filters.accountIds");
  if (!Array.isArray(accountIds)) return accountIds;
  const services = normalizeStringList(value.services, "query.filters.services");
  if (!Array.isArray(services)) return services;
  const regions = normalizeStringList(value.regions, "query.filters.regions");
  if (!Array.isArray(regions)) return regions;
  const resourceIds = normalizeStringList(value.resourceIds, "query.filters.resourceIds");
  if (!Array.isArray(resourceIds)) return resourceIds;
  const chargeKinds = normalizeStringList(
    value.chargeKinds,
    "query.filters.chargeKinds",
    (entry) => CHARGE_KINDS.has(entry as CurChargeKind),
  );
  if (!Array.isArray(chargeKinds)) return chargeKinds;
  const chargeCategories = normalizeStringList(
    value.chargeCategories,
    "query.filters.chargeCategories",
  );
  if (!Array.isArray(chargeCategories)) return chargeCategories;
  const commitmentIds = normalizeStringList(
    value.commitmentIds,
    "query.filters.commitmentIds",
  );
  if (!Array.isArray(commitmentIds)) return commitmentIds;
  const invoiceIds = normalizeStringList(value.invoiceIds, "query.filters.invoiceIds");
  if (!Array.isArray(invoiceIds)) return invoiceIds;
  const legalEntities = normalizeStringList(
    value.legalEntities,
    "query.filters.legalEntities",
  );
  if (!Array.isArray(legalEntities)) return legalEntities;
  const billingEntities = normalizeStringList(
    value.billingEntities,
    "query.filters.billingEntities",
  );
  if (!Array.isArray(billingEntities)) return billingEntities;
  const tags = normalizePredicates(value.tags, "query.filters.tags");
  if (!Array.isArray(tags)) return tags;
  const costCategories = normalizePredicates(
    value.costCategories,
    "query.filters.costCategories",
  );
  if (!Array.isArray(costCategories)) return costCategories;

  const fromDayInclusive = value.fromDayInclusive === undefined
    ? null
    : validDay(value.fromDayInclusive)
      ? value.fromDayInclusive
      : undefined;
  const toDayExclusive = value.toDayExclusive === undefined
    ? null
    : validDay(value.toDayExclusive)
      ? value.toDayExclusive
      : undefined;
  if (
    fromDayInclusive === undefined
    || toDayExclusive === undefined
    || (
      fromDayInclusive !== null
      && toDayExclusive !== null
      && fromDayInclusive >= toDayExclusive
    )
  ) return fail("UNSAFE_FILTER", "query.filters.dateRange");

  const totalValues = [
    currencies,
    accountIds,
    services,
    regions,
    resourceIds,
    chargeKinds,
    chargeCategories,
    commitmentIds,
    invoiceIds,
    legalEntities,
    billingEntities,
    tags,
    costCategories,
  ].reduce((sum, entries) => sum + entries.length, 0);
  if (totalValues > MAX_TOTAL_FILTER_VALUES) {
    return fail("UNSAFE_FILTER", "query.filters");
  }
  return {
    currencies,
    accountIds,
    services,
    regions,
    resourceIds,
    chargeKinds: chargeKinds as readonly CurChargeKind[],
    chargeCategories,
    commitmentIds,
    invoiceIds,
    legalEntities,
    billingEntities,
    tags,
    costCategories,
    fromDayInclusive,
    toDayExclusive,
  };
}

function filterCount(filters: NormalizedFilters): number {
  return filters.currencies.length
    + filters.accountIds.length
    + filters.services.length
    + filters.regions.length
    + filters.resourceIds.length
    + filters.chargeKinds.length
    + filters.chargeCategories.length
    + filters.commitmentIds.length
    + filters.invoiceIds.length
    + filters.legalEntities.length
    + filters.billingEntities.length
    + filters.tags.length
    + filters.costCategories.length
    + (filters.fromDayInclusive === null ? 0 : 1)
    + (filters.toDayExclusive === null ? 0 : 1);
}

function querySignature(
  dimension: FinopsProjectionDimension,
  dimensionKey: string | null,
  costBasis: FinopsCostBasis,
  filters: NormalizedFilters,
): string {
  return JSON.stringify({ dimension, dimensionKey, costBasis, filters });
}

function normalizeQuery(
  value: unknown,
): NormalizedQuery | FinopsBillingProjectionResult {
  if (!isRecord(value) || Object.keys(value).some((key) => !QUERY_KEYS.has(key))) {
    return fail("INVALID_QUERY", "query");
  }
  if (
    typeof value.dimension !== "string"
    || !FINOPS_PROJECTION_DIMENSIONS.includes(
      value.dimension as FinopsProjectionDimension,
    )
  ) return fail("INVALID_QUERY", "query.dimension");
  const dimension = value.dimension as FinopsProjectionDimension;
  const dimensionKey = value.dimensionKey === undefined
    ? null
    : validText(value.dimensionKey, 256) && !UNSAFE_EXACT_FILTER.test(value.dimensionKey)
      ? value.dimensionKey
      : undefined;
  if (
    dimensionKey === undefined
    || (
      (dimension === "tag" || dimension === "cost_category")
      !== (dimensionKey !== null)
    )
  ) return fail("INVALID_QUERY", "query.dimensionKey");
  const costBasis = value.costBasis === undefined
    ? "unblended"
    : typeof value.costBasis === "string"
      && FINOPS_COST_BASES.includes(value.costBasis as FinopsCostBasis)
      ? value.costBasis as FinopsCostBasis
      : null;
  if (costBasis === null) return fail("INVALID_QUERY", "query.costBasis");
  const filters = normalizedFilters(value.filters);
  if ("ok" in filters) return filters;

  let pageSize = DEFAULT_PAGE_SIZE;
  let cursor: string | null = null;
  if (value.page !== undefined) {
    if (!isRecord(value.page) || Object.keys(value.page).some((key) => !PAGE_KEYS.has(key))) {
      return fail("INVALID_QUERY", "query.page");
    }
    if (value.page.limit !== undefined) {
      if (
        typeof value.page.limit !== "number"
        || !Number.isSafeInteger(value.page.limit)
        || value.page.limit < 1
        || value.page.limit > MAX_PAGE_SIZE
      ) return fail("INVALID_QUERY", "query.page.limit");
      pageSize = value.page.limit;
    }
    if (value.page.cursor !== undefined) {
      if (
        !validText(value.page.cursor, MAX_CURSOR_LENGTH)
      ) return fail("INVALID_CURSOR", "query.page.cursor");
      cursor = value.page.cursor;
    }
  }
  return {
    dimension,
    dimensionKey,
    costBasis,
    filters,
    filtersApplied: filterCount(filters),
    pageSize,
    cursor,
    signature: querySignature(dimension, dimensionKey, costBasis, filters),
  };
}

function normalizeEvidence(
  value: unknown,
): FinopsBillingProjectionEvidenceInput | FinopsBillingProjectionResult {
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => ![
      "sourceEvidenceId",
      "manifestSha256",
      "sourceUpdatedAtIso",
      "observedAtIso",
      "committedAtIso",
      "evaluatedAtIso",
      "reconciledRowCount",
      "staleAfterSeconds",
    ].includes(key))
    || !validText(value.sourceEvidenceId, 1_024)
    || typeof value.manifestSha256 !== "string"
    || !SHA256.test(value.manifestSha256)
    || (
      value.sourceUpdatedAtIso !== null
      && !validIso(value.sourceUpdatedAtIso)
    )
    || !validIso(value.observedAtIso)
    || !validIso(value.committedAtIso)
    || !validIso(value.evaluatedAtIso)
    || !safeCount(value.reconciledRowCount)
    || (
      value.staleAfterSeconds !== undefined
      && (
        !safeCount(value.staleAfterSeconds)
        || value.staleAfterSeconds === 0
        || value.staleAfterSeconds > MAX_STALE_AFTER_SECONDS
      )
    )
  ) return fail("INVALID_EVIDENCE", "evidence");
  return {
    sourceEvidenceId: value.sourceEvidenceId,
    manifestSha256: value.manifestSha256,
    sourceUpdatedAtIso: value.sourceUpdatedAtIso,
    observedAtIso: value.observedAtIso,
    committedAtIso: value.committedAtIso,
    evaluatedAtIso: value.evaluatedAtIso,
    reconciledRowCount: value.reconciledRowCount,
    ...(value.staleAfterSeconds === undefined
      ? {}
      : { staleAfterSeconds: value.staleAfterSeconds }),
  };
}

function validMap(value: unknown): value is Readonly<Record<string, string>> {
  if (!isRecord(value) || Object.keys(value).length > 2_048) return false;
  return Object.entries(value).every(([key, entry]) =>
    validText(key, 256) && validText(entry, 1_024));
}

function costValue(
  line: CanonicalCurLine,
  basis: FinopsCostBasis,
): string | null {
  switch (basis) {
    case "unblended":
      return line.amountMicros;
    case "net":
      return line.netUnblendedCostMicros;
    case "amortized":
      return line.amortizedMicros;
    case "list":
      return line.listCostMicros;
    case "contracted":
      return line.contractedCostMicros;
    case "public":
      return line.publicOnDemandCostMicros;
  }
}

function validCanonicalLine(line: unknown): line is CanonicalCurLine {
  if (
    !isRecord(line)
    || !validText(line.lineItemId, 4_096)
    || !validText(line.usageAccountId, 256)
    || !validText(line.service, 1_024)
    || !validText(line.chargeCategory, 512)
    || typeof line.chargeKind !== "string"
    || !CHARGE_KINDS.has(line.chargeKind as CurChargeKind)
    || typeof line.currency !== "string"
    || !FINOPS_RECONCILIATION_CURRENCIES.has(
      line.currency as (typeof FINOPS_RECONCILIATION_CURRENCIES extends Set<infer T> ? T : never),
    )
    || !validIso(line.usageStartIso)
    || !SOURCE_FORMATS.has(String(line.sourceFormat))
    || !SOURCE_VERSIONS.has(String(line.sourceVersion))
    || !validMap(line.tags)
    || !validMap(line.costCategories)
  ) return false;
  for (const basis of FINOPS_COST_BASES) {
    const amount = costValue(line as unknown as CanonicalCurLine, basis);
    if (amount !== null && !INTEGER_MICROS.test(amount)) return false;
  }
  return line.usageAmountMicros === null
    || (
      typeof line.usageAmountMicros === "string"
      && INTEGER_MICROS.test(line.usageAmountMicros)
      && (
        line.usageUnit === null
        || validText(line.usageUnit, 128)
      )
    );
}

function matches(values: readonly string[], candidate: string | null): boolean {
  return values.length === 0 || (candidate !== null && values.includes(candidate));
}

function rowMatches(
  line: CanonicalCurLine,
  filters: NormalizedFilters,
): boolean {
  const day = new Date(line.usageStartIso).toISOString().slice(0, 10);
  return matches(filters.currencies, line.currency)
    && matches(filters.accountIds, line.usageAccountId)
    && matches(filters.services, line.service)
    && matches(filters.regions, line.region)
    && matches(filters.resourceIds, line.resourceId)
    && matches(filters.chargeKinds, line.chargeKind)
    && matches(filters.chargeCategories, line.chargeCategory)
    && matches(filters.commitmentIds, line.commitmentId)
    && matches(filters.invoiceIds, line.invoiceId)
    && matches(filters.legalEntities, line.legalEntity)
    && matches(filters.billingEntities, line.billingEntity)
    && filters.tags.every(({ key, value }) => line.tags[key] === value)
    && filters.costCategories.every(({ key, value }) =>
      line.costCategories[key] === value)
    && (filters.fromDayInclusive === null || day >= filters.fromDayInclusive)
    && (filters.toDayExclusive === null || day < filters.toDayExclusive);
}

function isoHour(value: string): string {
  return `${new Date(value).toISOString().slice(0, 13)}:00:00.000Z`;
}

function dimensionValues(
  line: CanonicalCurLine,
  dimension: FinopsProjectionDimension,
  key: string | null,
): Readonly<Record<string, string | null>> {
  switch (dimension) {
    case "hourly":
      return { hour: isoHour(line.usageStartIso) };
    case "daily":
      return { day: new Date(line.usageStartIso).toISOString().slice(0, 10) };
    case "monthly":
      return { month: new Date(line.usageStartIso).toISOString().slice(0, 7) };
    case "account":
      return {
        accountId: line.usageAccountId,
        accountName: line.usageAccountName,
      };
    case "service":
      return {
        service: line.service,
        productCode: line.productCode,
        productName: line.productName,
      };
    case "region":
      return { region: line.region, availabilityZone: line.availabilityZone };
    case "resource":
      return {
        resourceId: line.resourceId,
        resourceName: line.resourceName,
        resourceType: line.resourceType,
      };
    case "charge_kind":
      return { chargeKind: line.chargeKind };
    case "charge_category":
      return { chargeCategory: line.chargeCategory };
    case "commitment":
      return {
        commitmentType: line.commitmentType,
        commitmentId: line.commitmentId,
        commitmentName: line.commitmentName,
        commitmentCategory: line.commitmentCategory,
        commitmentStatus: line.commitmentStatus,
        commitmentPurchaseOption: line.commitmentPurchaseOption,
      };
    case "invoice":
      return {
        invoiceId: line.invoiceId,
        invoiceIssuerId: line.invoiceIssuerId,
        invoiceIssuerName: line.invoiceIssuerName,
      };
    case "legal_entity":
      return { legalEntity: line.legalEntity };
    case "billing_entity":
      return { billingEntity: line.billingEntity };
    case "tag":
      return { tagKey: key, tagValue: key === null ? null : line.tags[key] ?? null };
    case "cost_category":
      return {
        costCategoryKey: key,
        costCategoryValue: key === null ? null : line.costCategories[key] ?? null,
      };
  }
}

function emptyCosts(): Record<FinopsCostBasis, MutableCost> {
  return {
    unblended: { total: BigInt(0), contributingRowCount: 0 },
    net: { total: BigInt(0), contributingRowCount: 0 },
    amortized: { total: BigInt(0), contributingRowCount: 0 },
    list: { total: BigInt(0), contributingRowCount: 0 },
    contracted: { total: BigInt(0), contributingRowCount: 0 },
    public: { total: BigInt(0), contributingRowCount: 0 },
  };
}

function coverage(contributing: number, total: number): FinopsProjectionCostSummary["coverage"] {
  if (contributing === 0) return "unavailable";
  return contributing === total ? "complete" : "partial";
}

function materializeBucket(
  bucket: MutableBucket,
  dimension: FinopsProjectionDimension,
  selectedCostBasis: FinopsCostBasis,
): FinopsBillingProjectionBucket {
  const costs = FINOPS_COST_BASES.map((basis): FinopsProjectionCostSummary => {
    const summary = bucket.costs[basis];
    return {
      basis,
      totalMicros: summary.contributingRowCount === 0
        ? null
        : summary.total.toString(),
      contributingRowCount: summary.contributingRowCount,
      missingRowCount: bucket.rowCount - summary.contributingRowCount,
      coverage: coverage(summary.contributingRowCount, bucket.rowCount),
    };
  });
  const selected = costs.find(({ basis }) => basis === selectedCostBasis);
  const unblended = bucket.costs.unblended;
  const amortized = bucket.costs.amortized;
  const usage = [...bucket.usage.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([unitKey, summary]) => ({
      unit: unitKey === "\0" ? null : unitKey,
      quantityMicros: summary.total.toString(),
      rowCount: summary.rowCount,
    }));
  return {
    currency: bucket.currency,
    dimension,
    dimensionValues: bucket.dimensionValues,
    rowCount: bucket.rowCount,
    selectedCostBasis,
    selectedTotalMicros: selected?.totalMicros ?? null,
    costs,
    amortizedTrueUpMicros:
      unblended.contributingRowCount === bucket.rowCount
      && amortized.contributingRowCount === bucket.rowCount
        ? (amortized.total - unblended.total).toString()
        : null,
    usage,
    usageQuantityRowCount: bucket.usageQuantityRowCount,
    missingUsageQuantityRowCount: bucket.rowCount - bucket.usageQuantityRowCount,
    mixedUsageUnits: usage.length > 1,
  };
}

function availabilityState(
  availableRows: number,
  totalRows: number,
): "complete" | "partial" | "unavailable" {
  if (availableRows === 0 || totalRows === 0) return "unavailable";
  return availableRows === totalRows ? "complete" : "partial";
}

function isHourlyDetail(line: CanonicalCurLine): boolean {
  if (line.usageEndIso === null || !validIso(line.usageEndIso)) return false;
  const start = Date.parse(line.usageStartIso);
  const end = Date.parse(line.usageEndIso);
  return end > start && end - start <= 60 * 60 * 1_000;
}

function freshness(
  evidence: FinopsBillingProjectionEvidenceInput,
): FinopsProjectionFreshness {
  const staleAfterSeconds =
    evidence.staleAfterSeconds ?? DEFAULT_STALE_AFTER_SECONDS;
  if (evidence.sourceUpdatedAtIso === null) {
    return {
      status: "unknown",
      sourceUpdatedAtIso: null,
      evaluatedAtIso: evidence.evaluatedAtIso,
      ageSeconds: null,
      staleAfterSeconds,
    };
  }
  const ageSeconds = Math.floor(
    (Date.parse(evidence.evaluatedAtIso) - Date.parse(evidence.sourceUpdatedAtIso))
    / 1_000,
  );
  return {
    status: ageSeconds < 0
      ? "future"
      : ageSeconds <= staleAfterSeconds
        ? "fresh"
        : "stale",
    sourceUpdatedAtIso: evidence.sourceUpdatedAtIso,
    evaluatedAtIso: evidence.evaluatedAtIso,
    ageSeconds,
    staleAfterSeconds,
  };
}

function encodeCursor(signature: string, afterKey: string): string {
  return encodeURIComponent(JSON.stringify({
    version: 1,
    signature,
    afterKey,
  }));
}

function decodeCursor(
  cursor: string,
  signature: string,
): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeURIComponent(cursor)) as unknown;
  } catch {
    return null;
  }
  if (
    !isRecord(parsed)
    || Object.keys(parsed).sort().join(",") !== "afterKey,signature,version"
    || parsed.version !== 1
    || parsed.signature !== signature
    || !validText(parsed.afterKey, 8_192)
  ) return null;
  return parsed.afterKey;
}

/**
 * Build one bounded dimension projection from tenant-scoped, active-generation
 * canonical rows. The function never mutates input and never accesses storage.
 */
export function buildFinopsBillingProjection(
  input: FinopsBillingProjectionInput,
): FinopsBillingProjectionResult {
  if (!isRecord(input) || !validScope(input.scope)) {
    return fail("INVALID_SCOPE", "scope");
  }
  const evidence = normalizeEvidence(input.evidence);
  if ("ok" in evidence) return evidence;
  const query = normalizeQuery(input.query);
  if ("ok" in query) return query;
  if (!Array.isArray(input.rows)) return fail("INVALID_CANONICAL_ROW", "rows");
  if (input.rows.length > MAX_ACTIVE_ROWS) {
    return fail("ACTIVE_ROW_LIMIT_EXCEEDED", "rows");
  }
  if (input.rows.length !== evidence.reconciledRowCount) {
    return fail("EVIDENCE_ROW_COUNT_MISMATCH", "evidence.reconciledRowCount");
  }

  for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
    const row = input.rows[rowIndex];
    if (!isRecord(row) || !validScope(row) || !sameScope(input.scope, row)) {
      return fail("ROW_SCOPE_MISMATCH", `rows[${rowIndex}].scope`, rowIndex);
    }
    if (!validCanonicalLine(row.line)) {
      const code = isRecord(row.line)
        && typeof row.line.currency === "string"
        && !FINOPS_RECONCILIATION_CURRENCIES.has(
          row.line.currency as (typeof FINOPS_RECONCILIATION_CURRENCIES extends Set<infer T> ? T : never),
        )
        ? "UNKNOWN_CURRENCY"
        : "INVALID_CANONICAL_ROW";
      return fail(code, `rows[${rowIndex}].line`, rowIndex);
    }
  }

  const matchedRows = input.rows.filter(({ line }) =>
    rowMatches(line, query.filters));
  const sourceCounts = new Map<string, {
    readonly sourceFormat: CanonicalCurLine["sourceFormat"];
    readonly sourceVersion: CanonicalCurLine["sourceVersion"];
    rowCount: number;
  }>();
  for (const { line } of input.rows) {
    const key = `${line.sourceFormat}\0${line.sourceVersion}`;
    const current = sourceCounts.get(key) ?? {
      sourceFormat: line.sourceFormat,
      sourceVersion: line.sourceVersion,
      rowCount: 0,
    };
    current.rowCount += 1;
    sourceCounts.set(key, current);
  }

  const grouped = new Map<string, MutableBucket>();
  for (const { line } of matchedRows) {
    const values = dimensionValues(line, query.dimension, query.dimensionKey);
    const key = JSON.stringify([line.currency, Object.entries(values)]);
    let bucket = grouped.get(key);
    if (bucket === undefined) {
      if (grouped.size >= MAX_BUCKETS) {
        return fail("BUCKET_LIMIT_EXCEEDED", "buckets");
      }
      bucket = {
        currency: line.currency,
        dimensionValues: values,
        rowCount: 0,
        costs: emptyCosts(),
        usage: new Map(),
        usageQuantityRowCount: 0,
      };
      grouped.set(key, bucket);
    }
    bucket.rowCount += 1;
    for (const basis of FINOPS_COST_BASES) {
      const amount = costValue(line, basis);
      if (amount === null) continue;
      bucket.costs[basis].total += BigInt(amount);
      bucket.costs[basis].contributingRowCount += 1;
    }
    if (line.usageAmountMicros !== null) {
      const unitKey = line.usageUnit ?? "\0";
      const usage = bucket.usage.get(unitKey) ?? {
        total: BigInt(0),
        rowCount: 0,
      };
      usage.total += BigInt(line.usageAmountMicros);
      usage.rowCount += 1;
      bucket.usage.set(unitKey, usage);
      bucket.usageQuantityRowCount += 1;
    }
  }

  const sorted = [...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right));
  let startIndex = 0;
  if (query.cursor !== null) {
    const afterKey = decodeCursor(query.cursor, query.signature);
    if (afterKey === null) return fail("INVALID_CURSOR", "query.page.cursor");
    const foundIndex = sorted.findIndex(([key]) => key === afterKey);
    if (foundIndex < 0) return fail("INVALID_CURSOR", "query.page.cursor");
    startIndex = foundIndex + 1;
  }
  const pageEntries = sorted.slice(startIndex, startIndex + query.pageSize);
  const hasNext = startIndex + query.pageSize < sorted.length;
  const nextCursor = hasNext && pageEntries.length > 0
    ? encodeCursor(query.signature, pageEntries[pageEntries.length - 1][0])
    : null;

  const resourceRowCount = matchedRows.filter(({ line }) =>
    line.resourceId !== null).length;
  const hourlyRowCount = matchedRows.filter(({ line }) =>
    isHourlyDetail(line)).length;
  const projectionEvidence: FinopsBillingProjectionEvidence = {
    organizationId: input.scope.organizationId,
    customerId: input.scope.customerId,
    connectionId: input.scope.connectionId,
    exportName: input.scope.exportName,
    billingPeriod: input.scope.billingPeriod,
    generationId: input.scope.generationId,
    sourceEvidenceId: evidence.sourceEvidenceId,
    manifestSha256: evidence.manifestSha256,
    observedAtIso: evidence.observedAtIso,
    committedAtIso: evidence.committedAtIso,
    activeRowCount: input.rows.length,
    matchedRowCount: matchedRows.length,
    sources: [...sourceCounts.values()]
      .sort((left, right) =>
        compareText(left.sourceFormat, right.sourceFormat)
        || compareText(left.sourceVersion, right.sourceVersion)),
    freshness: freshness(evidence),
    availability: {
      resource: availabilityState(resourceRowCount, matchedRows.length),
      resourceRowCount,
      hourly: availabilityState(hourlyRowCount, matchedRows.length),
      hourlyRowCount,
    },
  };

  return {
    ok: true,
    schema: "sutra.finops-billing-projection.v1",
    evidence: projectionEvidence,
    query: {
      dimension: query.dimension,
      dimensionKey: query.dimensionKey,
      costBasis: query.costBasis,
      filtersApplied: query.filtersApplied,
      pageSize: query.pageSize,
    },
    buckets: pageEntries.map(([, bucket]) =>
      materializeBucket(bucket, query.dimension, query.costBasis)),
    totalBuckets: sorted.length,
    nextCursor,
    failures: [],
  };
}
