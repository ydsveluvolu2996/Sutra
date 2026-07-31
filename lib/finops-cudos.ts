/**
 * Pure Foundational CUDOS projection over one reconciled canonical billing
 * generation. This module performs no I/O and makes no invoice, telemetry,
 * savings, compatibility, or remediation claim.
 *
 * Evidence-honesty invariants:
 * - signed cost arithmetic is BigInt integer micro-units only;
 * - currencies and usage units are never converted or combined;
 * - every row must match the complete tenant/export/period/generation scope;
 * - missing cost, resource, hourly, or commitment evidence remains explicit;
 * - service modules exist only when a canonical source row matches;
 * - CUR-derived opportunities retain bounded source-line evidence and are
 *   labelled estimates requiring review.
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
const INTEGER_MICROS = /^-?(?:0|[1-9]\d{0,127})$/u;
const MAX_ROWS = 250_000;
const MAX_BUCKETS = 50_000;
const MAX_RANKING_LIMIT = 100;
const DEFAULT_RANKING_LIMIT = 10;
const MAX_OPPORTUNITY_LIMIT = 500;
const DEFAULT_OPPORTUNITY_LIMIT = 100;
const MAX_SOURCE_LINE_IDS = 100;
const MAX_MODULE_SOURCE_LINE_IDS = 100;
const MAX_UNIT_COST_METRICS = 1_000;

export const FINOPS_CUDOS_COST_BASES = [
  "unblended",
  "net",
  "amortized",
  "list",
  "contracted",
  "public",
] as const;

export type FinopsCudosCostBasis =
  typeof FINOPS_CUDOS_COST_BASES[number];

export const FINOPS_CUDOS_CHARGE_KINDS = [
  "usage",
  "purchase",
  "tax",
  "credit",
  "refund",
  "fee",
  "discount",
  "adjustment",
  "other",
] as const;

export type FinopsCudosChargeKind =
  typeof FINOPS_CUDOS_CHARGE_KINDS[number];

export const FINOPS_CUDOS_MODULE_IDS = [
  "compute",
  "storage",
  "s3",
  "ebs",
  "database",
  "dynamodb",
  "ai_ml",
  "data_transfer_networking",
  "messaging",
  "monitoring",
  "analytics",
  "security",
] as const;

export type FinopsCudosModuleId =
  typeof FINOPS_CUDOS_MODULE_IDS[number];

export interface FinopsCudosOptions {
  /** Primary basis used for ranking, unit-cost, and opportunity projections. */
  readonly costBasis?: FinopsCudosCostBasis;
  /** Returned entries per currency and ranking dimension. */
  readonly rankingLimit?: number;
  /** Returned CUR-derived review candidates. */
  readonly opportunityLimit?: number;
}

export interface FinopsCudosInput {
  readonly scope: FinopsReconciliationScope;
  readonly rows: readonly ScopedCanonicalBillingRow[];
  readonly options?: FinopsCudosOptions;
}

export type FinopsCudosFailureCode =
  | "INVALID_SCOPE"
  | "INVALID_OPTIONS"
  | "ROW_LIMIT_EXCEEDED"
  | "ROW_SCOPE_MISMATCH"
  | "INVALID_CANONICAL_ROW"
  | "UNKNOWN_CURRENCY"
  | "DUPLICATE_LINE_ITEM_ID"
  | "BUCKET_LIMIT_EXCEEDED";

export interface FinopsCudosFailure {
  readonly code: FinopsCudosFailureCode;
  readonly field: string;
  readonly rowIndex?: number;
}

export type FinopsCudosCoverage =
  | "complete"
  | "partial"
  | "unavailable";

export interface FinopsCudosCostSummary {
  readonly basis: FinopsCudosCostBasis;
  readonly totalMicros: string | null;
  readonly contributingLineCount: number;
  readonly missingLineCount: number;
  readonly coverage: FinopsCudosCoverage;
}

export interface FinopsCudosChargeDisclosure {
  readonly chargeKind: FinopsCudosChargeKind;
  readonly present: boolean;
  readonly lineCount: number;
  readonly sourceChargeKinds: readonly CurChargeKind[];
  readonly costs: readonly FinopsCudosCostSummary[];
}

export interface FinopsCudosCurrencyExecutiveSummary {
  readonly currency: string;
  readonly lineCount: number;
  readonly accountCount: number;
  readonly serviceCount: number;
  readonly regionCount: number;
  readonly resourceCount: number;
  readonly costs: readonly FinopsCudosCostSummary[];
  /** Every charge kind is returned, including evidence-backed zero absence. */
  readonly chargeKinds: readonly FinopsCudosChargeDisclosure[];
}

export interface FinopsCudosTrendBucket {
  readonly currency: string;
  readonly period: string;
  readonly lineCount: number;
  readonly costs: readonly FinopsCudosCostSummary[];
}

export type FinopsCudosRankingDimension =
  | "account"
  | "service"
  | "region";

export interface FinopsCudosRankingEntry {
  readonly currency: string;
  readonly dimension: FinopsCudosRankingDimension;
  readonly rank: number;
  readonly value: string | null;
  readonly label: string | null;
  readonly lineCount: number;
  readonly selectedCostBasis: FinopsCudosCostBasis;
  readonly selectedTotalMicros: string | null;
  readonly costs: readonly FinopsCudosCostSummary[];
}

export interface FinopsCudosModule {
  readonly moduleId: FinopsCudosModuleId;
  readonly lineCount: number;
  readonly services: readonly string[];
  readonly sourceLineIdCount: number;
  readonly sourceLineIds: readonly string[];
  readonly sourceLineIdsTruncated: boolean;
  readonly currencies: readonly {
    readonly currency: string;
    readonly lineCount: number;
    readonly costs: readonly FinopsCudosCostSummary[];
  }[];
}

export interface FinopsCudosDrilldownAvailability {
  readonly lineCount: number;
  readonly resource: {
    readonly status: FinopsCudosCoverage;
    readonly availableLineCount: number;
    readonly missingLineCount: number;
  };
  readonly hourly: {
    readonly status: FinopsCudosCoverage;
    readonly availableLineCount: number;
    readonly missingLineCount: number;
  };
  readonly resourceHourly: {
    readonly status: FinopsCudosCoverage;
    readonly availableLineCount: number;
    readonly missingLineCount: number;
  };
}

export interface FinopsCudosUnitCostMetric {
  readonly currency: string;
  readonly service: string;
  readonly usageUnit: string;
  readonly lineCount: number;
  readonly costBasis: FinopsCudosCostBasis;
  readonly cost: FinopsCudosCostSummary;
  readonly usageQuantityMicros: string;
  /**
   * Exact rational representation of currency micro-units per usage unit.
   * Consumers may format this ratio, but this engine does not round it.
   */
  readonly exactRatio: {
    readonly costMicrosNumerator: string;
    readonly usageQuantityMicrosDenominator: string;
  } | null;
  readonly unavailableReason:
    | "missing_cost_basis"
    | "non_positive_usage_quantity"
    | null;
}

export interface FinopsCudosCommitmentSummary {
  readonly currency: string;
  readonly costBasis: FinopsCudosCostBasis;
  readonly coverage: {
    readonly status: FinopsCudosCoverage;
    readonly coveredCostMicros: string;
    readonly classifiedEligibleCostMicros: string;
    readonly coverageBasisPoints: string | null;
    readonly coveredLineCount: number;
    readonly onDemandLineCount: number;
    readonly excludedSpotLineCount: number;
    readonly unknownClassificationLineCount: number;
    readonly missingCostLineCount: number;
    readonly incompleteReasons: readonly string[];
  };
  readonly utilization: {
    readonly status: FinopsCudosCoverage;
    readonly appliedUsageCostMicros: string;
    readonly explicitUnusedCostMicros: string;
    readonly commitmentFeeCostMicros: string;
    readonly utilizationBasisPoints: string | null;
    readonly appliedUsageLineCount: number;
    readonly explicitUnusedLineCount: number;
    readonly commitmentFeeLineCount: number;
    readonly missingCostLineCount: number;
    readonly incompleteReasons: readonly string[];
  };
  readonly trueUp: {
    readonly status: FinopsCudosCoverage;
    readonly amortizedMinusUnblendedMicros: string | null;
    readonly commitmentLineCount: number;
    readonly missingUnblendedLineCount: number;
    readonly missingAmortizedLineCount: number;
  };
}

export type FinopsCudosOpportunityRuleId =
  | "CUDOS_CUR_ON_DEMAND_COST_EXPOSURE"
  | "CUDOS_CUR_EXPLICIT_UNUSED_COMMITMENT"
  | "CUDOS_CUR_NO_POSITIVE_USAGE_RESOURCE_PATTERN";

export interface FinopsCudosOpportunityEstimate {
  readonly ruleId: FinopsCudosOpportunityRuleId;
  readonly ruleVersion: "1.0.0";
  readonly classification: "cur_derived_review_candidate";
  readonly subjectType: "resource" | "service" | "commitment";
  readonly subjectId: string;
  readonly accountId: string;
  readonly region: string | null;
  readonly service: string;
  readonly currency: string;
  readonly evidenceWindow: {
    readonly fromInclusiveIso: string;
    readonly toExclusiveIso: string;
    readonly derivedFrom: "canonical_usage_intervals";
  };
  readonly estimate: {
    readonly type: "observed_cost_exposure";
    readonly costBasis: FinopsCudosCostBasis;
    readonly totalMicros: string;
    readonly isSavingsClaim: false;
  };
  readonly assumptions: readonly string[];
  readonly confidence: "low" | "medium" | "high";
  readonly sourceLineIdCount: number;
  readonly sourceLineIds: readonly string[];
  readonly sourceLineIdsTruncated: boolean;
  readonly remediationClaim: null;
  readonly reviewRequired: true;
}

export interface FinopsCudosEvidence {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
  readonly exportName: string;
  readonly billingPeriod: string;
  readonly generationId: string;
  readonly activeLineCount: number;
  readonly sourceFormats: readonly {
    readonly sourceFormat: CanonicalCurLine["sourceFormat"];
    readonly sourceVersion: CanonicalCurLine["sourceVersion"];
    readonly lineCount: number;
  }[];
  readonly currencies: readonly string[];
  readonly evidenceWindow: {
    readonly fromInclusiveIso: string;
    readonly toExclusiveIso: string;
    readonly derivedFrom: "canonical_usage_intervals";
  } | null;
}

export type FinopsCudosResult =
  | {
      readonly ok: true;
      readonly schema: "sutra.finops-cudos.v1";
      readonly evidence: FinopsCudosEvidence;
      readonly selectedCostBasis: FinopsCudosCostBasis;
      readonly executive: readonly FinopsCudosCurrencyExecutiveSummary[];
      readonly trends: {
        readonly daily: readonly FinopsCudosTrendBucket[];
        readonly monthly: readonly FinopsCudosTrendBucket[];
      };
      readonly rankings: {
        readonly accounts: readonly FinopsCudosRankingEntry[];
        readonly services: readonly FinopsCudosRankingEntry[];
        readonly regions: readonly FinopsCudosRankingEntry[];
      };
      readonly commitments: readonly FinopsCudosCommitmentSummary[];
      readonly modules: readonly FinopsCudosModule[];
      readonly drilldowns: FinopsCudosDrilldownAvailability;
      readonly unitCosts: {
        readonly metrics: readonly FinopsCudosUnitCostMetric[];
        readonly totalMetrics: number;
        readonly truncated: boolean;
        readonly invariant: "currencies_and_usage_units_are_never_combined";
      };
      readonly opportunities: {
        readonly estimates: readonly FinopsCudosOpportunityEstimate[];
        readonly totalCandidates: number;
        readonly truncated: boolean;
        readonly disclaimer: string;
      };
      readonly failures: readonly [];
    }
  | {
      readonly ok: false;
      readonly schema: "sutra.finops-cudos.v1";
      readonly failures: readonly FinopsCudosFailure[];
    };

interface MutableCost {
  total: bigint;
  contributingLineCount: number;
}

type MutableCosts = Record<FinopsCudosCostBasis, MutableCost>;

interface MutableAggregate {
  lineCount: number;
  readonly costs: MutableCosts;
}

interface MutableExecutive extends MutableAggregate {
  readonly accounts: Set<string>;
  readonly services: Set<string>;
  readonly regions: Set<string>;
  readonly resources: Set<string>;
  readonly charges: Record<FinopsCudosChargeKind, MutableCharge>;
}

interface MutableCharge extends MutableAggregate {
  readonly sourceChargeKinds: Set<CurChargeKind>;
}

interface MutableRanking extends MutableAggregate {
  readonly currency: string;
  readonly value: string | null;
  readonly label: string | null;
}

interface MutableModule {
  lineCount: number;
  readonly rows: CanonicalCurLine[];
  readonly services: Set<string>;
  readonly currencies: Map<string, MutableAggregate>;
}

interface MutableUnitCost extends MutableAggregate {
  readonly currency: string;
  readonly service: string;
  readonly usageUnit: string;
  usageQuantity: bigint;
}

interface MutableOpportunity {
  readonly ruleId: FinopsCudosOpportunityRuleId;
  readonly subjectType: FinopsCudosOpportunityEstimate["subjectType"];
  readonly subjectId: string;
  readonly accountId: string;
  readonly region: string | null;
  readonly service: string;
  readonly currency: string;
  readonly rows: CanonicalCurLine[];
  total: bigint;
  allSelectedCostsPresent: boolean;
}

const INPUT_KEYS = new Set(["scope", "rows", "options"]);
const OPTION_KEYS = new Set(["costBasis", "rankingLimit", "opportunityLimit"]);
const SOURCE_FORMATS = new Set(["aws-cur", "focus"]);
const SOURCE_VERSIONS = new Set(["2.0", "1.0", "1.2"]);
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

const MODULE_MATCHERS: Readonly<
  Record<FinopsCudosModuleId, (text: string) => boolean>
> = {
  compute: (text) => includesAny(text, [
    "amazonec2", "elastic compute cloud", "ec2", "lambda", "fargate",
    "elastic container service", "elastic kubernetes service", "ecs", "eks",
    "aws batch", "lightsail",
  ]),
  storage: (text) => includesAny(text, [
    "amazons3", "simple storage service", "elastic block store", "ebs",
    "elastic file system", "efs", "fsx", "glacier", "aws backup",
    "storage gateway",
  ]),
  s3: (text) => includesAny(text, [
    "amazons3", "simple storage service", "s3 storage", "timedstorage",
  ]),
  ebs: (text) => includesAny(text, [
    "elastic block store", "ebs", "volumeusage", "snapshotusage",
  ]),
  database: (text) => includesAny(text, [
    "amazonrds", "relational database service", "aurora", "documentdb",
    "neptune", "elasticache", "redshift", "dynamodb",
  ]),
  dynamodb: (text) => includesAny(text, ["dynamodb"]),
  ai_ml: (text) => includesAny(text, [
    "bedrock", "sagemaker", "machine learning", "comprehend", "rekognition",
    "textract", "translate", "amazon lex", "qbusiness", "q developer",
  ]),
  data_transfer_networking: (text) => includesAny(text, [
    "data transfer", "datatransfer", "nat gateway", "vpc", "cloudfront",
    "direct connect", "route 53", "route53", "transit gateway",
    "elastic load balancing", "elasticloadbalancing", "global accelerator",
  ]),
  messaging: (text) => includesAny(text, [
    "amazonsns", "amazonsqs", "simple notification service",
    "simple queue service", "eventbridge", "amazon mq", "kinesis",
    "managed streaming for apache kafka", "msk",
  ]),
  monitoring: (text) => includesAny(text, [
    "cloudwatch", "x-ray", "xray", "managed service for prometheus",
    "managed grafana", "cloudtrail",
  ]),
  analytics: (text) => includesAny(text, [
    "athena", "aws glue", "elastic mapreduce", "emr", "redshift",
    "quicksight", "opensearch", "kinesis", "lake formation",
  ]),
  security: (text) => includesAny(text, [
    "guardduty", "web application firewall", "aws waf", "aws shield",
    "security hub", "inspector", "macie", "key management service",
    "secrets manager", "firewall manager", "network firewall", "cognito",
  ]),
};

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validText(value: unknown, maxLength = 1_024): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maxLength
    && !value.includes("\0");
}

function validNullableText(
  value: unknown,
  maxLength = 4_096,
): value is string | null {
  return value === null || validText(value, maxLength);
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
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

function validMap(value: unknown): value is Readonly<Record<string, string>> {
  return isRecord(value)
    && Object.keys(value).length <= 2_048
    && Object.entries(value).every(([key, entry]) =>
      validText(key, 256) && validText(entry, 1_024));
}

function costValue(
  line: CanonicalCurLine,
  basis: FinopsCudosCostBasis,
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
    || !validIso(line.usageStartIso)
    || !validNullableText(line.usageEndIso)
    || (
      line.usageEndIso !== null
      && !validIso(line.usageEndIso)
    )
    || typeof line.currency !== "string"
    || !FINOPS_RECONCILIATION_CURRENCIES.has(
      line.currency as (
        typeof FINOPS_RECONCILIATION_CURRENCIES extends Set<infer T> ? T : never
      ),
    )
    || typeof line.chargeKind !== "string"
    || !CHARGE_KINDS.has(line.chargeKind as CurChargeKind)
    || !SOURCE_FORMATS.has(String(line.sourceFormat))
    || !SOURCE_VERSIONS.has(String(line.sourceVersion))
    || !validMap(line.tags)
    || !validMap(line.costCategories)
    || !validNullableText(line.region)
    || !validNullableText(line.resourceId)
    || !validNullableText(line.usageAccountName)
    || !validNullableText(line.productCode)
    || !validNullableText(line.productName)
    || !validNullableText(line.productFamily)
    || !validNullableText(line.serviceCategory)
    || !validNullableText(line.serviceSubcategory)
    || !validNullableText(line.usageType)
    || !validNullableText(line.operation)
    || !validNullableText(line.commitmentType)
    || !validNullableText(line.commitmentId)
    || !validNullableText(line.commitmentStatus)
    || !validNullableText(line.commitmentCategory)
    || !validNullableText(line.chargeDescription)
    || !validNullableText(line.chargeFrequency)
    || !validNullableText(line.usageUnit, 128)
  ) return false;
  for (const basis of FINOPS_CUDOS_COST_BASES) {
    const amount = costValue(line as unknown as CanonicalCurLine, basis);
    if (amount !== null && !INTEGER_MICROS.test(amount)) return false;
  }
  return line.usageAmountMicros === null
    || (
      typeof line.usageAmountMicros === "string"
      && INTEGER_MICROS.test(line.usageAmountMicros)
    );
}

function fail(
  code: FinopsCudosFailureCode,
  field: string,
  rowIndex?: number,
): FinopsCudosResult {
  return {
    ok: false,
    schema: "sutra.finops-cudos.v1",
    failures: [{
      code,
      field,
      ...(rowIndex === undefined ? {} : { rowIndex }),
    }],
  };
}

function normalizeOptions(
  value: unknown,
): Required<FinopsCudosOptions> | FinopsCudosResult {
  if (value === undefined) {
    return {
      costBasis: "unblended",
      rankingLimit: DEFAULT_RANKING_LIMIT,
      opportunityLimit: DEFAULT_OPPORTUNITY_LIMIT,
    };
  }
  if (
    !isRecord(value)
    || Object.keys(value).some((key) => !OPTION_KEYS.has(key))
  ) return fail("INVALID_OPTIONS", "options");
  const costBasis = value.costBasis === undefined
    ? "unblended"
    : typeof value.costBasis === "string"
      && FINOPS_CUDOS_COST_BASES.includes(
        value.costBasis as FinopsCudosCostBasis,
      )
      ? value.costBasis as FinopsCudosCostBasis
      : null;
  const rankingLimit = value.rankingLimit === undefined
    ? DEFAULT_RANKING_LIMIT
    : value.rankingLimit;
  const opportunityLimit = value.opportunityLimit === undefined
    ? DEFAULT_OPPORTUNITY_LIMIT
    : value.opportunityLimit;
  if (
    costBasis === null
    || typeof rankingLimit !== "number"
    || !Number.isSafeInteger(rankingLimit)
    || rankingLimit < 1
    || rankingLimit > MAX_RANKING_LIMIT
    || typeof opportunityLimit !== "number"
    || !Number.isSafeInteger(opportunityLimit)
    || opportunityLimit < 1
    || opportunityLimit > MAX_OPPORTUNITY_LIMIT
  ) return fail("INVALID_OPTIONS", "options");
  return { costBasis, rankingLimit, opportunityLimit };
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareNullableText(
  left: string | null,
  right: string | null,
): number {
  if (left === null) return right === null ? 0 : 1;
  if (right === null) return -1;
  return compareText(left, right);
}

function newCosts(): MutableCosts {
  return {
    unblended: { total: BigInt(0), contributingLineCount: 0 },
    net: { total: BigInt(0), contributingLineCount: 0 },
    amortized: { total: BigInt(0), contributingLineCount: 0 },
    list: { total: BigInt(0), contributingLineCount: 0 },
    contracted: { total: BigInt(0), contributingLineCount: 0 },
    public: { total: BigInt(0), contributingLineCount: 0 },
  };
}

function newAggregate(): MutableAggregate {
  return { lineCount: 0, costs: newCosts() };
}

function addLineToAggregate(
  aggregate: MutableAggregate,
  line: CanonicalCurLine,
): void {
  aggregate.lineCount += 1;
  for (const basis of FINOPS_CUDOS_COST_BASES) {
    const value = costValue(line, basis);
    if (value === null) continue;
    aggregate.costs[basis].total += BigInt(value);
    aggregate.costs[basis].contributingLineCount += 1;
  }
}

function costCoverage(
  contributingLineCount: number,
  lineCount: number,
): FinopsCudosCoverage {
  if (lineCount === 0) return "complete";
  if (contributingLineCount === 0) return "unavailable";
  return contributingLineCount === lineCount ? "complete" : "partial";
}

function materializeCosts(
  aggregate: MutableAggregate,
): readonly FinopsCudosCostSummary[] {
  return FINOPS_CUDOS_COST_BASES.map((basis) => {
    const value = aggregate.costs[basis];
    return {
      basis,
      totalMicros: aggregate.lineCount === 0
        ? "0"
        : value.contributingLineCount === 0
          ? null
          : value.total.toString(),
      contributingLineCount: value.contributingLineCount,
      missingLineCount: aggregate.lineCount - value.contributingLineCount,
      coverage: costCoverage(value.contributingLineCount, aggregate.lineCount),
    };
  });
}

function selectedCost(
  aggregate: MutableAggregate,
  basis: FinopsCudosCostBasis,
): string | null {
  const selected = aggregate.costs[basis];
  return selected.contributingLineCount === 0
    ? null
    : selected.total.toString();
}

function newCharge(): MutableCharge {
  return {
    ...newAggregate(),
    sourceChargeKinds: new Set<CurChargeKind>(),
  };
}

function newExecutive(): MutableExecutive {
  return {
    ...newAggregate(),
    accounts: new Set<string>(),
    services: new Set<string>(),
    regions: new Set<string>(),
    resources: new Set<string>(),
    charges: {
      usage: newCharge(),
      purchase: newCharge(),
      tax: newCharge(),
      credit: newCharge(),
      refund: newCharge(),
      fee: newCharge(),
      discount: newCharge(),
      adjustment: newCharge(),
      other: newCharge(),
    },
  };
}

function chargeDisclosureKind(line: CanonicalCurLine): FinopsCudosChargeKind {
  if (line.chargeKind !== "purchase") return line.chargeKind;
  const text = [
    line.chargeCategory,
    line.chargeDescription,
    line.chargeFrequency,
    line.commitmentCategory,
  ].filter((value): value is string => value !== null)
    .join(" ")
    .toLowerCase();
  return text.includes("fee") || text.includes("support")
    ? "fee"
    : "purchase";
}

function includesAny(text: string, needles: readonly string[]): boolean {
  return needles.some((needle) => text.includes(needle));
}

function evidenceText(line: CanonicalCurLine): string {
  return [
    line.service,
    line.productCode,
    line.productName,
    line.productFamily,
    line.serviceCategory,
    line.serviceSubcategory,
    line.usageType,
    line.operation,
    line.resourceType,
  ].filter((value): value is string => value !== null)
    .join(" ")
    .toLowerCase();
}

function matchingModules(line: CanonicalCurLine): readonly FinopsCudosModuleId[] {
  const text = evidenceText(line);
  return FINOPS_CUDOS_MODULE_IDS.filter((moduleId) =>
    MODULE_MATCHERS[moduleId](text));
}

function boundedLineIds(
  rows: readonly CanonicalCurLine[],
  limit: number,
): {
  readonly count: number;
  readonly ids: readonly string[];
  readonly truncated: boolean;
} {
  const ids = [...new Set(rows.map(({ lineItemId }) => lineItemId))]
    .sort(compareText);
  return {
    count: ids.length,
    ids: ids.slice(0, limit),
    truncated: ids.length > limit,
  };
}

function availability(
  available: number,
  total: number,
): FinopsCudosCoverage {
  if (total === 0 || available === 0) return "unavailable";
  return available === total ? "complete" : "partial";
}

function isHourly(line: CanonicalCurLine): boolean {
  if (line.usageEndIso === null || !validIso(line.usageEndIso)) return false;
  const start = Date.parse(line.usageStartIso);
  const end = Date.parse(line.usageEndIso);
  return end > start && end - start <= 60 * 60 * 1_000;
}

function lineComparator(
  left: ScopedCanonicalBillingRow,
  right: ScopedCanonicalBillingRow,
): number {
  return compareText(left.line.lineItemId, right.line.lineItemId)
    || compareText(left.line.currency, right.line.currency)
    || compareText(left.line.usageStartIso, right.line.usageStartIso)
    || compareText(left.line.service, right.line.service);
}

function ratioBasisPoints(
  numerator: bigint,
  denominator: bigint,
): string | null {
  if (
    numerator < BigInt(0)
    || denominator <= BigInt(0)
    || numerator > denominator
  ) return null;
  return ((numerator * BigInt(10_000)) / denominator).toString();
}

function isCommitted(line: CanonicalCurLine): boolean {
  const value = (line.commitmentType ?? "").toLowerCase();
  return value.includes("reserved")
    || value.includes("savings")
    || value.includes("commitment");
}

function isOnDemand(line: CanonicalCurLine): boolean {
  const value = (line.commitmentType ?? "").toLowerCase();
  return value === "on_demand"
    || value === "ondemand"
    || value.includes("on demand");
}

function isSpot(line: CanonicalCurLine): boolean {
  return (line.commitmentType ?? "").toLowerCase().includes("spot");
}

function explicitUnused(line: CanonicalCurLine): boolean {
  const text = [
    line.chargeCategory,
    line.chargeDescription,
    line.commitmentStatus,
    line.usageType,
  ].filter((value): value is string => value !== null)
    .join(" ")
    .toLowerCase();
  return text.includes("unused");
}

function commitmentEligibleService(line: CanonicalCurLine): boolean {
  const modules = matchingModules(line);
  return modules.includes("compute")
    || modules.includes("database")
    || modules.includes("dynamodb");
}

function evidenceWindow(
  rows: readonly ScopedCanonicalBillingRow[],
): FinopsCudosEvidence["evidenceWindow"] {
  if (rows.length === 0) return null;
  let from = Number.POSITIVE_INFINITY;
  let to = Number.NEGATIVE_INFINITY;
  for (const { line } of rows) {
    const start = Date.parse(line.usageStartIso);
    const declaredEnd = line.usageEndIso === null
      ? Number.NaN
      : Date.parse(line.usageEndIso);
    const end = Number.isFinite(declaredEnd) && declaredEnd > start
      ? declaredEnd
      : start + 1;
    from = Math.min(from, start);
    to = Math.max(to, end);
  }
  return {
    fromInclusiveIso: new Date(from).toISOString(),
    toExclusiveIso: new Date(to).toISOString(),
    derivedFrom: "canonical_usage_intervals",
  };
}

function rankingComparator(
  basis: FinopsCudosCostBasis,
): (left: MutableRanking, right: MutableRanking) => number {
  return (left, right) => {
    const leftCost = left.costs[basis];
    const rightCost = right.costs[basis];
    const leftMissing = leftCost.contributingLineCount === 0;
    const rightMissing = rightCost.contributingLineCount === 0;
    if (leftMissing !== rightMissing) return leftMissing ? 1 : -1;
    if (leftCost.total !== rightCost.total) {
      return leftCost.total > rightCost.total ? -1 : 1;
    }
    return compareNullableText(left.value, right.value)
      || compareNullableText(left.label, right.label);
  };
}

function materializeRankings(
  grouped: ReadonlyMap<string, MutableRanking>,
  dimension: FinopsCudosRankingDimension,
  basis: FinopsCudosCostBasis,
  limit: number,
): readonly FinopsCudosRankingEntry[] {
  const byCurrency = new Map<string, MutableRanking[]>();
  for (const entry of grouped.values()) {
    const current = byCurrency.get(entry.currency) ?? [];
    current.push(entry);
    byCurrency.set(entry.currency, current);
  }
  const result: FinopsCudosRankingEntry[] = [];
  for (const [currency, entries] of [...byCurrency.entries()]
    .sort(([left], [right]) => compareText(left, right))) {
    entries.sort(rankingComparator(basis));
    entries.slice(0, limit).forEach((entry, index) => {
      result.push({
        currency,
        dimension,
        rank: index + 1,
        value: entry.value,
        label: entry.label,
        lineCount: entry.lineCount,
        selectedCostBasis: basis,
        selectedTotalMicros: selectedCost(entry, basis),
        costs: materializeCosts(entry),
      });
    });
  }
  return result;
}

function sourceFormats(
  rows: readonly ScopedCanonicalBillingRow[],
): FinopsCudosEvidence["sourceFormats"] {
  const counts = new Map<string, {
    sourceFormat: CanonicalCurLine["sourceFormat"];
    sourceVersion: CanonicalCurLine["sourceVersion"];
    lineCount: number;
  }>();
  for (const { line } of rows) {
    const key = `${line.sourceFormat}\0${line.sourceVersion}`;
    const current = counts.get(key) ?? {
      sourceFormat: line.sourceFormat,
      sourceVersion: line.sourceVersion,
      lineCount: 0,
    };
    current.lineCount += 1;
    counts.set(key, current);
  }
  return [...counts.values()].sort((left, right) =>
    compareText(left.sourceFormat, right.sourceFormat)
    || compareText(left.sourceVersion, right.sourceVersion));
}

function buildCommitmentSummary(
  currency: string,
  rows: readonly CanonicalCurLine[],
  basis: FinopsCudosCostBasis,
): FinopsCudosCommitmentSummary {
  let covered = BigInt(0);
  let classifiedEligible = BigInt(0);
  let coveredLineCount = 0;
  let onDemandLineCount = 0;
  let excludedSpotLineCount = 0;
  let unknownClassificationLineCount = 0;
  let coverageMissingCost = 0;

  let applied = BigInt(0);
  let unused = BigInt(0);
  let fees = BigInt(0);
  let appliedLineCount = 0;
  let unusedLineCount = 0;
  let feeLineCount = 0;
  let utilizationMissingCost = 0;

  const commitmentRows = rows.filter((line) =>
    isCommitted(line) || line.commitmentId !== null);
  let missingUnblended = 0;
  let missingAmortized = 0;
  let unblended = BigInt(0);
  let amortized = BigInt(0);

  for (const line of rows) {
    if (
      line.chargeKind === "usage"
      && commitmentEligibleService(line)
    ) {
      if (isSpot(line)) {
        excludedSpotLineCount += 1;
      } else if (isCommitted(line) || isOnDemand(line)) {
        const value = costValue(line, basis);
        if (value === null) {
          coverageMissingCost += 1;
        } else {
          classifiedEligible += BigInt(value);
          if (isCommitted(line)) covered += BigInt(value);
        }
        if (isCommitted(line)) coveredLineCount += 1;
        else onDemandLineCount += 1;
      } else {
        unknownClassificationLineCount += 1;
      }
    }

    if (isCommitted(line) || line.commitmentId !== null) {
      const value = costValue(line, basis);
      if (value === null) {
        utilizationMissingCost += 1;
      } else if (explicitUnused(line)) {
        unused += BigInt(value);
        unusedLineCount += 1;
      } else if (line.chargeKind === "usage") {
        applied += BigInt(value);
        appliedLineCount += 1;
      } else if (chargeDisclosureKind(line) === "fee") {
        fees += BigInt(value);
        feeLineCount += 1;
      }
    }
  }

  for (const line of commitmentRows) {
    if (!INTEGER_MICROS.test(line.amountMicros)) {
      missingUnblended += 1;
    } else {
      unblended += BigInt(line.amountMicros);
    }
    if (line.amortizedMicros === null) {
      missingAmortized += 1;
    } else {
      amortized += BigInt(line.amortizedMicros);
    }
  }

  const coverageReasons: string[] = [];
  if (unknownClassificationLineCount > 0) {
    coverageReasons.push("eligible_usage_missing_commitment_classification");
  }
  if (coverageMissingCost > 0) {
    coverageReasons.push("eligible_usage_missing_selected_cost_basis");
  }
  if (classifiedEligible <= BigInt(0)) {
    coverageReasons.push("no_positive_classified_eligible_cost");
  }
  const coverageStatus: FinopsCudosCoverage =
    coveredLineCount + onDemandLineCount === 0
      && unknownClassificationLineCount === 0
      ? "unavailable"
      : coverageReasons.length === 0
        ? "complete"
        : "partial";

  const utilizationReasons: string[] = [];
  if (commitmentRows.length === 0) {
    utilizationReasons.push("no_commitment_evidence");
  }
  if (unusedLineCount === 0) {
    utilizationReasons.push("no_explicit_unused_commitment_line");
  }
  if (utilizationMissingCost > 0) {
    utilizationReasons.push("commitment_line_missing_selected_cost_basis");
  }
  const utilizationDenominator = applied + unused;
  const utilizationStatus: FinopsCudosCoverage =
    commitmentRows.length === 0
      ? "unavailable"
      : utilizationReasons.length === 0
        ? "complete"
        : "partial";

  return {
    currency,
    costBasis: basis,
    coverage: {
      status: coverageStatus,
      coveredCostMicros: covered.toString(),
      classifiedEligibleCostMicros: classifiedEligible.toString(),
      coverageBasisPoints: coverageStatus === "complete"
        ? ratioBasisPoints(covered, classifiedEligible)
        : null,
      coveredLineCount,
      onDemandLineCount,
      excludedSpotLineCount,
      unknownClassificationLineCount,
      missingCostLineCount: coverageMissingCost,
      incompleteReasons: coverageReasons,
    },
    utilization: {
      status: utilizationStatus,
      appliedUsageCostMicros: applied.toString(),
      explicitUnusedCostMicros: unused.toString(),
      commitmentFeeCostMicros: fees.toString(),
      utilizationBasisPoints: utilizationStatus === "complete"
        ? ratioBasisPoints(applied, utilizationDenominator)
        : null,
      appliedUsageLineCount: appliedLineCount,
      explicitUnusedLineCount: unusedLineCount,
      commitmentFeeLineCount: feeLineCount,
      missingCostLineCount: utilizationMissingCost,
      incompleteReasons: utilizationReasons,
    },
    trueUp: {
      status: commitmentRows.length === 0
        ? "unavailable"
        : missingUnblended === 0 && missingAmortized === 0
          ? "complete"
          : "partial",
      amortizedMinusUnblendedMicros:
        commitmentRows.length > 0
        && missingUnblended === 0
        && missingAmortized === 0
          ? (amortized - unblended).toString()
          : null,
      commitmentLineCount: commitmentRows.length,
      missingUnblendedLineCount: missingUnblended,
      missingAmortizedLineCount: missingAmortized,
    },
  };
}

function opportunityComparator(
  left: MutableOpportunity,
  right: MutableOpportunity,
): number {
  const leftAbs = left.total < BigInt(0) ? -left.total : left.total;
  const rightAbs = right.total < BigInt(0) ? -right.total : right.total;
  if (leftAbs !== rightAbs) return leftAbs > rightAbs ? -1 : 1;
  return compareText(left.currency, right.currency)
    || compareText(left.ruleId, right.ruleId)
    || compareText(left.subjectId, right.subjectId)
    || compareText(left.accountId, right.accountId)
    || compareText(left.service, right.service);
}

function materializeOpportunity(
  candidate: MutableOpportunity,
  basis: FinopsCudosCostBasis,
  window: NonNullable<FinopsCudosEvidence["evidenceWindow"]>,
): FinopsCudosOpportunityEstimate {
  const source = boundedLineIds(candidate.rows, MAX_SOURCE_LINE_IDS);
  const common = {
    ruleVersion: "1.0.0" as const,
    classification: "cur_derived_review_candidate" as const,
    subjectType: candidate.subjectType,
    subjectId: candidate.subjectId,
    accountId: candidate.accountId,
    region: candidate.region,
    service: candidate.service,
    currency: candidate.currency,
    evidenceWindow: window,
    estimate: {
      type: "observed_cost_exposure" as const,
      costBasis: basis,
      totalMicros: candidate.total.toString(),
      isSavingsClaim: false as const,
    },
    sourceLineIdCount: source.count,
    sourceLineIds: source.ids,
    sourceLineIdsTruncated: source.truncated,
    remediationClaim: null,
    reviewRequired: true as const,
  };
  switch (candidate.ruleId) {
    case "CUDOS_CUR_ON_DEMAND_COST_EXPOSURE":
      return {
        ruleId: candidate.ruleId,
        ...common,
        assumptions: [
          "The source explicitly classifies these usage lines as On-Demand.",
          "Observed cost exposure is not a commitment-purchase or savings recommendation.",
          "Compatibility, hourly demand stability, and future demand are not inferred.",
        ],
        confidence: candidate.subjectType === "resource" ? "high" : "medium",
      };
    case "CUDOS_CUR_EXPLICIT_UNUSED_COMMITMENT":
      return {
        ruleId: candidate.ruleId,
        ...common,
        assumptions: [
          "At least one source field explicitly contains an unused-commitment classification.",
          "The signed observed charge is preserved and is not represented as achievable savings.",
          "Purchase modification or termination eligibility is not inferred.",
        ],
        confidence: "high",
      };
    case "CUDOS_CUR_NO_POSITIVE_USAGE_RESOURCE_PATTERN":
      return {
        ruleId: candidate.ruleId,
        ...common,
        assumptions: [
          "The resource has positive observed cost and no positive billed usage quantity in this evidence window.",
          "Billing quantities are not runtime telemetry and may omit meaningful activity.",
          "This low-confidence pattern requires service-owner validation before any action.",
        ],
        confidence: "low",
      };
  }
}

function addOpportunity(
  grouped: Map<string, MutableOpportunity>,
  ruleId: FinopsCudosOpportunityRuleId,
  subjectType: FinopsCudosOpportunityEstimate["subjectType"],
  subjectId: string,
  line: CanonicalCurLine,
  basis: FinopsCudosCostBasis,
): MutableOpportunity {
  const key = JSON.stringify([
    ruleId,
    subjectType,
    subjectId,
    line.usageAccountId,
    line.region,
    line.service,
    line.currency,
  ]);
  let candidate = grouped.get(key);
  if (candidate === undefined) {
    candidate = {
      ruleId,
      subjectType,
      subjectId,
      accountId: line.usageAccountId,
      region: line.region,
      service: line.service,
      currency: line.currency,
      rows: [],
      total: BigInt(0),
      allSelectedCostsPresent: true,
    };
    grouped.set(key, candidate);
  }
  candidate.rows.push(line);
  const cost = costValue(line, basis);
  if (cost === null) candidate.allSelectedCostsPresent = false;
  else candidate.total += BigInt(cost);
  return candidate;
}

/**
 * Build the bounded Foundational CUDOS engine result for exactly one active,
 * reconciled scope. Callers must not merge results from different scopes.
 */
export function buildFinopsCudosDashboard(
  input: FinopsCudosInput,
): FinopsCudosResult {
  if (
    !isRecord(input)
    || Object.keys(input).some((key) => !INPUT_KEYS.has(key))
    || !validScope(input.scope)
  ) return fail("INVALID_SCOPE", "scope");
  const options = normalizeOptions(input.options);
  if ("ok" in options) return options;
  if (!Array.isArray(input.rows)) {
    return fail("INVALID_CANONICAL_ROW", "rows");
  }
  if (input.rows.length > MAX_ROWS) {
    return fail("ROW_LIMIT_EXCEEDED", "rows");
  }

  const seenLineIds = new Set<string>();
  for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex += 1) {
    const row = input.rows[rowIndex];
    if (!isRecord(row) || !validScope(row) || !sameScope(input.scope, row)) {
      return fail("ROW_SCOPE_MISMATCH", `rows[${rowIndex}].scope`, rowIndex);
    }
    if (
      isRecord(row.line)
      && typeof row.line.currency === "string"
      && !FINOPS_RECONCILIATION_CURRENCIES.has(
        row.line.currency as (
          typeof FINOPS_RECONCILIATION_CURRENCIES extends Set<infer T> ? T : never
        ),
      )
    ) return fail("UNKNOWN_CURRENCY", `rows[${rowIndex}].line.currency`, rowIndex);
    if (!validCanonicalLine(row.line)) {
      return fail("INVALID_CANONICAL_ROW", `rows[${rowIndex}].line`, rowIndex);
    }
    const identity = `${row.line.sourceFormat}\0${row.line.sourceVersion}\0${row.line.lineItemId}`;
    if (seenLineIds.has(identity)) {
      return fail(
        "DUPLICATE_LINE_ITEM_ID",
        `rows[${rowIndex}].line.lineItemId`,
        rowIndex,
      );
    }
    seenLineIds.add(identity);
  }

  const rows = [...input.rows].sort(lineComparator);
  const window = evidenceWindow(rows);
  const executives = new Map<string, MutableExecutive>();
  const daily = new Map<string, MutableAggregate & {
    readonly currency: string;
    readonly period: string;
  }>();
  const monthly = new Map<string, MutableAggregate & {
    readonly currency: string;
    readonly period: string;
  }>();
  const accountRankings = new Map<string, MutableRanking>();
  const serviceRankings = new Map<string, MutableRanking>();
  const regionRankings = new Map<string, MutableRanking>();
  const modules = new Map<FinopsCudosModuleId, MutableModule>();
  const unitCosts = new Map<string, MutableUnitCost>();
  const opportunityCandidates = new Map<string, MutableOpportunity>();
  const noUsageResources = new Map<string, {
    readonly rows: CanonicalCurLine[];
    hasPositiveUsage: boolean;
    total: bigint;
    allCostsPresent: boolean;
  }>();

  const boundedMap = (currentSize: number): FinopsCudosResult | null =>
    currentSize > MAX_BUCKETS
      ? fail("BUCKET_LIMIT_EXCEEDED", "buckets")
      : null;

  for (const { line } of rows) {
    let executive = executives.get(line.currency);
    if (executive === undefined) {
      executive = newExecutive();
      executives.set(line.currency, executive);
    }
    addLineToAggregate(executive, line);
    executive.accounts.add(line.usageAccountId);
    executive.services.add(line.service);
    if (line.region !== null) executive.regions.add(line.region);
    if (line.resourceId !== null) executive.resources.add(line.resourceId);
    const disclosureKind = chargeDisclosureKind(line);
    const disclosure = executive.charges[disclosureKind];
    addLineToAggregate(disclosure, line);
    disclosure.sourceChargeKinds.add(line.chargeKind);

    const day = new Date(line.usageStartIso).toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const dailyKey = `${line.currency}\0${day}`;
    const monthlyKey = `${line.currency}\0${month}`;
    let dailyBucket = daily.get(dailyKey);
    if (dailyBucket === undefined) {
      dailyBucket = {
        ...newAggregate(),
        currency: line.currency,
        period: day,
      };
      daily.set(dailyKey, dailyBucket);
    }
    addLineToAggregate(dailyBucket, line);
    let monthlyBucket = monthly.get(monthlyKey);
    if (monthlyBucket === undefined) {
      monthlyBucket = {
        ...newAggregate(),
        currency: line.currency,
        period: month,
      };
      monthly.set(monthlyKey, monthlyBucket);
    }
    addLineToAggregate(monthlyBucket, line);

    const rankingInputs: readonly [
      Map<string, MutableRanking>,
      FinopsCudosRankingDimension,
      string | null,
      string | null,
    ][] = [
      [
        accountRankings,
        "account",
        line.usageAccountId,
        line.usageAccountName,
      ],
      [serviceRankings, "service", line.service, line.productName],
      [regionRankings, "region", line.region, line.region],
    ];
    for (const [map, dimension, value, label] of rankingInputs) {
      const key = JSON.stringify([line.currency, dimension, value, label]);
      let bucket = map.get(key);
      if (bucket === undefined) {
        bucket = {
          ...newAggregate(),
          currency: line.currency,
          value,
          label,
        };
        map.set(key, bucket);
      }
      addLineToAggregate(bucket, line);
    }

    for (const moduleId of matchingModules(line)) {
      let moduleBucket = modules.get(moduleId);
      if (moduleBucket === undefined) {
        moduleBucket = {
          lineCount: 0,
          rows: [],
          services: new Set<string>(),
          currencies: new Map<string, MutableAggregate>(),
        };
        modules.set(moduleId, moduleBucket);
      }
      moduleBucket.lineCount += 1;
      moduleBucket.rows.push(line);
      moduleBucket.services.add(line.service);
      let currency = moduleBucket.currencies.get(line.currency);
      if (currency === undefined) {
        currency = newAggregate();
        moduleBucket.currencies.set(line.currency, currency);
      }
      addLineToAggregate(currency, line);
    }

    if (
      line.usageAmountMicros !== null
      && line.usageUnit !== null
    ) {
      const key = JSON.stringify([line.currency, line.service, line.usageUnit]);
      let metric = unitCosts.get(key);
      if (metric === undefined) {
        metric = {
          ...newAggregate(),
          currency: line.currency,
          service: line.service,
          usageUnit: line.usageUnit,
          usageQuantity: BigInt(0),
        };
        unitCosts.set(key, metric);
      }
      addLineToAggregate(metric, line);
      metric.usageQuantity += BigInt(line.usageAmountMicros);
    }

    if (
      line.chargeKind === "usage"
      && isOnDemand(line)
      && (costValue(line, options.costBasis) !== null)
    ) {
      addOpportunity(
        opportunityCandidates,
        "CUDOS_CUR_ON_DEMAND_COST_EXPOSURE",
        line.resourceId === null ? "service" : "resource",
        line.resourceId ?? line.service,
        line,
        options.costBasis,
      );
    }
    if (explicitUnused(line) && (isCommitted(line) || line.commitmentId !== null)) {
      addOpportunity(
        opportunityCandidates,
        "CUDOS_CUR_EXPLICIT_UNUSED_COMMITMENT",
        "commitment",
        line.commitmentId ?? line.commitmentType ?? "unknown-commitment",
        line,
        options.costBasis,
      );
    }
    if (line.resourceId !== null) {
      const key = JSON.stringify([
        line.resourceId,
        line.usageAccountId,
        line.region,
        line.service,
        line.currency,
      ]);
      let candidate = noUsageResources.get(key);
      if (candidate === undefined) {
        candidate = {
          rows: [],
          hasPositiveUsage: false,
          total: BigInt(0),
          allCostsPresent: true,
        };
        noUsageResources.set(key, candidate);
      }
      candidate.rows.push(line);
      if (
        line.usageAmountMicros !== null
        && BigInt(line.usageAmountMicros) > BigInt(0)
      ) candidate.hasPositiveUsage = true;
      const cost = costValue(line, options.costBasis);
      if (cost === null) candidate.allCostsPresent = false;
      else candidate.total += BigInt(cost);
    }

    const totalBucketCount = daily.size
      + monthly.size
      + accountRankings.size
      + serviceRankings.size
      + regionRankings.size
      + unitCosts.size
      + noUsageResources.size
      + opportunityCandidates.size;
    const overflow = boundedMap(totalBucketCount);
    if (overflow !== null) return overflow;
  }

  for (const candidate of noUsageResources.values()) {
    if (
      candidate.hasPositiveUsage
      || !candidate.allCostsPresent
      || candidate.total <= BigInt(0)
      || candidate.rows.length === 0
    ) continue;
    const first = candidate.rows[0];
    const grouped = addOpportunity(
      opportunityCandidates,
      "CUDOS_CUR_NO_POSITIVE_USAGE_RESOURCE_PATTERN",
      "resource",
      first.resourceId ?? "unknown-resource",
      first,
      options.costBasis,
    );
    grouped.rows.length = 0;
    grouped.rows.push(...candidate.rows);
    grouped.total = candidate.total;
    grouped.allSelectedCostsPresent = candidate.allCostsPresent;
  }

  const executive = [...executives.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([currency, value]): FinopsCudosCurrencyExecutiveSummary => ({
      currency,
      lineCount: value.lineCount,
      accountCount: value.accounts.size,
      serviceCount: value.services.size,
      regionCount: value.regions.size,
      resourceCount: value.resources.size,
      costs: materializeCosts(value),
      chargeKinds: FINOPS_CUDOS_CHARGE_KINDS.map((chargeKind) => {
        const disclosure = value.charges[chargeKind];
        return {
          chargeKind,
          present: disclosure.lineCount > 0,
          lineCount: disclosure.lineCount,
          sourceChargeKinds: [...disclosure.sourceChargeKinds].sort(compareText),
          costs: materializeCosts(disclosure),
        };
      }),
    }));

  const materializeTrend = (
    grouped: ReadonlyMap<string, MutableAggregate & {
      readonly currency: string;
      readonly period: string;
    }>,
  ): readonly FinopsCudosTrendBucket[] =>
    [...grouped.values()]
      .sort((left, right) =>
        compareText(left.currency, right.currency)
        || compareText(left.period, right.period))
      .map((bucket) => ({
        currency: bucket.currency,
        period: bucket.period,
        lineCount: bucket.lineCount,
        costs: materializeCosts(bucket),
      }));

  const materializedModules = FINOPS_CUDOS_MODULE_IDS
    .filter((moduleId) => modules.has(moduleId))
    .flatMap((moduleId): readonly FinopsCudosModule[] => {
      const moduleBucket = modules.get(moduleId);
      if (moduleBucket === undefined) return [];
      const source = boundedLineIds(
        moduleBucket.rows,
        MAX_MODULE_SOURCE_LINE_IDS,
      );
      return [{
        moduleId,
        lineCount: moduleBucket.lineCount,
        services: [...moduleBucket.services].sort(compareText),
        sourceLineIdCount: source.count,
        sourceLineIds: source.ids,
        sourceLineIdsTruncated: source.truncated,
        currencies: [...moduleBucket.currencies.entries()]
          .sort(([left], [right]) => compareText(left, right))
          .map(([currency, aggregate]) => ({
            currency,
            lineCount: aggregate.lineCount,
            costs: materializeCosts(aggregate),
          })),
      }];
    });

  const resourceLineCount = rows.filter(({ line }) =>
    line.resourceId !== null).length;
  const hourlyLineCount = rows.filter(({ line }) => isHourly(line)).length;
  const resourceHourlyLineCount = rows.filter(({ line }) =>
    line.resourceId !== null && isHourly(line)).length;

  const materializedUnitCosts = [...unitCosts.values()]
    .sort((left, right) =>
      compareText(left.currency, right.currency)
      || compareText(left.service, right.service)
      || compareText(left.usageUnit, right.usageUnit))
    .map((metric): FinopsCudosUnitCostMetric => {
      const costIndex = FINOPS_CUDOS_COST_BASES.indexOf(options.costBasis);
      const cost = materializeCosts(metric)[costIndex];
      const completeCost = cost.coverage === "complete"
        && cost.totalMicros !== null;
      const positiveUsage = metric.usageQuantity > BigInt(0);
      return {
        currency: metric.currency,
        service: metric.service,
        usageUnit: metric.usageUnit,
        lineCount: metric.lineCount,
        costBasis: options.costBasis,
        cost,
        usageQuantityMicros: metric.usageQuantity.toString(),
        exactRatio: completeCost && positiveUsage
          ? {
              costMicrosNumerator: cost.totalMicros ?? "0",
              usageQuantityMicrosDenominator: metric.usageQuantity.toString(),
            }
          : null,
        unavailableReason: !completeCost
          ? "missing_cost_basis"
          : !positiveUsage
            ? "non_positive_usage_quantity"
            : null,
      };
    });

  const rowsByCurrency = new Map<string, CanonicalCurLine[]>();
  for (const { line } of rows) {
    const current = rowsByCurrency.get(line.currency) ?? [];
    current.push(line);
    rowsByCurrency.set(line.currency, current);
  }
  const commitments = [...rowsByCurrency.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([currency, currencyRows]) =>
      buildCommitmentSummary(currency, currencyRows, options.costBasis));

  const opportunities = window === null
    ? []
    : [...opportunityCandidates.values()]
      .filter((candidate) =>
        candidate.allSelectedCostsPresent && candidate.total !== BigInt(0))
      .sort(opportunityComparator)
      .map((candidate) =>
        materializeOpportunity(candidate, options.costBasis, window));

  return {
    ok: true,
    schema: "sutra.finops-cudos.v1",
    evidence: {
      organizationId: input.scope.organizationId,
      customerId: input.scope.customerId,
      connectionId: input.scope.connectionId,
      exportName: input.scope.exportName,
      billingPeriod: input.scope.billingPeriod,
      generationId: input.scope.generationId,
      activeLineCount: rows.length,
      sourceFormats: sourceFormats(rows),
      currencies: [...executives.keys()].sort(compareText),
      evidenceWindow: window,
    },
    selectedCostBasis: options.costBasis,
    executive,
    trends: {
      daily: materializeTrend(daily),
      monthly: materializeTrend(monthly),
    },
    rankings: {
      accounts: materializeRankings(
        accountRankings,
        "account",
        options.costBasis,
        options.rankingLimit,
      ),
      services: materializeRankings(
        serviceRankings,
        "service",
        options.costBasis,
        options.rankingLimit,
      ),
      regions: materializeRankings(
        regionRankings,
        "region",
        options.costBasis,
        options.rankingLimit,
      ),
    },
    commitments,
    modules: materializedModules,
    drilldowns: {
      lineCount: rows.length,
      resource: {
        status: availability(resourceLineCount, rows.length),
        availableLineCount: resourceLineCount,
        missingLineCount: rows.length - resourceLineCount,
      },
      hourly: {
        status: availability(hourlyLineCount, rows.length),
        availableLineCount: hourlyLineCount,
        missingLineCount: rows.length - hourlyLineCount,
      },
      resourceHourly: {
        status: availability(resourceHourlyLineCount, rows.length),
        availableLineCount: resourceHourlyLineCount,
        missingLineCount: rows.length - resourceHourlyLineCount,
      },
    },
    unitCosts: {
      metrics: materializedUnitCosts.slice(0, MAX_UNIT_COST_METRICS),
      totalMetrics: materializedUnitCosts.length,
      truncated: materializedUnitCosts.length > MAX_UNIT_COST_METRICS,
      invariant: "currencies_and_usage_units_are_never_combined",
    },
    opportunities: {
      estimates: opportunities.slice(0, options.opportunityLimit),
      totalCandidates: opportunities.length,
      truncated: opportunities.length > options.opportunityLimit,
      disclaimer:
        "CUR-derived review candidates are observed billing patterns, not telemetry, " +
        "savings, compatibility, purchase, or remediation recommendations.",
    },
    failures: [],
  };
}

/** Compact alias for callers that already name the selected dashboard. */
export const buildFinopsCudos = buildFinopsCudosDashboard;
