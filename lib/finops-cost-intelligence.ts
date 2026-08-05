/**
 * Foundational Cost Intelligence over reconciled canonical billing rows.
 *
 * The engine is pure and deterministic. It never converts money to Number,
 * never combines currencies, never accepts dynamic property paths, and never
 * fills a missing cost basis with a different basis.
 */
import type { CanonicalCurLine } from "./finops-cur.ts";
import type {
  FinopsReconciliationScope,
  ScopedCanonicalBillingRow,
} from "./finops-reconciliation.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const PERIOD = /^\d{4}-(?:0[1-9]|1[0-2])$/u;
const GENERATION = /^fbg_[a-f0-9]{64}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const INTEGER = /^-?(?:0|[1-9]\d{0,127})$/u;
const MAX_PERIODS = 36;
const MAX_ROWS = 250_000;
const MAX_TAXONOMY_ASSIGNMENTS = 10_000;
const MAX_PIVOT_CELLS = 2_000;
const MAX_MOVERS = 200;
const MAX_EXPLORER_LIMIT = 200;
const MAX_EXPLORER_CARDINALITY = 1_000;
const MAX_CURRENCIES = 128;
const MAX_COMMITMENTS = 2_000;
const UNALLOCATED = "__unallocated__";
const MILLIS_PER_DAY = 86_400_000;

export const FINOPS_TAXONOMY_DIMENSIONS = [
  "company",
  "business_unit",
  "environment",
  "cost_center",
  "account",
] as const;
export type FinopsTaxonomyDimension = typeof FINOPS_TAXONOMY_DIMENSIONS[number];

export const FINOPS_COST_DIMENSIONS = [
  ...FINOPS_TAXONOMY_DIMENSIONS,
  "service",
  "product",
  "region",
  "charge_kind",
  "billing_entity",
  "legal_entity",
  "commitment_type",
] as const;
export type FinopsCostDimension = typeof FINOPS_COST_DIMENSIONS[number];

export const FINOPS_COST_BASES = [
  "billed",
  "net_unblended",
  "amortized",
  "list",
  "contracted",
  "public_on_demand",
] as const;
export type FinopsCostBasis = typeof FINOPS_COST_BASES[number];

export type FinopsAllocationMode = "showback" | "chargeback";
export type FinopsInclusionPolicyId = "invoice_total" | "operating_cost";
export type FinopsChargeClass =
  | "standard"
  | "tax"
  | "support"
  | "credit"
  | "refund"
  | "marketplace";

export interface FinopsInclusionPolicy {
  readonly id: FinopsInclusionPolicyId;
  readonly description: string;
  readonly classes: Readonly<Record<FinopsChargeClass, "include" | "exclude">>;
}

export const FINOPS_COST_INCLUSION_POLICIES: Readonly<
  Record<FinopsInclusionPolicyId, FinopsInclusionPolicy>
> = {
  invoice_total: {
    id: "invoice_total",
    description:
      "Includes standard usage, tax, support, Marketplace, credits, and refunds exactly as signed by the source.",
    classes: {
      standard: "include",
      tax: "include",
      support: "include",
      credit: "include",
      refund: "include",
      marketplace: "include",
    },
  },
  operating_cost: {
    id: "operating_cost",
    description:
      "Includes standard usage plus signed credits/refunds; excludes tax, support, and Marketplace with explicit remainder totals.",
    classes: {
      standard: "include",
      tax: "exclude",
      support: "exclude",
      credit: "include",
      refund: "include",
      marketplace: "exclude",
    },
  },
};

export interface FinopsTaxonomyAllowLists {
  readonly company: readonly string[];
  readonly business_unit: readonly string[];
  readonly environment: readonly string[];
  readonly cost_center: readonly string[];
  readonly account: readonly string[];
}

export interface FinopsTaxonomyAssignment {
  readonly accountId: string;
  readonly company?: string | null;
  readonly businessUnit?: string | null;
  readonly environment?: string | null;
  readonly costCenter?: string | null;
  readonly owner?: string | null;
}

export interface FinopsTaxonomyTenantScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface FinopsOrganizationTaxonomy {
  readonly scope: FinopsTaxonomyTenantScope;
  readonly evidence: {
    readonly source: "aws_organizations" | "operator_map" | "cmdb";
    readonly sourceEvidenceId: string;
    readonly observedAtIso: string;
  };
  readonly allowLists: FinopsTaxonomyAllowLists;
  readonly assignments: readonly FinopsTaxonomyAssignment[];
}

export interface FinopsCostPeriod {
  readonly scope: FinopsReconciliationScope;
  readonly rows: readonly ScopedCanonicalBillingRow[];
  /** Optional current-period observation boundary; omission means a full month. */
  readonly observedThroughIso?: string;
}

export interface FinopsExplorerFilter {
  readonly dimension: FinopsCostDimension;
  readonly value: string;
}

export interface FinopsExplorerRequest {
  readonly period?: string;
  readonly dimensions: readonly FinopsCostDimension[];
  readonly filters?: readonly FinopsExplorerFilter[];
  readonly limit?: number;
  readonly maximumCardinality?: number;
}

export interface FinopsForecastRequest {
  readonly trainingPeriods?: number;
  readonly minimumPeriods?: number;
}

export interface FinopsCommitmentCoverageEvidence {
  readonly evidenceLabel: string;
  readonly unusedChargesComplete: boolean;
  readonly publicOnDemandCostComplete: boolean;
  readonly usageQuantityComplete: boolean;
}

export interface FinopsCommitmentRequest {
  readonly asOfIso: string;
  readonly expiresWithinDays: number;
  readonly coverage: FinopsCommitmentCoverageEvidence;
}

export interface FinopsCostIntelligenceInput {
  readonly periods: readonly FinopsCostPeriod[];
  readonly costBasis: FinopsCostBasis;
  readonly allocationMode: FinopsAllocationMode;
  readonly inclusionPolicy?: FinopsInclusionPolicyId;
  readonly taxonomy: FinopsOrganizationTaxonomy;
  readonly baselinePeriod?: string;
  readonly comparisonPeriod?: string;
  readonly moverDimension?: FinopsCostDimension;
  readonly pivotDimensions: readonly [FinopsCostDimension, FinopsCostDimension];
  readonly explorer?: FinopsExplorerRequest;
  readonly forecast?: FinopsForecastRequest;
  readonly commitments: FinopsCommitmentRequest;
}

export type FinopsCostIntelligenceFailureCode =
  | "INVALID_INPUT"
  | "LIMIT_EXCEEDED"
  | "INVALID_SCOPE"
  | "ROW_SCOPE_MISMATCH"
  | "DUPLICATE_PERIOD"
  | "INVALID_TAXONOMY"
  | "INCOMPLETE_COST_BASIS"
  | "INVALID_DIMENSION"
  | "INVALID_FILTER"
  | "HIGH_CARDINALITY"
  | "COMMITMENT_CONFLICT";

export interface FinopsCostIntelligenceFailure {
  readonly code: FinopsCostIntelligenceFailureCode;
  readonly field: string;
  readonly rowIndex?: number;
  readonly period?: string;
  readonly lineItemId?: string;
}

export interface FinopsTaxonomyAllocationNode {
  readonly dimension: FinopsTaxonomyDimension;
  readonly value: string;
  readonly amountMicros: string;
  readonly lineCount: number;
  readonly unallocatedMicros: string;
  readonly unallocatedLineCount: number;
  readonly children: readonly FinopsTaxonomyAllocationNode[];
}

export interface FinopsCurrencyAllocation {
  readonly period: string;
  readonly currency: string;
  readonly sourceTotalMicros: string;
  readonly includedMicros: string;
  readonly excludedMicros: string;
  readonly rootUnallocatedMicros: string;
  readonly rootUnallocatedLineCount: number;
  readonly children: readonly FinopsTaxonomyAllocationNode[];
}

export interface FinopsPeriodCurrencySummary {
  readonly period: string;
  readonly currency: string;
  readonly sourceTotalMicros: string;
  readonly includedMicros: string;
  readonly excludedMicros: string;
  readonly includedLineCount: number;
  readonly excludedLineCount: number;
  readonly excludedByClass: readonly {
    readonly chargeClass: FinopsChargeClass;
    readonly amountMicros: string;
    readonly lineCount: number;
  }[];
  readonly averageDailyRunRate: {
    readonly numeratorMicros: string;
    readonly observedDays: number;
    readonly roundedMicrosPerDay: string;
  };
}

export interface FinopsCostMover {
  readonly currency: string;
  readonly dimension: FinopsCostDimension;
  readonly value: string;
  readonly baselineMicros: string;
  readonly comparisonMicros: string;
  readonly absoluteDeltaMicros: string;
  readonly deltaPercentBasisPoints: string | null;
  readonly percentageState: "available" | "zero_baseline";
}

export interface FinopsMomPivotCell {
  readonly currency: string;
  readonly rowDimension: FinopsCostDimension;
  readonly rowValue: string;
  readonly columnDimension: FinopsCostDimension;
  readonly columnValue: string;
  readonly baselineMicros: string;
  readonly comparisonMicros: string;
  readonly deltaMicros: string;
  readonly deltaPercentBasisPoints: string | null;
}

export interface FinopsExplorerGroup {
  readonly currency: string;
  readonly dimensions: readonly {
    readonly dimension: FinopsCostDimension;
    readonly value: string;
  }[];
  readonly amountMicros: string;
  readonly lineCount: number;
}

export type FinopsCurrencyForecast =
  | {
      readonly currency: string;
      readonly status: "insufficient_data";
      readonly model: "integer_linear_trend_v1";
      readonly minimumPeriods: number;
      readonly observedPeriods: number;
      readonly trainingWindow: null;
      readonly evidenceLabels: readonly string[];
      readonly reason: "insufficient_currency_history";
    }
  | {
      readonly currency: string;
      readonly status: "available";
      readonly model: "integer_linear_trend_v1";
      readonly trainingWindow: {
        readonly startPeriod: string;
        readonly endPeriod: string;
        readonly periods: number;
      };
      readonly evidenceLabels: readonly string[];
      readonly forecastPeriod: string;
      readonly forecastMicros: string;
      readonly confidenceRange: {
        readonly method: "mean_absolute_residual_band";
        readonly lowerMicros: string;
        readonly upperMicros: string;
        readonly meanAbsoluteResidualMicros: string;
        readonly disclosure: "deterministic_error_band_not_statistical_confidence";
      };
    };

export interface FinopsUntrackableCommitmentRow {
  readonly lineItemId: string;
  readonly reason: "missing_commitment_id" | "missing_expiry" | "invalid_expiry";
}

export interface FinopsExpiringCommitment {
  readonly currency: string;
  readonly commitmentArnOrId: string;
  readonly commitmentType: string;
  readonly terms: {
    readonly pricingTerm: string | null;
    readonly purchaseOption: string | null;
    readonly chargeFrequency: string | null;
    readonly startIso: string | null;
  };
  readonly endIso: string;
  readonly expiresInDays: number;
  readonly owner: string | null;
  readonly receivingAccountId: string;
  readonly grossMicros: string;
  readonly usedMicros: string;
  readonly unusedMicros: string | null;
  readonly usageQuantity: {
    readonly amountMicros: string;
    readonly unit: string;
  } | null;
  readonly onDemandEquivalentMicros: string | null;
  readonly netSavingsMicros: string | null;
  readonly coverage: {
    readonly evidenceLabel: string;
    readonly complete: boolean;
    readonly missing: readonly (
      | "unused_charges"
      | "public_on_demand_cost"
      | "usage_quantity"
    )[];
  };
}

export interface FinopsCostIntelligenceReport {
  readonly ok: true;
  readonly schema: "sutra.finops-cost-intelligence.v1";
  readonly costBasis: FinopsCostBasis;
  readonly allocationMode: FinopsAllocationMode;
  readonly inclusionPolicy: FinopsInclusionPolicy;
  readonly taxonomyEvidence: FinopsOrganizationTaxonomy["evidence"];
  readonly baselinePeriod: string;
  readonly comparisonPeriod: string;
  readonly summaries: readonly FinopsPeriodCurrencySummary[];
  readonly allocations: readonly FinopsCurrencyAllocation[];
  readonly movers: readonly FinopsCostMover[];
  readonly momPivot: {
    readonly baselinePeriod: string;
    readonly comparisonPeriod: string;
    readonly dimensions: readonly [FinopsCostDimension, FinopsCostDimension];
    readonly cells: readonly FinopsMomPivotCell[];
  };
  readonly explorer: {
    readonly period: string;
    readonly groups: readonly FinopsExplorerGroup[];
  } | null;
  readonly forecasts: readonly FinopsCurrencyForecast[];
  readonly commitments: {
    readonly sourcePeriod: string;
    readonly asOfIso: string;
    readonly expiresWithinDays: number;
    readonly items: readonly FinopsExpiringCommitment[];
    readonly untrackable: readonly FinopsUntrackableCommitmentRow[];
  };
}

export type FinopsCostIntelligenceResult =
  | FinopsCostIntelligenceReport
  | {
      readonly ok: false;
      readonly schema: "sutra.finops-cost-intelligence.v1";
      readonly failures: readonly FinopsCostIntelligenceFailure[];
    };

interface TaxonomyIndex {
  readonly allow: Readonly<Record<FinopsTaxonomyDimension, ReadonlySet<string>>>;
  readonly assignments: ReadonlyMap<string, FinopsTaxonomyAssignment>;
}

interface PreparedRow {
  readonly period: string;
  readonly evidenceLabel: string;
  readonly scoped: ScopedCanonicalBillingRow;
  readonly amount: bigint;
  readonly chargeClass: FinopsChargeClass;
  readonly included: boolean;
}

interface MutableAllocationNode {
  amount: bigint;
  lineCount: number;
  unallocated: bigint;
  unallocatedLineCount: number;
  readonly children: Map<string, MutableAllocationNode>;
}

interface MutableSummary {
  source: bigint;
  included: bigint;
  excluded: bigint;
  includedLines: number;
  excludedLines: number;
  readonly excludedByClass: Map<FinopsChargeClass, { amount: bigint; lines: number }>;
}

interface MutableGroup {
  amount: bigint;
  lines: number;
}

function failure(
  code: FinopsCostIntelligenceFailureCode,
  field: string,
  detail: Omit<FinopsCostIntelligenceFailure, "code" | "field"> = {},
): FinopsCostIntelligenceFailure {
  return { code, field, ...detail };
}

function rejected(
  failures: readonly FinopsCostIntelligenceFailure[],
): FinopsCostIntelligenceResult {
  return {
    ok: false,
    schema: "sutra.finops-cost-intelligence.v1",
    failures,
  };
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, maximum = 256): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !value.includes("\0");
}

function validScope(value: unknown): value is FinopsReconciliationScope {
  if (!isRecord(value)) return false;
  return typeof value.organizationId === "string" && IDENTIFIER.test(value.organizationId)
    && typeof value.customerId === "string" && IDENTIFIER.test(value.customerId)
    && typeof value.connectionId === "string" && IDENTIFIER.test(value.connectionId)
    && validText(value.exportName)
    && typeof value.billingPeriod === "string" && PERIOD.test(value.billingPeriod)
    && typeof value.generationId === "string" && GENERATION.test(value.generationId);
}

function validLineShape(value: unknown): value is CanonicalCurLine {
  if (!isRecord(value)) return false;
  const optionalTextFields = [
    value.productCode,
    value.productName,
    value.region,
    value.billingEntity,
    value.legalEntity,
    value.commitmentType,
  ];
  return validText(value.lineItemId, 4_096)
    && validText(value.usageAccountId)
    && validText(value.service, 1_024)
    && typeof value.currency === "string"
    && CURRENCY.test(value.currency)
    && validText(value.chargeKind, 64)
    && validText(value.chargeCategory, 512)
    && typeof value.usageStartIso === "string"
    && Number.isFinite(Date.parse(value.usageStartIso))
    && optionalTextFields.every((field) => (
      field === null || field === undefined || validText(field, 1_024)
    ));
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

function sameTenantExport(
  left: FinopsReconciliationScope,
  right: FinopsReconciliationScope,
): boolean {
  return left.organizationId === right.organizationId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId
    && left.exportName === right.exportName;
}

function validTenantScope(value: unknown): value is FinopsTaxonomyTenantScope {
  if (!isRecord(value)) return false;
  return typeof value.organizationId === "string" && IDENTIFIER.test(value.organizationId)
    && typeof value.customerId === "string" && IDENTIFIER.test(value.customerId)
    && typeof value.connectionId === "string" && IDENTIFIER.test(value.connectionId);
}

function sameTenantScope(
  active: FinopsReconciliationScope,
  taxonomy: FinopsTaxonomyTenantScope,
): boolean {
  return active.organizationId === taxonomy.organizationId
    && active.customerId === taxonomy.customerId
    && active.connectionId === taxonomy.connectionId;
}

function knownDimension(value: unknown): value is FinopsCostDimension {
  return typeof value === "string"
    && (FINOPS_COST_DIMENSIONS as readonly string[]).includes(value);
}

function knownTaxonomyDimension(value: string): value is FinopsTaxonomyDimension {
  return (FINOPS_TAXONOMY_DIMENSIONS as readonly string[]).includes(value);
}

function selectedAmount(
  line: CanonicalCurLine,
  basis: FinopsCostBasis,
): string | null {
  switch (basis) {
    case "billed": return line.amountMicros;
    case "net_unblended": return line.netUnblendedCostMicros;
    case "amortized": return line.amortizedMicros;
    case "list": return line.listCostMicros;
    case "contracted": return line.contractedCostMicros;
    case "public_on_demand": return line.publicOnDemandCostMicros;
  }
}

function lowerSourceText(line: CanonicalCurLine): string {
  return [
    line.service,
    line.productCode,
    line.productName,
    line.chargeCategory,
    line.chargeDescription,
    line.billingEntity,
    line.invoiceIssuerName,
  ].filter((value): value is string => value !== null).join(" ").toLowerCase();
}

function chargeClass(line: CanonicalCurLine): FinopsChargeClass {
  if (line.chargeKind === "tax") return "tax";
  if (line.chargeKind === "credit") return "credit";
  if (line.chargeKind === "refund") return "refund";
  const source = lowerSourceText(line);
  if (source.includes("marketplace")) return "marketplace";
  if (source.includes("support")) return "support";
  return "standard";
}

function taxonomyValue(
  dimension: FinopsTaxonomyDimension,
  line: CanonicalCurLine,
  taxonomy: TaxonomyIndex,
): string | null {
  const assignment = taxonomy.assignments.get(line.usageAccountId);
  let candidate: string | null | undefined;
  switch (dimension) {
    case "company": candidate = assignment?.company; break;
    case "business_unit": candidate = assignment?.businessUnit; break;
    case "environment": candidate = assignment?.environment; break;
    case "cost_center": candidate = assignment?.costCenter; break;
    case "account": candidate = line.usageAccountId; break;
  }
  return typeof candidate === "string" && taxonomy.allow[dimension].has(candidate)
    ? candidate
    : null;
}

function dimensionValue(
  dimension: FinopsCostDimension,
  line: CanonicalCurLine,
  taxonomy: TaxonomyIndex,
): string {
  if (knownTaxonomyDimension(dimension)) {
    return taxonomyValue(dimension, line, taxonomy) ?? UNALLOCATED;
  }
  switch (dimension) {
    case "service": return line.service || UNALLOCATED;
    case "product": return line.productCode ?? line.productName ?? UNALLOCATED;
    case "region": return line.region ?? UNALLOCATED;
    case "charge_kind": return line.chargeKind;
    case "billing_entity": return line.billingEntity ?? UNALLOCATED;
    case "legal_entity": return line.legalEntity ?? UNALLOCATED;
    case "commitment_type": return line.commitmentType ?? UNALLOCATED;
  }
}

function roundDivide(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= BigInt(0)) return BigInt(0);
  const negative = numerator < BigInt(0);
  const absolute = negative ? -numerator : numerator;
  const rounded = (absolute + (denominator / BigInt(2))) / denominator;
  return negative ? -rounded : rounded;
}

function absolute(value: bigint): bigint {
  return value < BigInt(0) ? -value : value;
}

function percentBasisPoints(delta: bigint, baseline: bigint): string | null {
  if (baseline === BigInt(0)) return null;
  return roundDivide(
    delta * BigInt(10_000),
    absolute(baseline),
  ).toString();
}

function daysInPeriod(period: string): number {
  const [yearText, monthText] = period.split("-");
  return new Date(Date.UTC(Number(yearText), Number(monthText), 0)).getUTCDate();
}

function observedDays(period: string, observedThroughIso: string | undefined): number | null {
  if (observedThroughIso === undefined) return daysInPeriod(period);
  if (typeof observedThroughIso !== "string") return null;
  const parsed = Date.parse(observedThroughIso);
  if (!Number.isFinite(parsed) || observedThroughIso.slice(0, 7) !== period) return null;
  const day = new Date(parsed).getUTCDate();
  return Math.max(1, Math.min(day, daysInPeriod(period)));
}

function addMonth(period: string): string {
  const [yearText, monthText] = period.split("-");
  const date = new Date(Date.UTC(Number(yearText), Number(monthText), 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

function taxonomyIndex(
  input: FinopsOrganizationTaxonomy,
): { readonly index: TaxonomyIndex | null; readonly failures: readonly FinopsCostIntelligenceFailure[] } {
  if (
    !isRecord(input)
    || !validTenantScope(input.scope)
    || !isRecord(input.evidence)
    || !new Set(["aws_organizations", "operator_map", "cmdb"]).has(input.evidence.source)
    || !validText(input.evidence.sourceEvidenceId, 1_024)
    || typeof input.evidence.observedAtIso !== "string"
    || !Number.isFinite(Date.parse(input.evidence.observedAtIso))
    || !isRecord(input.allowLists)
    || !Array.isArray(input.assignments)
    || input.assignments.length > MAX_TAXONOMY_ASSIGNMENTS
  ) {
    return { index: null, failures: [failure("INVALID_TAXONOMY", "taxonomy")] };
  }
  const allow = {} as Record<FinopsTaxonomyDimension, ReadonlySet<string>>;
  for (const dimension of FINOPS_TAXONOMY_DIMENSIONS) {
    const values = input.allowLists[dimension];
    if (
      !Array.isArray(values)
      || values.length > MAX_TAXONOMY_ASSIGNMENTS
      || values.some((value) => !validText(value))
      || new Set(values).size !== values.length
    ) {
      return {
        index: null,
        failures: [failure("INVALID_TAXONOMY", `taxonomy.allowLists.${dimension}`)],
      };
    }
    allow[dimension] = new Set(values);
  }
  const assignments = new Map<string, FinopsTaxonomyAssignment>();
  for (let index = 0; index < input.assignments.length; index += 1) {
    const assignment = input.assignments[index];
    if (
      !isRecord(assignment)
      || typeof assignment.accountId !== "string"
      || !allow.account.has(assignment.accountId)
      || assignments.has(assignment.accountId)
      || (assignment.owner !== undefined && assignment.owner !== null
        && !validText(assignment.owner))
    ) {
      return {
        index: null,
        failures: [failure("INVALID_TAXONOMY", `taxonomy.assignments[${index}]`)],
      };
    }
    const values: readonly [FinopsTaxonomyDimension, unknown][] = [
      ["company", assignment.company],
      ["business_unit", assignment.businessUnit],
      ["environment", assignment.environment],
      ["cost_center", assignment.costCenter],
    ];
    if (values.some(([dimension, value]) => (
      value !== undefined && value !== null
      && (typeof value !== "string" || !allow[dimension].has(value))
    ))) {
      return {
        index: null,
        failures: [failure("INVALID_TAXONOMY", `taxonomy.assignments[${index}]`)],
      };
    }
    assignments.set(assignment.accountId, {
      accountId: assignment.accountId,
      company: typeof assignment.company === "string" ? assignment.company : null,
      businessUnit: typeof assignment.businessUnit === "string" ? assignment.businessUnit : null,
      environment: typeof assignment.environment === "string" ? assignment.environment : null,
      costCenter: typeof assignment.costCenter === "string" ? assignment.costCenter : null,
      owner: typeof assignment.owner === "string" ? assignment.owner : null,
    });
  }
  return { index: { allow, assignments }, failures: [] };
}

function newAllocationNode(): MutableAllocationNode {
  return {
    amount: BigInt(0),
    lineCount: 0,
    unallocated: BigInt(0),
    unallocatedLineCount: 0,
    children: new Map(),
  };
}

function addAllocation(
  root: MutableAllocationNode,
  row: PreparedRow,
  taxonomy: TaxonomyIndex,
): void {
  root.amount += row.amount;
  root.lineCount += 1;
  let current = root;
  for (const dimension of FINOPS_TAXONOMY_DIMENSIONS) {
    const value = taxonomyValue(dimension, row.scoped.line, taxonomy);
    if (value === null) {
      current.unallocated += row.amount;
      current.unallocatedLineCount += 1;
      return;
    }
    const key = `${dimension}\0${value}`;
    const child = current.children.get(key) ?? newAllocationNode();
    child.amount += row.amount;
    child.lineCount += 1;
    current.children.set(key, child);
    current = child;
  }
}

function finalizeAllocationNode(
  key: string,
  node: MutableAllocationNode,
): FinopsTaxonomyAllocationNode {
  const separator = key.indexOf("\0");
  const dimension = key.slice(0, separator) as FinopsTaxonomyDimension;
  const value = key.slice(separator + 1);
  return {
    dimension,
    value,
    amountMicros: node.amount.toString(),
    lineCount: node.lineCount,
    unallocatedMicros: node.unallocated.toString(),
    unallocatedLineCount: node.unallocatedLineCount,
    children: [...node.children.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([childKey, child]) => finalizeAllocationNode(childKey, child)),
  };
}

function groupKey(parts: readonly string[]): string {
  return parts.join("\0");
}

function includedRows(prepared: readonly PreparedRow[]): readonly PreparedRow[] {
  return prepared.filter((row) => row.included);
}

function totalsByDimension(
  rows: readonly PreparedRow[],
  period: string,
  dimension: FinopsCostDimension,
  taxonomy: TaxonomyIndex,
): ReadonlyMap<string, bigint> {
  const result = new Map<string, bigint>();
  for (const row of rows) {
    if (row.period !== period || !row.included) continue;
    const value = dimensionValue(dimension, row.scoped.line, taxonomy);
    const key = groupKey([row.scoped.line.currency, value]);
    result.set(key, (result.get(key) ?? BigInt(0)) + row.amount);
  }
  return result;
}

function buildMovers(
  rows: readonly PreparedRow[],
  baseline: string,
  comparison: string,
  dimension: FinopsCostDimension,
  taxonomy: TaxonomyIndex,
): readonly FinopsCostMover[] {
  const baselineTotals = totalsByDimension(rows, baseline, dimension, taxonomy);
  const comparisonTotals = totalsByDimension(rows, comparison, dimension, taxonomy);
  const keys = new Set([...baselineTotals.keys(), ...comparisonTotals.keys()]);
  return [...keys].map((key) => {
    const [currency = "", value = ""] = key.split("\0");
    const before = baselineTotals.get(key) ?? BigInt(0);
    const after = comparisonTotals.get(key) ?? BigInt(0);
    const delta = after - before;
    return {
      currency,
      dimension,
      value,
      baselineMicros: before.toString(),
      comparisonMicros: after.toString(),
      absoluteDeltaMicros: delta.toString(),
      deltaPercentBasisPoints: percentBasisPoints(delta, before),
      percentageState: before === BigInt(0) ? "zero_baseline" as const : "available" as const,
    };
  }).filter((entry) => entry.absoluteDeltaMicros !== "0")
    .sort((left, right) => {
      const amountOrder = absolute(BigInt(right.absoluteDeltaMicros))
        > absolute(BigInt(left.absoluteDeltaMicros)) ? 1
        : absolute(BigInt(right.absoluteDeltaMicros))
          < absolute(BigInt(left.absoluteDeltaMicros)) ? -1 : 0;
      return amountOrder
        || left.currency.localeCompare(right.currency)
        || left.value.localeCompare(right.value);
    }).slice(0, MAX_MOVERS);
}

function buildPivot(
  rows: readonly PreparedRow[],
  baseline: string,
  comparison: string,
  dimensions: readonly [FinopsCostDimension, FinopsCostDimension],
  taxonomy: TaxonomyIndex,
): readonly FinopsMomPivotCell[] | null {
  const totals = new Map<string, { baseline: bigint; comparison: bigint }>();
  for (const row of rows) {
    if (!row.included || (row.period !== baseline && row.period !== comparison)) continue;
    const rowValue = dimensionValue(dimensions[0], row.scoped.line, taxonomy);
    const columnValue = dimensionValue(dimensions[1], row.scoped.line, taxonomy);
    const key = groupKey([row.scoped.line.currency, rowValue, columnValue]);
    const group = totals.get(key) ?? { baseline: BigInt(0), comparison: BigInt(0) };
    if (row.period === baseline) group.baseline += row.amount;
    else group.comparison += row.amount;
    totals.set(key, group);
  }
  if (totals.size > MAX_PIVOT_CELLS) return null;
  return [...totals.entries()].map(([key, group]) => {
    const [currency = "", rowValue = "", columnValue = ""] = key.split("\0");
    const delta = group.comparison - group.baseline;
    return {
      currency,
      rowDimension: dimensions[0],
      rowValue,
      columnDimension: dimensions[1],
      columnValue,
      baselineMicros: group.baseline.toString(),
      comparisonMicros: group.comparison.toString(),
      deltaMicros: delta.toString(),
      deltaPercentBasisPoints: percentBasisPoints(delta, group.baseline),
    };
  }).sort((left, right) => (
    left.currency.localeCompare(right.currency)
    || left.rowValue.localeCompare(right.rowValue)
    || left.columnValue.localeCompare(right.columnValue)
  ));
}

function explorerGroups(
  rows: readonly PreparedRow[],
  request: FinopsExplorerRequest,
  period: string,
  taxonomy: TaxonomyIndex,
): readonly FinopsExplorerGroup[] | "high_cardinality" {
  const groups = new Map<string, MutableGroup>();
  const filters = request.filters ?? [];
  for (const row of rows) {
    if (row.period !== period || !row.included) continue;
    if (filters.some((filter) => (
      dimensionValue(filter.dimension, row.scoped.line, taxonomy) !== filter.value
    ))) continue;
    const values = request.dimensions.map((dimension) =>
      dimensionValue(dimension, row.scoped.line, taxonomy));
    const key = groupKey([row.scoped.line.currency, ...values]);
    const group = groups.get(key) ?? { amount: BigInt(0), lines: 0 };
    group.amount += row.amount;
    group.lines += 1;
    groups.set(key, group);
  }
  const maximum = request.maximumCardinality ?? MAX_EXPLORER_CARDINALITY;
  if (groups.size > maximum) return "high_cardinality";
  const limit = request.limit ?? 100;
  return [...groups.entries()].map(([key, group]) => {
    const [currency = "", ...values] = key.split("\0");
    return {
      currency,
      dimensions: request.dimensions.map((dimension, index) => ({
        dimension,
        value: values[index] ?? UNALLOCATED,
      })),
      amountMicros: group.amount.toString(),
      lineCount: group.lines,
    };
  }).sort((left, right) => {
    const amountOrder = absolute(BigInt(right.amountMicros)) > absolute(BigInt(left.amountMicros))
      ? 1 : absolute(BigInt(right.amountMicros)) < absolute(BigInt(left.amountMicros)) ? -1 : 0;
    return amountOrder
      || left.currency.localeCompare(right.currency)
      || left.dimensions.map(({ value }) => value).join("\0")
        .localeCompare(right.dimensions.map(({ value }) => value).join("\0"));
  }).slice(0, limit);
}

function forecastForCurrency(
  currency: string,
  periodTotals: readonly {
    readonly period: string;
    readonly amount: bigint;
    readonly observed: boolean;
    readonly evidenceLabel: string;
  }[],
  minimumPeriods: number,
  trainingPeriods: number,
): FinopsCurrencyForecast {
  const observed = periodTotals.filter((point) => point.observed).slice(-trainingPeriods);
  const labels = observed.map((point) => point.evidenceLabel);
  if (observed.length < minimumPeriods) {
    return {
      currency,
      status: "insufficient_data",
      model: "integer_linear_trend_v1",
      minimumPeriods,
      observedPeriods: observed.length,
      trainingWindow: null,
      evidenceLabels: labels,
      reason: "insufficient_currency_history",
    };
  }
  const n = BigInt(observed.length);
  let sumX = BigInt(0);
  let sumY = BigInt(0);
  let sumXY = BigInt(0);
  let sumX2 = BigInt(0);
  observed.forEach((point, index) => {
    const x = BigInt(index);
    sumX += x;
    sumY += point.amount;
    sumXY += x * point.amount;
    sumX2 += x * x;
  });
  const slopeNumerator = (n * sumXY) - (sumX * sumY);
  const slopeDenominator = (n * sumX2) - (sumX * sumX);
  const predictedAt = (x: bigint): bigint => {
    if (slopeDenominator === BigInt(0)) return roundDivide(sumY, n);
    const numerator = (sumY * slopeDenominator)
      + (slopeNumerator * ((n * x) - sumX));
    return roundDivide(numerator, n * slopeDenominator);
  };
  const forecastAmount = predictedAt(n);
  const residualTotal = observed.reduce((sum, point, index) => (
    sum + absolute(point.amount - predictedAt(BigInt(index)))
  ), BigInt(0));
  const residual = roundDivide(residualTotal, n);
  return {
    currency,
    status: "available",
    model: "integer_linear_trend_v1",
    trainingWindow: {
      startPeriod: observed[0]?.period ?? "",
      endPeriod: observed[observed.length - 1]?.period ?? "",
      periods: observed.length,
    },
    evidenceLabels: labels,
    forecastPeriod: addMonth(observed[observed.length - 1]?.period ?? ""),
    forecastMicros: forecastAmount.toString(),
    confidenceRange: {
      method: "mean_absolute_residual_band",
      lowerMicros: (forecastAmount - residual).toString(),
      upperMicros: (forecastAmount + residual).toString(),
      meanAbsoluteResidualMicros: residual.toString(),
      disclosure: "deterministic_error_band_not_statistical_confidence",
    },
  };
}

function buildForecasts(
  rows: readonly PreparedRow[],
  periods: readonly FinopsCostPeriod[],
  request: FinopsForecastRequest | undefined,
): readonly FinopsCurrencyForecast[] {
  const minimum = request?.minimumPeriods ?? 3;
  const training = request?.trainingPeriods ?? 6;
  const currencies = new Set(includedRows(rows).map((row) => row.scoped.line.currency));
  return [...currencies].sort().map((currency) => {
    const points = periods.map((period) => {
      const matching = rows.filter((row) => (
        row.included
        && row.period === period.scope.billingPeriod
        && row.scoped.line.currency === currency
      ));
      return {
        period: period.scope.billingPeriod,
        amount: matching.reduce((sum, row) => sum + row.amount, BigInt(0)),
        observed: matching.length > 0,
        evidenceLabel: `${period.scope.billingPeriod}:${period.scope.generationId}`,
      };
    });
    return forecastForCurrency(currency, points, minimum, training);
  });
}

function unusedCommitmentLine(line: CanonicalCurLine): boolean {
  return [line.chargeCategory, line.chargeDescription, line.usageType]
    .filter((value): value is string => value !== null)
    .some((value) => value.toLowerCase().includes("unused"));
}

interface CommitmentAccumulator {
  readonly commitmentArnOrId: string;
  readonly currency: string;
  readonly receivingAccountId: string;
  readonly commitmentType: string;
  readonly pricingTerm: string | null;
  readonly purchaseOption: string | null;
  readonly chargeFrequency: string | null;
  readonly startIso: string | null;
  readonly endIso: string;
  readonly owner: string | null;
  gross: bigint;
  used: bigint;
  unused: bigint;
  onDemand: bigint;
  usageQuantity: bigint;
  usageUnit: string | null;
  publicOnDemandComplete: boolean;
  quantityComplete: boolean;
  usageRows: number;
}

function buildCommitments(
  rows: readonly PreparedRow[],
  sourcePeriod: string,
  request: FinopsCommitmentRequest,
  taxonomy: TaxonomyIndex,
): {
  readonly items: readonly FinopsExpiringCommitment[];
  readonly untrackable: readonly FinopsUntrackableCommitmentRow[];
  readonly conflict: boolean;
  readonly overflow: boolean;
} {
  const asOf = Date.parse(request.asOfIso);
  const endWindow = asOf + (request.expiresWithinDays * MILLIS_PER_DAY);
  const groups = new Map<string, CommitmentAccumulator>();
  const untrackable: FinopsUntrackableCommitmentRow[] = [];
  let conflict = false;
  let overflow = false;
  for (const prepared of rows) {
    if (prepared.period !== sourcePeriod || !prepared.included) continue;
    const line = prepared.scoped.line;
    if (line.commitmentType === null && line.commitmentId === null) continue;
    if (line.commitmentId === null) {
      if (untrackable.length < MAX_COMMITMENTS) {
        untrackable.push({ lineItemId: line.lineItemId, reason: "missing_commitment_id" });
      } else overflow = true;
      continue;
    }
    if (line.commitmentExpiry === null) {
      if (untrackable.length < MAX_COMMITMENTS) {
        untrackable.push({ lineItemId: line.lineItemId, reason: "missing_expiry" });
      } else overflow = true;
      continue;
    }
    const expiry = Date.parse(line.commitmentExpiry);
    if (!Number.isFinite(expiry)) {
      if (untrackable.length < MAX_COMMITMENTS) {
        untrackable.push({ lineItemId: line.lineItemId, reason: "invalid_expiry" });
      } else overflow = true;
      continue;
    }
    if (expiry < asOf || expiry > endWindow) continue;
    const assignment = taxonomy.assignments.get(line.usageAccountId);
    const key = groupKey([line.currency, line.commitmentId, line.usageAccountId]);
    const candidate: CommitmentAccumulator = {
      commitmentArnOrId: line.commitmentId,
      currency: line.currency,
      receivingAccountId: line.usageAccountId,
      commitmentType: line.commitmentType ?? "unknown",
      pricingTerm: line.pricingTerm,
      purchaseOption: line.commitmentPurchaseOption,
      chargeFrequency: line.chargeFrequency,
      startIso: line.commitmentStart,
      endIso: line.commitmentExpiry,
      owner: assignment?.owner ?? null,
      gross: BigInt(0),
      used: BigInt(0),
      unused: BigInt(0),
      onDemand: BigInt(0),
      usageQuantity: BigInt(0),
      usageUnit: null,
      publicOnDemandComplete: true,
      quantityComplete: true,
      usageRows: 0,
    };
    const group = groups.get(key) ?? candidate;
    if (!groups.has(key) && groups.size >= MAX_COMMITMENTS) {
      overflow = true;
      continue;
    }
    if (
      group.commitmentType !== candidate.commitmentType
      || group.pricingTerm !== candidate.pricingTerm
      || group.purchaseOption !== candidate.purchaseOption
      || group.chargeFrequency !== candidate.chargeFrequency
      || group.startIso !== candidate.startIso
      || group.endIso !== candidate.endIso
      || group.owner !== candidate.owner
    ) {
      conflict = true;
      continue;
    }
    group.gross += prepared.amount;
    if (unusedCommitmentLine(line)) {
      group.unused += prepared.amount;
    } else {
      group.used += prepared.amount;
    }
    if (line.chargeKind === "usage" && !unusedCommitmentLine(line)) {
      group.usageRows += 1;
      if (line.publicOnDemandCostMicros === null || !INTEGER.test(line.publicOnDemandCostMicros)) {
        group.publicOnDemandComplete = false;
      } else {
        group.onDemand += BigInt(line.publicOnDemandCostMicros);
      }
      if (
        line.usageAmountMicros === null
        || !INTEGER.test(line.usageAmountMicros)
        || line.usageUnit === null
        || (group.usageUnit !== null && group.usageUnit !== line.usageUnit)
      ) {
        group.quantityComplete = false;
      } else {
        group.usageQuantity += BigInt(line.usageAmountMicros);
        group.usageUnit = line.usageUnit;
      }
    }
    groups.set(key, group);
  }
  const items = [...groups.values()].map((group): FinopsExpiringCommitment => {
    const publicComplete = request.coverage.publicOnDemandCostComplete
      && group.publicOnDemandComplete && group.usageRows > 0;
    const unusedComplete = request.coverage.unusedChargesComplete;
    const quantityComplete = request.coverage.usageQuantityComplete
      && group.quantityComplete && group.usageRows > 0 && group.usageUnit !== null;
    const missing: Array<"unused_charges" | "public_on_demand_cost" | "usage_quantity"> = [];
    if (!unusedComplete) missing.push("unused_charges");
    if (!publicComplete) missing.push("public_on_demand_cost");
    if (!quantityComplete) missing.push("usage_quantity");
    const savingsComplete = publicComplete && unusedComplete;
    return {
      currency: group.currency,
      commitmentArnOrId: group.commitmentArnOrId,
      commitmentType: group.commitmentType,
      terms: {
        pricingTerm: group.pricingTerm,
        purchaseOption: group.purchaseOption,
        chargeFrequency: group.chargeFrequency,
        startIso: group.startIso,
      },
      endIso: group.endIso,
      expiresInDays: Math.floor((Date.parse(group.endIso) - asOf) / MILLIS_PER_DAY),
      owner: group.owner,
      receivingAccountId: group.receivingAccountId,
      grossMicros: group.gross.toString(),
      usedMicros: group.used.toString(),
      unusedMicros: unusedComplete ? group.unused.toString() : null,
      usageQuantity: quantityComplete ? {
        amountMicros: group.usageQuantity.toString(),
        unit: group.usageUnit ?? "",
      } : null,
      onDemandEquivalentMicros: publicComplete ? group.onDemand.toString() : null,
      netSavingsMicros: savingsComplete
        ? (group.onDemand - group.gross).toString()
        : null,
      coverage: {
        evidenceLabel: request.coverage.evidenceLabel,
        complete: missing.length === 0,
        missing,
      },
    };
  }).sort((left, right) => (
    left.endIso.localeCompare(right.endIso)
    || left.currency.localeCompare(right.currency)
    || left.commitmentArnOrId.localeCompare(right.commitmentArnOrId)
    || left.receivingAccountId.localeCompare(right.receivingAccountId)
  ));
  return {
    items,
    untrackable: untrackable.sort((left, right) =>
      left.lineItemId.localeCompare(right.lineItemId)),
    conflict,
    overflow,
  };
}

/**
 * Build a bounded enterprise Cost Intelligence report.
 */
export function buildFinopsCostIntelligence(
  input: FinopsCostIntelligenceInput,
): FinopsCostIntelligenceResult {
  if (
    !isRecord(input)
    || !Array.isArray(input.periods)
    || input.periods.length < 1
    || input.periods.length > MAX_PERIODS
    || !(FINOPS_COST_BASES as readonly string[]).includes(input.costBasis)
    || !new Set(["showback", "chargeback"]).has(input.allocationMode)
    || !Array.isArray(input.pivotDimensions)
    || input.pivotDimensions.length !== 2
    || !isRecord(input.commitments)
    || !isRecord(input.commitments.coverage)
  ) return rejected([failure("INVALID_INPUT", "input")]);

  const policyId = input.inclusionPolicy
    ?? (input.allocationMode === "showback" ? "invoice_total" : "operating_cost");
  const policy = FINOPS_COST_INCLUSION_POLICIES[policyId];
  if (policy === undefined) return rejected([failure("INVALID_INPUT", "inclusionPolicy")]);
  const taxonomyResult = taxonomyIndex(input.taxonomy);
  if (taxonomyResult.index === null) return rejected(taxonomyResult.failures);
  const taxonomy = taxonomyResult.index;

  const moverDimension = input.moverDimension ?? "service";
  if (
    !knownDimension(moverDimension)
    || !knownDimension(input.pivotDimensions[0])
    || !knownDimension(input.pivotDimensions[1])
    || input.pivotDimensions[0] === input.pivotDimensions[1]
  ) return rejected([failure("INVALID_DIMENSION", "pivotDimensions")]);

  const explorer = input.explorer;
  if (explorer !== undefined) {
    if (
      !isRecord(explorer)
      || !Array.isArray(explorer.dimensions)
      || explorer.dimensions.length < 1
      || explorer.dimensions.length > 3
      || explorer.dimensions.some((dimension) => !knownDimension(dimension))
      || new Set(explorer.dimensions).size !== explorer.dimensions.length
      || (explorer.limit !== undefined && (
        !Number.isSafeInteger(explorer.limit)
        || explorer.limit < 1
        || explorer.limit > MAX_EXPLORER_LIMIT
      ))
      || (explorer.maximumCardinality !== undefined && (
        !Number.isSafeInteger(explorer.maximumCardinality)
        || explorer.maximumCardinality < 1
        || explorer.maximumCardinality > MAX_EXPLORER_CARDINALITY
      ))
    ) return rejected([failure("INVALID_DIMENSION", "explorer.dimensions")]);
    const filters = explorer.filters ?? [];
    if (
      !Array.isArray(filters)
      || filters.length > 8
      || filters.some((filter) => (
        !isRecord(filter)
        || !knownDimension(filter.dimension)
        || !validText(filter.value)
        || (knownTaxonomyDimension(filter.dimension)
          && filter.value !== UNALLOCATED
          && !taxonomy.allow[filter.dimension].has(filter.value))
      ))
    ) return rejected([failure("INVALID_FILTER", "explorer.filters")]);
  }

  if (input.periods.some((period) => (
    !isRecord(period)
    || !validScope(period.scope)
    || !Array.isArray(period.rows)
  ))) return rejected([failure("INVALID_SCOPE", "periods")]);
  const periods = [...input.periods].sort((left, right) =>
    left.scope.billingPeriod.localeCompare(right.scope.billingPeriod));
  const firstScope = periods[0]?.scope;
  if (!validScope(firstScope)) return rejected([failure("INVALID_SCOPE", "periods[0].scope")]);
  if (!sameTenantScope(firstScope, input.taxonomy.scope)) {
    return rejected([failure("INVALID_TAXONOMY", "taxonomy.scope")]);
  }
  const seenPeriods = new Set<string>();
  const failures: FinopsCostIntelligenceFailure[] = [];
  let rowCount = 0;
  for (let periodIndex = 0; periodIndex < periods.length; periodIndex += 1) {
    const period = periods[periodIndex];
    if (
      !isRecord(period)
      || !validScope(period.scope)
      || !sameTenantExport(firstScope, period.scope)
      || !Array.isArray(period.rows)
    ) {
      failures.push(failure("INVALID_SCOPE", `periods[${periodIndex}].scope`));
      continue;
    }
    const checkedPeriod = period as unknown as FinopsCostPeriod;
    if (seenPeriods.has(checkedPeriod.scope.billingPeriod)) {
      failures.push(failure("DUPLICATE_PERIOD", `periods[${periodIndex}].scope.billingPeriod`));
    }
    seenPeriods.add(checkedPeriod.scope.billingPeriod);
    if (observedDays(checkedPeriod.scope.billingPeriod, checkedPeriod.observedThroughIso) === null) {
      failures.push(failure("INVALID_INPUT", `periods[${periodIndex}].observedThroughIso`));
    }
    rowCount += checkedPeriod.rows.length;
    checkedPeriod.rows.forEach((row, index) => {
      if (!validScope(row) || !sameScope(checkedPeriod.scope, row)) {
        failures.push(failure("ROW_SCOPE_MISMATCH", `periods[${periodIndex}].rows[${index}]`, {
          rowIndex: index,
          period: checkedPeriod.scope.billingPeriod,
        }));
      } else if (!validLineShape(row.line)) {
        failures.push(failure("INVALID_INPUT", `periods[${periodIndex}].rows[${index}].line`, {
          rowIndex: index,
          period: checkedPeriod.scope.billingPeriod,
        }));
      }
    });
  }
  if (rowCount > MAX_ROWS) failures.push(failure("LIMIT_EXCEEDED", "periods.rows"));
  if (failures.length > 0) return rejected(failures);

  const baseline = input.baselinePeriod
    ?? periods[Math.max(0, periods.length - 2)]?.scope.billingPeriod ?? "";
  const comparison = input.comparisonPeriod
    ?? periods[periods.length - 1]?.scope.billingPeriod ?? "";
  if (!seenPeriods.has(baseline) || !seenPeriods.has(comparison) || baseline === comparison) {
    return rejected([failure("INVALID_INPUT", "baselinePeriod")]);
  }
  if (
    !isRecord(input.forecast ?? {})
    || (input.forecast?.minimumPeriods !== undefined && (
      !Number.isSafeInteger(input.forecast.minimumPeriods)
      || input.forecast.minimumPeriods < 3
      || input.forecast.minimumPeriods > 12
    ))
    || (input.forecast?.trainingPeriods !== undefined && (
      !Number.isSafeInteger(input.forecast.trainingPeriods)
      || input.forecast.trainingPeriods < 3
      || input.forecast.trainingPeriods > 24
    ))
  ) return rejected([failure("INVALID_INPUT", "forecast")]);
  if (
    (input.forecast?.trainingPeriods ?? 6)
    < (input.forecast?.minimumPeriods ?? 3)
  ) return rejected([failure("INVALID_INPUT", "forecast.trainingPeriods")]);
  if (
    !Number.isFinite(Date.parse(input.commitments.asOfIso))
    || !Number.isSafeInteger(input.commitments.expiresWithinDays)
    || input.commitments.expiresWithinDays < 1
    || input.commitments.expiresWithinDays > 1_095
    || !validText(input.commitments.coverage.evidenceLabel, 1_024)
    || typeof input.commitments.coverage.unusedChargesComplete !== "boolean"
    || typeof input.commitments.coverage.publicOnDemandCostComplete !== "boolean"
    || typeof input.commitments.coverage.usageQuantityComplete !== "boolean"
  ) return rejected([failure("INVALID_INPUT", "commitments")]);

  const prepared: PreparedRow[] = [];
  for (const period of periods) {
    for (let index = 0; index < period.rows.length; index += 1) {
      const scoped = period.rows[index];
      const value = selectedAmount(scoped.line, input.costBasis);
      if (value === null || !INTEGER.test(value) || !CURRENCY.test(scoped.line.currency)) {
        failures.push(failure("INCOMPLETE_COST_BASIS", "line.costBasis", {
          rowIndex: index,
          period: period.scope.billingPeriod,
          lineItemId: scoped.line.lineItemId,
        }));
        continue;
      }
      const classified = chargeClass(scoped.line);
      prepared.push({
        period: period.scope.billingPeriod,
        evidenceLabel: `${period.scope.billingPeriod}:${period.scope.generationId}`,
        scoped,
        amount: BigInt(value),
        chargeClass: classified,
        included: policy.classes[classified] === "include",
      });
    }
  }
  if (failures.length > 0) return rejected(failures);
  if (new Set(prepared.map((row) => row.scoped.line.currency)).size > MAX_CURRENCIES) {
    return rejected([failure("LIMIT_EXCEEDED", "currencies")]);
  }

  const summaries = new Map<string, MutableSummary>();
  const allocationRoots = new Map<string, MutableAllocationNode>();
  for (const row of prepared) {
    const currency = row.scoped.line.currency;
    const key = groupKey([row.period, currency]);
    const summary = summaries.get(key) ?? {
      source: BigInt(0),
      included: BigInt(0),
      excluded: BigInt(0),
      includedLines: 0,
      excludedLines: 0,
      excludedByClass: new Map(),
    };
    const root = allocationRoots.get(key) ?? newAllocationNode();
    allocationRoots.set(key, root);
    summary.source += row.amount;
    if (row.included) {
      summary.included += row.amount;
      summary.includedLines += 1;
      addAllocation(root, row, taxonomy);
    } else {
      summary.excluded += row.amount;
      summary.excludedLines += 1;
      const excluded = summary.excludedByClass.get(row.chargeClass)
        ?? { amount: BigInt(0), lines: 0 };
      excluded.amount += row.amount;
      excluded.lines += 1;
      summary.excludedByClass.set(row.chargeClass, excluded);
    }
    summaries.set(key, summary);
  }

  const finalizedSummaries: FinopsPeriodCurrencySummary[] = [...summaries.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, summary]) => {
      const [period = "", currency = ""] = key.split("\0");
      const periodInput = periods.find((entry) => entry.scope.billingPeriod === period);
      const days = observedDays(period, periodInput?.observedThroughIso) ?? daysInPeriod(period);
      return {
        period,
        currency,
        sourceTotalMicros: summary.source.toString(),
        includedMicros: summary.included.toString(),
        excludedMicros: summary.excluded.toString(),
        includedLineCount: summary.includedLines,
        excludedLineCount: summary.excludedLines,
        excludedByClass: [...summary.excludedByClass.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([classified, excluded]) => ({
            chargeClass: classified,
            amountMicros: excluded.amount.toString(),
            lineCount: excluded.lines,
          })),
        averageDailyRunRate: {
          numeratorMicros: summary.included.toString(),
          observedDays: days,
          roundedMicrosPerDay: roundDivide(summary.included, BigInt(days)).toString(),
        },
      };
    });

  const allocations: FinopsCurrencyAllocation[] = [...allocationRoots.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, root]) => {
      const [period = "", currency = ""] = key.split("\0");
      const summary = summaries.get(key);
      return {
        period,
        currency,
        sourceTotalMicros: summary?.source.toString() ?? "0",
        includedMicros: root.amount.toString(),
        excludedMicros: summary?.excluded.toString() ?? "0",
        rootUnallocatedMicros: root.unallocated.toString(),
        rootUnallocatedLineCount: root.unallocatedLineCount,
        children: [...root.children.entries()]
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([childKey, child]) => finalizeAllocationNode(childKey, child)),
      };
    });

  const pivot = buildPivot(
    prepared,
    baseline,
    comparison,
    input.pivotDimensions,
    taxonomy,
  );
  if (pivot === null) return rejected([failure("HIGH_CARDINALITY", "momPivot")]);

  let explorerResult: FinopsCostIntelligenceReport["explorer"] = null;
  if (explorer !== undefined) {
    const explorerPeriod = explorer.period ?? comparison;
    if (!seenPeriods.has(explorerPeriod)) {
      return rejected([failure("INVALID_INPUT", "explorer.period")]);
    }
    const groups = explorerGroups(prepared, explorer, explorerPeriod, taxonomy);
    if (groups === "high_cardinality") {
      return rejected([failure("HIGH_CARDINALITY", "explorer")]);
    }
    explorerResult = { period: explorerPeriod, groups };
  }

  const commitmentResult = buildCommitments(
    prepared,
    comparison,
    input.commitments,
    taxonomy,
  );
  if (commitmentResult.conflict) {
    return rejected([failure("COMMITMENT_CONFLICT", "commitments")]);
  }
  if (commitmentResult.overflow) {
    return rejected([failure("LIMIT_EXCEEDED", "commitments")]);
  }

  return {
    ok: true,
    schema: "sutra.finops-cost-intelligence.v1",
    costBasis: input.costBasis,
    allocationMode: input.allocationMode,
    inclusionPolicy: policy,
    taxonomyEvidence: input.taxonomy.evidence,
    baselinePeriod: baseline,
    comparisonPeriod: comparison,
    summaries: finalizedSummaries,
    allocations,
    movers: buildMovers(prepared, baseline, comparison, moverDimension, taxonomy),
    momPivot: {
      baselinePeriod: baseline,
      comparisonPeriod: comparison,
      dimensions: input.pivotDimensions,
      cells: pivot,
    },
    explorer: explorerResult,
    forecasts: buildForecasts(prepared, periods, input.forecast),
    commitments: {
      sourcePeriod: comparison,
      asOfIso: input.commitments.asOfIso,
      expiresWithinDays: input.commitments.expiresWithinDays,
      items: commitmentResult.items,
      untrackable: commitmentResult.untrackable,
    },
  };
}
