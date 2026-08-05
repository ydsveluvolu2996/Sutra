/**
 * Evidence-honest FOCUS 1.2 projection over persisted canonical billing rows.
 *
 * This is deliberately a report projection, not a FOCUS conformance claim.
 * Only active datasets whose persisted evidence and every canonical row identify
 * FOCUS 1.2 are accepted. Signed money is summed with bigint, currencies are
 * never combined, and missing optional columns remain visible as coverage gaps.
 */
import type {
  FinopsActiveBillingDataset,
  FinopsActiveBillingScope,
} from "../db/finops-active-billing-query-repository.ts";
import type { CanonicalCurLine } from "./finops-cur.ts";
import { buildProviderNeutralFocusReport, type FinopsFocusNeutralReport, type FinopsFocusTagTaxonomyPolicy } from "./finops-focus-neutral.ts";
import { FINOPS_RECONCILIATION_CURRENCIES } from "./finops-reconciliation.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const GENERATION = /^fbg_[a-f0-9]{64}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const INTEGER_MICROS = /^-?(?:0|[1-9]\d{0,127})$/u;
const MAX_TEXT_LENGTH = 4_096;

export const FINOPS_FOCUS_DASHBOARD_BOUNDS = Object.freeze({
  maximumPeriods: 36,
  maximumTotalRows: 250_000,
  dimensionValueLimit: 25,
  monthlyDimensionValueLimit: 15,
  dailyTrendBucketsPerCurrency: 90,
  filterValueLimit: 500,
  drilldownLimit: 100,
});

export const FINOPS_FOCUS_DIMENSIONS = [
  "billing_account",
  "sub_account",
  "provider",
  "publisher",
  "service",
  "service_category",
  "region",
  "charge_category",
  "invoice",
  "resource",
  "resource_type",
] as const;

export type FinopsFocusDimension = typeof FINOPS_FOCUS_DIMENSIONS[number];
export type FinopsFocusCoverage = "complete" | "partial" | "unavailable";

export interface FinopsFocusDashboardInput {
  readonly scope: FinopsActiveBillingScope;
  readonly datasets: readonly FinopsActiveBillingDataset[];
  readonly tagTaxonomy?: FinopsFocusTagTaxonomyPolicy | null;
  readonly filters?: FinopsFocusDashboardFilters | null;
}

export interface FinopsFocusDashboardFilters {
  readonly billingAccount: string | null;
  readonly subAccount: string | null;
  readonly provider: string | null;
  readonly publisher: string | null;
  readonly chargeCategory: string | null;
}

export type FinopsFocusDashboardFailureCode =
  | "INVALID_INPUT"
  | "PERIOD_LIMIT_EXCEEDED"
  | "ROW_LIMIT_EXCEEDED"
  | "SOURCE_SUBSTITUTION"
  | "SCOPE_MISMATCH"
  | "DUPLICATE_PERIOD"
  | "EVIDENCE_ROW_COUNT_MISMATCH"
  | "INVALID_CANONICAL_ROW"
  | "UNKNOWN_CURRENCY"
  | "DUPLICATE_LINE_ITEM_ID";

export interface FinopsFocusDashboardFailure {
  readonly code: FinopsFocusDashboardFailureCode;
  readonly field: string;
  readonly datasetIndex?: number;
  readonly rowIndex?: number;
}

export interface FinopsFocusCostCoverage {
  /** Exact total only when every row provides this cost field. */
  readonly totalMicros: string | null;
  /** Exact sum of the rows that do provide the field. */
  readonly observedMicros: string;
  readonly presentLineCount: number;
  readonly missingLineCount: number;
  readonly coverage: FinopsFocusCoverage;
}

export interface FinopsFocusCostSummary {
  readonly billedCostMicros: string;
  readonly effectiveCost: FinopsFocusCostCoverage;
  readonly contractedCost: FinopsFocusCostCoverage;
  readonly listCost: FinopsFocusCostCoverage;
}

export interface FinopsFocusDimensionEntry extends FinopsFocusCostSummary {
  readonly rank: number;
  readonly value: string | null;
  readonly lineCount: number;
}

export interface FinopsFocusDimensionSummary {
  readonly dimension: FinopsFocusDimension;
  readonly distinctValueCount: number;
  readonly missingLineCount: number;
  readonly entries: readonly FinopsFocusDimensionEntry[];
  readonly truncated: boolean;
}

export interface FinopsFocusSchemaFieldCoverage {
  readonly field: string;
  readonly requirement: "projection_required" | "optional";
  readonly presentLineCount: number;
  readonly missingLineCount: number;
  readonly coverageBasisPoints: string | null;
  readonly coverage: FinopsFocusCoverage;
}

export interface FinopsFocusCurrencyReport extends FinopsFocusCostSummary {
  readonly currency: string;
  readonly lineCount: number;
  readonly dimensions: readonly FinopsFocusDimensionSummary[];
}

export interface FinopsFocusTrendBucket extends FinopsFocusCostSummary {
  readonly period: string;
  readonly currency: string;
  readonly lineCount: number;
}

export interface FinopsFocusDailyTrendBucket extends FinopsFocusCostSummary {
  readonly day: string;
  readonly currency: string;
  readonly lineCount: number;
}

export interface FinopsFocusMonthlyDimensionBucket {
  readonly period: string;
  readonly currency: string;
  readonly dimension: FinopsFocusDimension;
  readonly entries: readonly FinopsFocusDimensionEntry[];
  readonly truncated: boolean;
}

export interface FinopsFocusFilterOption {
  readonly values: readonly string[];
  readonly missingLineCount: number;
  readonly truncated: boolean;
}

export interface FinopsFocusDrilldownRow {
  readonly period: string;
  readonly lineItemId: string;
  readonly currency: string;
  readonly billedCostMicros: string;
  readonly effectiveCostMicros: string | null;
  readonly billingAccountId: string | null;
  readonly subAccountId: string;
  readonly provider: string | null;
  readonly service: string;
  readonly region: string | null;
  readonly chargeCategory: string;
  readonly resourceId: string | null;
}

export type FinopsFocusDashboardResult =
  | {
      readonly ok: false;
      readonly schema: "sutra.finops-focus-dashboard.v1";
      readonly failures: readonly FinopsFocusDashboardFailure[];
    }
  | {
      readonly ok: true;
      readonly schema: "sutra.finops-focus-dashboard.v1";
      readonly standard: "FOCUS_1_2";
      readonly conformanceClaim: false;
      readonly evidence: {
        readonly organizationId: string;
        readonly customerId: string;
        readonly connectionId: string;
        readonly exportName: string;
        readonly periods: readonly {
          readonly period: string;
          readonly generationId: string;
          readonly manifestSha256: string;
          readonly sourceTable: string;
          readonly committedAtIso: string;
          readonly acceptedRows: number;
          readonly rejectedRows: number;
        }[];
      };
      readonly quality: {
        readonly sourceFormat: "focus";
        readonly sourceVersion: "1.2";
        readonly schemaCoverageBasis: "canonical_non_null_field_presence";
        readonly acceptedLineCount: number;
        readonly selectedLineCount: number;
        readonly rejectedSourceRowCount: number;
        readonly ingestionCoverage: "complete" | "partial";
        readonly rejectionRatio: {
          readonly rejectedRowsNumerator: string;
          readonly observedRowsDenominator: string;
        };
        readonly fields: readonly FinopsFocusSchemaFieldCoverage[];
      };
      readonly currencies: readonly FinopsFocusCurrencyReport[];
      readonly trends: readonly FinopsFocusTrendBucket[];
      readonly dailyTrends: readonly FinopsFocusDailyTrendBucket[];
      readonly monthlyDimensions: readonly FinopsFocusMonthlyDimensionBucket[];
      readonly selection: {
        readonly filters: FinopsFocusDashboardFilters;
        readonly sourceAcceptedLineCount: number;
        readonly matchedLineCount: number;
        readonly filterOptions: {
          readonly billingAccounts: FinopsFocusFilterOption;
          readonly subAccounts: FinopsFocusFilterOption;
          readonly providers: FinopsFocusFilterOption;
          readonly publishers: FinopsFocusFilterOption;
          readonly chargeCategories: FinopsFocusFilterOption;
        };
      };
      readonly drilldowns: {
        readonly totalRows: number;
        readonly returnedRows: number;
        readonly truncated: boolean;
        readonly rows: readonly FinopsFocusDrilldownRow[];
      };
      readonly neutral: FinopsFocusNeutralReport;
      readonly invariants: readonly [
        "only_active_canonical_focus_1_2_is_accepted",
        "currencies_are_never_combined",
        "money_uses_signed_bigint_micros",
        "missing_fields_are_not_substituted",
      ];
      readonly disclaimer: string;
    };

interface MutableCost {
  billed: bigint;
  effectiveObserved: bigint;
  contractedObserved: bigint;
  listObserved: bigint;
  lineCount: number;
  effectivePresent: number;
  contractedPresent: number;
  listPresent: number;
}

interface MutableDimension extends MutableCost {
  readonly value: string | null;
}

interface MutableCurrency extends MutableCost {
  readonly currency: string;
  readonly dimensions: Map<FinopsFocusDimension, Map<string, MutableDimension>>;
}

const FIELD_COVERAGE: readonly {
  readonly field: string;
  readonly requirement: "projection_required" | "optional";
  readonly value: (line: CanonicalCurLine) => unknown;
}[] = [
  { field: "BillingAccountId", requirement: "projection_required", value: (line) => line.payerAccountId },
  { field: "SubAccountId", requirement: "projection_required", value: (line) => line.usageAccountId },
  { field: "ServiceName", requirement: "projection_required", value: (line) => line.service },
  { field: "ChargeCategory", requirement: "projection_required", value: (line) => line.chargeCategory },
  { field: "ChargePeriodStart", requirement: "projection_required", value: (line) => line.usageStartIso },
  { field: "BilledCost", requirement: "projection_required", value: (line) => line.amountMicros },
  { field: "BillingCurrency", requirement: "projection_required", value: (line) => line.currency },
  { field: "EffectiveCost", requirement: "optional", value: (line) => line.amortizedMicros },
  { field: "ListCost", requirement: "optional", value: (line) => line.listCostMicros },
  { field: "ContractedCost", requirement: "optional", value: (line) => line.contractedCostMicros },
  { field: "ChargeClass", requirement: "optional", value: (line) => line.chargeClass },
  { field: "Tags", requirement: "optional", value: (line) => Object.keys(line.tags).length === 0 ? null : line.tags },
  { field: "ProviderName", requirement: "optional", value: (line) => line.billingEntity },
  { field: "ServiceCategory", requirement: "optional", value: (line) => line.serviceCategory },
  { field: "RegionId", requirement: "optional", value: (line) => line.region },
  { field: "ResourceId", requirement: "optional", value: (line) => line.resourceId },
  { field: "ResourceType", requirement: "optional", value: (line) => line.resourceType },
  { field: "InvoiceId", requirement: "optional", value: (line) => line.invoiceId },
] as const;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function present(value: unknown): boolean {
  return typeof value === "string" ? value.trim().length > 0 : value !== null && value !== undefined;
}

function validText(value: unknown, nullable = false): boolean {
  return (nullable && value === null)
    || (typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT_LENGTH && !value.includes("\0"));
}

function coverage(presentLines: number, lineCount: number): FinopsFocusCoverage {
  if (presentLines === 0) return "unavailable";
  return presentLines === lineCount ? "complete" : "partial";
}

function basisPoints(presentLines: number, lineCount: number): string | null {
  return lineCount === 0
    ? null
    : ((BigInt(presentLines) * BigInt(10_000)) / BigInt(lineCount)).toString();
}

function emptyCost(): MutableCost {
  return {
    billed: BigInt(0),
    effectiveObserved: BigInt(0),
    contractedObserved: BigInt(0),
    listObserved: BigInt(0),
    lineCount: 0,
    effectivePresent: 0,
    contractedPresent: 0,
    listPresent: 0,
  };
}

function addCost(target: MutableCost, line: CanonicalCurLine): void {
  target.billed += BigInt(line.amountMicros);
  target.lineCount += 1;
  if (line.amortizedMicros !== null) {
    target.effectiveObserved += BigInt(line.amortizedMicros);
    target.effectivePresent += 1;
  }
  if (line.contractedCostMicros !== null) {
    target.contractedObserved += BigInt(line.contractedCostMicros);
    target.contractedPresent += 1;
  }
  if (line.listCostMicros !== null) {
    target.listObserved += BigInt(line.listCostMicros);
    target.listPresent += 1;
  }
}

function costSummary(value: MutableCost): FinopsFocusCostSummary {
  const costCoverage = (observed: bigint, presentLines: number): FinopsFocusCostCoverage => {
    const missingLineCount = value.lineCount - presentLines;
    return {
      totalMicros: missingLineCount === 0 ? observed.toString() : null,
      observedMicros: observed.toString(),
      presentLineCount: presentLines,
      missingLineCount,
      coverage: coverage(presentLines, value.lineCount),
    };
  };
  return {
    billedCostMicros: value.billed.toString(),
    effectiveCost: costCoverage(value.effectiveObserved, value.effectivePresent),
    contractedCost: costCoverage(value.contractedObserved, value.contractedPresent),
    listCost: costCoverage(value.listObserved, value.listPresent),
  };
}

function dimensionValue(
  dimension: FinopsFocusDimension,
  line: CanonicalCurLine,
): string | null {
  switch (dimension) {
    case "billing_account": return line.payerAccountId;
    case "sub_account": return line.usageAccountId;
    case "provider": return line.billingEntity;
    case "publisher": return line.legalEntity;
    case "service": return line.service;
    case "service_category": return line.serviceCategory;
    case "region": return line.region;
    case "charge_category": return line.chargeCategory;
    case "invoice": return line.invoiceId;
    case "resource": return line.resourceId;
    case "resource_type": return line.resourceType;
  }
}

function absolute(value: bigint): bigint {
  return value < BigInt(0) ? -value : value;
}

function compareMutableCost(
  left: MutableDimension,
  right: MutableDimension,
): number {
  const leftAbsolute = absolute(left.billed);
  const rightAbsolute = absolute(right.billed);
  if (leftAbsolute !== rightAbsolute) return leftAbsolute > rightAbsolute ? -1 : 1;
  return (left.value ?? "").localeCompare(right.value ?? "");
}

function sameScope(
  owner: FinopsActiveBillingScope,
  dataset: FinopsActiveBillingDataset,
): boolean {
  return dataset.scope.organizationId === owner.orgId
    && dataset.scope.customerId === owner.customerId
    && dataset.scope.connectionId === owner.connectionId;
}

function sameRowScope(
  dataset: FinopsActiveBillingDataset,
  row: FinopsActiveBillingDataset["rows"][number],
): boolean {
  const scope = dataset.scope;
  return row.organizationId === scope.organizationId
    && row.customerId === scope.customerId
    && row.connectionId === scope.connectionId
    && row.exportName === scope.exportName
    && row.billingPeriod === scope.billingPeriod
    && row.generationId === scope.generationId;
}

function validCanonicalFocusLine(line: unknown): line is CanonicalCurLine {
  if (!isRecord(line)) return false;
  return line.sourceFormat === "focus"
    && line.sourceVersion === "1.2"
    && validText(line.lineItemId)
    && validText(line.usageAccountId)
    && validText(line.service)
    && validText(line.chargeCategory)
    && validText(line.usageStartIso)
    && Number.isFinite(Date.parse(line.usageStartIso as string))
    && typeof line.amountMicros === "string"
    && INTEGER_MICROS.test(line.amountMicros)
    && typeof line.currency === "string"
    && (
      line.amortizedMicros === null
      || (typeof line.amortizedMicros === "string" && INTEGER_MICROS.test(line.amortizedMicros))
    )
    && (
      line.contractedCostMicros === null
      || (typeof line.contractedCostMicros === "string" && INTEGER_MICROS.test(line.contractedCostMicros))
    )
    && (
      line.listCostMicros === null
      || (typeof line.listCostMicros === "string" && INTEGER_MICROS.test(line.listCostMicros))
    )
    && validText(line.payerAccountId, true)
    && validText(line.billingEntity, true)
    && validText(line.legalEntity, true)
    && validText(line.serviceCategory, true)
    && validText(line.region, true)
    && validText(line.resourceId, true)
    && validText(line.resourceType, true)
    && validText(line.invoiceId, true);
}

const EMPTY_FILTERS: FinopsFocusDashboardFilters = Object.freeze({
  billingAccount: null,
  subAccount: null,
  provider: null,
  publisher: null,
  chargeCategory: null,
});

function dashboardFilters(value: unknown): FinopsFocusDashboardFilters | null {
  if (value === undefined || value === null) return EMPTY_FILTERS;
  if (!isRecord(value)) return null;
  const expected = Object.keys(EMPTY_FILTERS).sort();
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify(expected)) return null;
  const parsed = { ...value } as unknown as FinopsFocusDashboardFilters;
  return Object.values(parsed).every((entry) => entry === null || validText(entry)) ? parsed : null;
}

function matchesFilters(line: CanonicalCurLine, filters: FinopsFocusDashboardFilters): boolean {
  return (filters.billingAccount === null || line.payerAccountId === filters.billingAccount)
    && (filters.subAccount === null || line.usageAccountId === filters.subAccount)
    && (filters.provider === null || line.billingEntity === filters.provider)
    && (filters.publisher === null || line.legalEntity === filters.publisher)
    && (filters.chargeCategory === null || line.chargeCategory === filters.chargeCategory);
}

function filterOption(lines: readonly CanonicalCurLine[], value: (line: CanonicalCurLine) => string | null): FinopsFocusFilterOption {
  const supplied = new Set<string>();
  let missingLineCount = 0;
  for (const line of lines) {
    const item = value(line);
    if (item === null) missingLineCount += 1;
    else supplied.add(item);
  }
  const all = [...supplied].sort();
  return {
    values: all.slice(0, FINOPS_FOCUS_DASHBOARD_BOUNDS.filterValueLimit),
    missingLineCount,
    truncated: all.length > FINOPS_FOCUS_DASHBOARD_BOUNDS.filterValueLimit,
  };
}

function fail(
  code: FinopsFocusDashboardFailureCode,
  field: string,
  datasetIndex?: number,
  rowIndex?: number,
): FinopsFocusDashboardResult {
  return {
    ok: false,
    schema: "sutra.finops-focus-dashboard.v1",
    failures: [{
      code,
      field,
      ...(datasetIndex === undefined ? {} : { datasetIndex }),
      ...(rowIndex === undefined ? {} : { rowIndex }),
    }],
  };
}

/** Build a bounded report from one active export's canonical FOCUS 1.2 history. */
export function buildFinopsFocusDashboard(
  input: FinopsFocusDashboardInput,
): FinopsFocusDashboardResult {
  const rawInput: unknown = input;
  if (
    !isRecord(rawInput)
    || !isRecord(input.scope)
    || !IDENTIFIER.test(input.scope.orgId)
    || !IDENTIFIER.test(input.scope.customerId)
    || !IDENTIFIER.test(input.scope.connectionId)
    || !Array.isArray(input.datasets)
    || input.datasets.length === 0
  ) return fail("INVALID_INPUT", "input");
  const selectedFilters = dashboardFilters(input.filters);
  if (selectedFilters === null) return fail("INVALID_INPUT", "filters");
  if (input.datasets.length > FINOPS_FOCUS_DASHBOARD_BOUNDS.maximumPeriods) {
    return fail("PERIOD_LIMIT_EXCEEDED", "datasets");
  }

  const periods = new Set<string>();
  const identities = new Set<string>();
  const exportName = input.datasets[0]?.scope.exportName;
  let totalRows = 0;
  let rejectedSourceRows = 0;
  for (let datasetIndex = 0; datasetIndex < input.datasets.length; datasetIndex += 1) {
    const dataset = input.datasets[datasetIndex]!;
    if (
      dataset === null
      || typeof dataset !== "object"
      || dataset.scope === null
      || typeof dataset.scope !== "object"
      || dataset.evidence === null
      || typeof dataset.evidence !== "object"
    ) {
      return fail("INVALID_INPUT", `datasets[${datasetIndex}]`, datasetIndex);
    }
    if (
      !sameScope(input.scope, dataset)
      || dataset.scope.exportName !== exportName
      || !PERIOD.test(dataset.scope.billingPeriod)
      || !GENERATION.test(dataset.scope.generationId)
    ) return fail("SCOPE_MISMATCH", `datasets[${datasetIndex}].scope`, datasetIndex);
    if (periods.has(dataset.scope.billingPeriod)) {
      return fail("DUPLICATE_PERIOD", `datasets[${datasetIndex}].scope.billingPeriod`, datasetIndex);
    }
    periods.add(dataset.scope.billingPeriod);
    if (
      dataset.evidence.activeSourceFormat !== "focus"
      || dataset.evidence.activeSourceVersion !== "1.2"
    ) return fail("SOURCE_SUBSTITUTION", `datasets[${datasetIndex}].evidence`, datasetIndex);
    if (
      !SHA256.test(dataset.evidence.activeManifestSha256)
      || !validText(dataset.evidence.activeSourceTable)
      || !Number.isSafeInteger(dataset.evidence.acceptedRows)
      || dataset.evidence.acceptedRows < 0
      || !Number.isSafeInteger(dataset.evidence.rejectedRows)
      || dataset.evidence.rejectedRows < 0
    ) return fail("INVALID_INPUT", `datasets[${datasetIndex}].evidence`, datasetIndex);
    if (!Array.isArray(dataset.rows) || dataset.rows.length !== dataset.evidence.acceptedRows) {
      return fail("EVIDENCE_ROW_COUNT_MISMATCH", `datasets[${datasetIndex}].rows`, datasetIndex);
    }
    totalRows += dataset.rows.length;
    rejectedSourceRows += dataset.evidence.rejectedRows;
    if (
      !Number.isSafeInteger(totalRows)
      || totalRows > FINOPS_FOCUS_DASHBOARD_BOUNDS.maximumTotalRows
    ) return fail("ROW_LIMIT_EXCEEDED", "datasets.rows", datasetIndex);

    for (let rowIndex = 0; rowIndex < dataset.rows.length; rowIndex += 1) {
      const row = dataset.rows[rowIndex]!;
      if (row === null || typeof row !== "object" || !sameRowScope(dataset, row)) {
        return fail("SCOPE_MISMATCH", `datasets[${datasetIndex}].rows[${rowIndex}]`, datasetIndex, rowIndex);
      }
      const rawLine: unknown = row.line;
      if (
        isRecord(rawLine)
        && (rawLine.sourceFormat !== "focus" || rawLine.sourceVersion !== "1.2")
      ) return fail("SOURCE_SUBSTITUTION", `datasets[${datasetIndex}].rows[${rowIndex}].line`, datasetIndex, rowIndex);
      if (!validCanonicalFocusLine(rawLine)) {
        return fail("INVALID_CANONICAL_ROW", `datasets[${datasetIndex}].rows[${rowIndex}].line`, datasetIndex, rowIndex);
      }
      if (!FINOPS_RECONCILIATION_CURRENCIES.has(row.line.currency as never)) {
        return fail("UNKNOWN_CURRENCY", `datasets[${datasetIndex}].rows[${rowIndex}].line.currency`, datasetIndex, rowIndex);
      }
      const identity = `${dataset.scope.billingPeriod}\0${row.line.lineItemId}`;
      if (identities.has(identity)) {
        return fail("DUPLICATE_LINE_ITEM_ID", `datasets[${datasetIndex}].rows[${rowIndex}].line.lineItemId`, datasetIndex, rowIndex);
      }
      identities.add(identity);
    }
  }

  const sortedDatasets = [...input.datasets].sort((left, right) =>
    left.scope.billingPeriod.localeCompare(right.scope.billingPeriod));
  const allRows = sortedDatasets.flatMap((dataset) => dataset.rows);
  const selectedRows = allRows.filter((row) => matchesFilters(row.line, selectedFilters));
  const currencies = new Map<string, MutableCurrency>();
  const trends = new Map<string, MutableCost & { period: string; currency: string }>();
  const dailyTrends = new Map<string, MutableCost & { day: string; currency: string }>();
  const monthlyDimensions = new Map<string, MutableDimension>();

  for (const row of selectedRows) {
    const line = row.line;
    let currency = currencies.get(line.currency);
    if (currency === undefined) {
      currency = {
        currency: line.currency,
        ...emptyCost(),
        dimensions: new Map(),
      };
      currencies.set(line.currency, currency);
    }
    addCost(currency, line);
    for (const dimension of FINOPS_FOCUS_DIMENSIONS) {
      let values = currency.dimensions.get(dimension);
      if (values === undefined) {
        values = new Map();
        currency.dimensions.set(dimension, values);
      }
      const value = dimensionValue(dimension, line);
      const key = value === null ? "\0missing" : `\0value:${value}`;
      let aggregate = values.get(key);
      if (aggregate === undefined) {
        aggregate = { value, ...emptyCost() };
        values.set(key, aggregate);
      }
      addCost(aggregate, line);
    }
    const trendKey = `${row.billingPeriod}\0${line.currency}`;
    let trend = trends.get(trendKey);
    if (trend === undefined) {
      trend = { period: row.billingPeriod, currency: line.currency, ...emptyCost() };
      trends.set(trendKey, trend);
    }
    addCost(trend, line);
    const day = new Date(Date.parse(line.usageStartIso)).toISOString().slice(0, 10);
    const dailyKey = `${day}\0${line.currency}`;
    let dailyTrend = dailyTrends.get(dailyKey);
    if (dailyTrend === undefined) {
      dailyTrend = { day, currency: line.currency, ...emptyCost() };
      dailyTrends.set(dailyKey, dailyTrend);
    }
    addCost(dailyTrend, line);
    for (const dimension of FINOPS_FOCUS_DIMENSIONS) {
      const value = dimensionValue(dimension, line);
      const valueKey = value === null ? "\0missing" : `\0value:${value}`;
      const monthlyKey = `${row.billingPeriod}\0${line.currency}\0${dimension}${valueKey}`;
      let monthly = monthlyDimensions.get(monthlyKey);
      if (monthly === undefined) {
        monthly = { value, ...emptyCost() };
        monthlyDimensions.set(monthlyKey, monthly);
      }
      addCost(monthly, line);
    }
  }

  const currencyReports = [...currencies.values()]
    .sort((left, right) => left.currency.localeCompare(right.currency))
    .map((currency): FinopsFocusCurrencyReport => ({
      currency: currency.currency,
      lineCount: currency.lineCount,
      ...costSummary(currency),
      dimensions: FINOPS_FOCUS_DIMENSIONS.map((dimension): FinopsFocusDimensionSummary => {
        const all = [...(currency.dimensions.get(dimension)?.values() ?? [])]
          .sort(compareMutableCost);
        const entries = all.slice(0, FINOPS_FOCUS_DASHBOARD_BOUNDS.dimensionValueLimit);
        return {
          dimension,
          distinctValueCount: all.filter((entry) => entry.value !== null).length,
          missingLineCount: all.find((entry) => entry.value === null)?.lineCount ?? 0,
          entries: entries.map((entry, index) => ({
            rank: index + 1,
            value: entry.value,
            lineCount: entry.lineCount,
            ...costSummary(entry),
          })),
          truncated: entries.length < all.length,
        };
      }),
    }));

  const sortedDrilldownRows = [...selectedRows].sort((left, right) => {
    const leftAbsolute = absolute(BigInt(left.line.amountMicros));
    const rightAbsolute = absolute(BigInt(right.line.amountMicros));
    if (leftAbsolute !== rightAbsolute) return leftAbsolute > rightAbsolute ? -1 : 1;
    return left.billingPeriod.localeCompare(right.billingPeriod)
      || left.line.currency.localeCompare(right.line.currency)
      || left.line.lineItemId.localeCompare(right.line.lineItemId);
  });
  const drilldownRows = sortedDrilldownRows.slice(
    0,
    FINOPS_FOCUS_DASHBOARD_BOUNDS.drilldownLimit,
  );

  const fieldCoverage = FIELD_COVERAGE.map((field): FinopsFocusSchemaFieldCoverage => {
    const presentLineCount = selectedRows.reduce(
      (count, row) => count + (present(field.value(row.line)) ? 1 : 0),
      0,
    );
    return {
      field: field.field,
      requirement: field.requirement,
      presentLineCount,
      missingLineCount: selectedRows.length - presentLineCount,
      coverageBasisPoints: basisPoints(presentLineCount, selectedRows.length),
      coverage: coverage(presentLineCount, selectedRows.length),
    };
  });
  const neutralSourceId = (dataset: FinopsActiveBillingDataset) => `${input.scope.connectionId}:${dataset.scope.billingPeriod}`;
  const neutralTags = (line: CanonicalCurLine) => { const tags = new Map(Object.entries(line.tags)); for (const [key, value] of Object.entries(line.costCategories)) { const normalized = `aws:cost-category:${key}`; if (!tags.has(normalized)) tags.set(normalized, value); } return [...tags].map(([key, value]) => ({ key, value })); };
  const neutral = buildProviderNeutralFocusReport({
    scope: { orgId: input.scope.orgId, customerId: input.scope.customerId },
    sources: sortedDatasets.map((dataset) => ({ orgId: input.scope.orgId, customerId: input.scope.customerId, sourceId: neutralSourceId(dataset), provider: "AWS", focusVersion: "1.2", datasetName: dataset.evidence.activeSourceTable, generationId: dataset.scope.generationId, contentSha256: dataset.evidence.activeManifestSha256, collectedAt: dataset.evidence.activeCommittedAtIso, dataThroughAt: dataset.evidence.activeSourceUpdatedAtIso ?? dataset.evidence.activeObservedAtIso, normalizedSchema: "sutra.focus-neutral-line.v1" })),
    rows: sortedDatasets.flatMap((dataset) => dataset.rows.filter((row: FinopsActiveBillingDataset["rows"][number]) => matchesFilters(row.line, selectedFilters)).map(({ line }: { readonly line: CanonicalCurLine }) => ({ sourceId: neutralSourceId(dataset), lineId: line.lineItemId, billingPeriod: dataset.scope.billingPeriod, billingCurrency: line.currency, billedCostMicros: line.amountMicros, effectiveCostMicros: line.amortizedMicros, listCostMicros: line.listCostMicros, contractedCostMicros: line.contractedCostMicros, providerName: line.billingEntity ?? "AWS", serviceName: line.service, chargeCategory: line.chargeCategory, chargeClass: line.chargeClass, chargeClassEvidence: "NOT_PROVIDED" as const, tags: neutralTags(line) }))),
    taxonomy: input.tagTaxonomy ?? null,
  });
  const monthlyGroups = new Map<string, { period: string; currency: string; dimension: FinopsFocusDimension; entries: MutableDimension[] }>();
  for (const [key, entry] of monthlyDimensions) {
    const [period, currency, dimension] = key.split("\0");
    if (period === undefined || currency === undefined || dimension === undefined) continue;
    const groupKey = `${period}\0${currency}\0${dimension}`;
    let group = monthlyGroups.get(groupKey);
    if (group === undefined) {
      group = { period, currency, dimension: dimension as FinopsFocusDimension, entries: [] };
      monthlyGroups.set(groupKey, group);
    }
    group.entries.push(entry);
  }
  const sourceLines = allRows.map(({ line }) => line);
  const dailyTrendCounts = new Map<string, number>();
  const dailyTrendReports = [...dailyTrends.values()]
    .sort((left, right) => left.currency.localeCompare(right.currency) || right.day.localeCompare(left.day))
    .flatMap((trend) => {
      const count = dailyTrendCounts.get(trend.currency) ?? 0;
      if (count >= FINOPS_FOCUS_DASHBOARD_BOUNDS.dailyTrendBucketsPerCurrency) return [];
      dailyTrendCounts.set(trend.currency, count + 1);
      return [{ day: trend.day, currency: trend.currency, lineCount: trend.lineCount, ...costSummary(trend) }];
    })
    .sort((left, right) => left.day.localeCompare(right.day) || left.currency.localeCompare(right.currency));

  return {
    ok: true,
    schema: "sutra.finops-focus-dashboard.v1",
    standard: "FOCUS_1_2",
    conformanceClaim: false,
    evidence: {
      organizationId: input.scope.orgId,
      customerId: input.scope.customerId,
      connectionId: input.scope.connectionId,
      exportName: exportName!,
      periods: sortedDatasets.map((dataset) => ({
        period: dataset.scope.billingPeriod,
        generationId: dataset.scope.generationId,
        manifestSha256: dataset.evidence.activeManifestSha256,
        sourceTable: dataset.evidence.activeSourceTable,
        committedAtIso: dataset.evidence.activeCommittedAtIso,
        acceptedRows: dataset.evidence.acceptedRows,
        rejectedRows: dataset.evidence.rejectedRows,
      })),
    },
    quality: {
      sourceFormat: "focus",
      sourceVersion: "1.2",
      schemaCoverageBasis: "canonical_non_null_field_presence",
      acceptedLineCount: totalRows,
      selectedLineCount: selectedRows.length,
      rejectedSourceRowCount: rejectedSourceRows,
      ingestionCoverage: rejectedSourceRows === 0 ? "complete" : "partial",
      rejectionRatio: {
        rejectedRowsNumerator: rejectedSourceRows.toString(),
        observedRowsDenominator: (totalRows + rejectedSourceRows).toString(),
      },
      fields: fieldCoverage,
    },
    currencies: currencyReports,
    trends: [...trends.values()]
      .sort((left, right) => left.period.localeCompare(right.period)
        || left.currency.localeCompare(right.currency))
      .map((trend) => ({
        period: trend.period,
        currency: trend.currency,
        lineCount: trend.lineCount,
        ...costSummary(trend),
      })),
    dailyTrends: dailyTrendReports,
    monthlyDimensions: [...monthlyGroups.values()]
      .sort((left, right) => left.period.localeCompare(right.period)
        || left.currency.localeCompare(right.currency)
        || left.dimension.localeCompare(right.dimension))
      .map((group) => {
        const sorted = group.entries.sort(compareMutableCost);
        const entries = sorted.slice(0, FINOPS_FOCUS_DASHBOARD_BOUNDS.monthlyDimensionValueLimit);
        return {
          period: group.period,
          currency: group.currency,
          dimension: group.dimension,
          entries: entries.map((entry, index) => ({ rank: index + 1, value: entry.value,
            lineCount: entry.lineCount, ...costSummary(entry) })),
          truncated: entries.length < sorted.length,
        };
      }),
    selection: {
      filters: selectedFilters,
      sourceAcceptedLineCount: totalRows,
      matchedLineCount: selectedRows.length,
      filterOptions: {
        billingAccounts: filterOption(sourceLines, (line) => line.payerAccountId),
        subAccounts: filterOption(sourceLines, (line) => line.usageAccountId),
        providers: filterOption(sourceLines, (line) => line.billingEntity),
        publishers: filterOption(sourceLines, (line) => line.legalEntity),
        chargeCategories: filterOption(sourceLines, (line) => line.chargeCategory),
      },
    },
    drilldowns: {
      totalRows: selectedRows.length,
      returnedRows: drilldownRows.length,
      truncated: drilldownRows.length < selectedRows.length,
      rows: drilldownRows.map(({ billingPeriod, line }) => ({
        period: billingPeriod,
        lineItemId: line.lineItemId,
        currency: line.currency,
        billedCostMicros: line.amountMicros,
        effectiveCostMicros: line.amortizedMicros,
        billingAccountId: line.payerAccountId,
        subAccountId: line.usageAccountId,
        provider: line.billingEntity,
        service: line.service,
        region: line.region,
        chargeCategory: line.chargeCategory,
        resourceId: line.resourceId,
      })),
    },
    neutral,
    invariants: [
      "only_active_canonical_focus_1_2_is_accepted",
      "currencies_are_never_combined",
      "money_uses_signed_bigint_micros",
      "missing_fields_are_not_substituted",
    ],
    disclaimer:
      "This report projects accepted active canonical FOCUS 1.2 rows; it is not a FOCUS conformance certification or invoice reconciliation. Rejected source rows are disclosed, missing fields are not substituted, and no currency conversion or savings claim is made.",
  };
}
