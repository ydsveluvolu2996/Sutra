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
  drilldownLimit: 100,
});

export const FINOPS_FOCUS_DIMENSIONS = [
  "billing_account",
  "sub_account",
  "provider",
  "service",
  "service_category",
  "region",
  "charge_category",
  "resource_type",
] as const;

export type FinopsFocusDimension = typeof FINOPS_FOCUS_DIMENSIONS[number];
export type FinopsFocusCoverage = "complete" | "partial" | "unavailable";

export interface FinopsFocusDashboardInput {
  readonly scope: FinopsActiveBillingScope;
  readonly datasets: readonly FinopsActiveBillingDataset[];
  readonly tagTaxonomy?: FinopsFocusTagTaxonomyPolicy | null;
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
  lineCount: number;
  effectivePresent: number;
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
    lineCount: 0,
    effectivePresent: 0,
  };
}

function addCost(target: MutableCost, line: CanonicalCurLine): void {
  target.billed += BigInt(line.amountMicros);
  target.lineCount += 1;
  if (line.amortizedMicros !== null) {
    target.effectiveObserved += BigInt(line.amortizedMicros);
    target.effectivePresent += 1;
  }
}

function costSummary(value: MutableCost): FinopsFocusCostSummary {
  const missingLineCount = value.lineCount - value.effectivePresent;
  return {
    billedCostMicros: value.billed.toString(),
    effectiveCost: {
      totalMicros: missingLineCount === 0 ? value.effectiveObserved.toString() : null,
      observedMicros: value.effectiveObserved.toString(),
      presentLineCount: value.effectivePresent,
      missingLineCount,
      coverage: coverage(value.effectivePresent, value.lineCount),
    },
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
    case "service": return line.service;
    case "service_category": return line.serviceCategory;
    case "region": return line.region;
    case "charge_category": return line.chargeCategory;
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
    && validText(line.payerAccountId, true)
    && validText(line.billingEntity, true)
    && validText(line.serviceCategory, true)
    && validText(line.region, true)
    && validText(line.resourceId, true)
    && validText(line.resourceType, true)
    && validText(line.invoiceId, true);
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
  const currencies = new Map<string, MutableCurrency>();
  const trends = new Map<string, MutableCost & { period: string; currency: string }>();

  for (const row of allRows) {
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

  const sortedDrilldownRows = [...allRows].sort((left, right) => {
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
    const presentLineCount = allRows.reduce(
      (count, row) => count + (present(field.value(row.line)) ? 1 : 0),
      0,
    );
    return {
      field: field.field,
      requirement: field.requirement,
      presentLineCount,
      missingLineCount: totalRows - presentLineCount,
      coverageBasisPoints: basisPoints(presentLineCount, totalRows),
      coverage: coverage(presentLineCount, totalRows),
    };
  });
  const neutralSourceId = (dataset: FinopsActiveBillingDataset) => `${input.scope.connectionId}:${dataset.scope.billingPeriod}`;
  const neutralTags = (line: CanonicalCurLine) => { const tags = new Map(Object.entries(line.tags)); for (const [key, value] of Object.entries(line.costCategories)) { const normalized = `aws:cost-category:${key}`; if (!tags.has(normalized)) tags.set(normalized, value); } return [...tags].map(([key, value]) => ({ key, value })); };
  const neutral = buildProviderNeutralFocusReport({
    scope: { orgId: input.scope.orgId, customerId: input.scope.customerId },
    sources: sortedDatasets.map((dataset) => ({ orgId: input.scope.orgId, customerId: input.scope.customerId, sourceId: neutralSourceId(dataset), provider: "AWS", focusVersion: "1.2", datasetName: dataset.evidence.activeSourceTable, generationId: dataset.scope.generationId, contentSha256: dataset.evidence.activeManifestSha256, collectedAt: dataset.evidence.activeCommittedAtIso, dataThroughAt: dataset.evidence.activeSourceUpdatedAtIso ?? dataset.evidence.activeObservedAtIso, normalizedSchema: "sutra.focus-neutral-line.v1" })),
    rows: sortedDatasets.flatMap((dataset) => dataset.rows.map(({ line }: { readonly line: CanonicalCurLine }) => ({ sourceId: neutralSourceId(dataset), lineId: line.lineItemId, billingPeriod: dataset.scope.billingPeriod, billingCurrency: line.currency, billedCostMicros: line.amountMicros, effectiveCostMicros: line.amortizedMicros, listCostMicros: line.listCostMicros, contractedCostMicros: line.contractedCostMicros, providerName: line.billingEntity ?? "AWS", serviceName: line.service, chargeCategory: line.chargeCategory, chargeClass: line.chargeClass, chargeClassEvidence: "NOT_PROVIDED" as const, tags: neutralTags(line) }))),
    taxonomy: input.tagTaxonomy ?? null,
  });

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
    drilldowns: {
      totalRows,
      returnedRows: drilldownRows.length,
      truncated: drilldownRows.length < totalRows,
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
