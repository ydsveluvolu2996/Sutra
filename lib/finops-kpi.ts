/**
 * Evidence-honest Foundational KPI engine over one canonical active generation.
 *
 * The engine is intentionally pure: it does not discover inventory, prices,
 * compatibility, or purchase options. CUR-derived classifications are
 * candidates/estimates that require validation. Currencies and usage units are
 * independent measurement segments and all arithmetic uses BigInt micro-units.
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
const INTEGER = /^-?(?:0|[1-9]\d{0,127})$/u;
const MAX_ROWS = 250_000;
const MAX_GOALS = 2_000;
const MAX_AGE_EVIDENCE = 250_000;
const MAX_ASSUMPTIONS = 2_000;
const DEFAULT_MAX_OPPORTUNITIES = 1_000;
const MAX_OPPORTUNITIES = 5_000;
const RATIO_DENOMINATOR = BigInt(10_000);
const SNAPSHOT_AGE_DAYS = 90;

export const FINOPS_KPI_IDS = [
  "ec2_previous_generation",
  "ec2_spot_share",
  "ec2_graviton_share",
  "ec2_amd_share",
  "ebs_gp3_adoption",
  "aged_snapshots",
  "s3_standard_concentration",
  "rds_graviton_share",
  "rds_open_source_engine_share",
  "elasticache_graviton_share",
  "opensearch_graviton_share",
  "lambda_graviton_share",
  "compute_on_demand_ratio",
  "sagemaker_on_demand_ratio",
  "rds_on_demand_ratio",
  "elasticache_on_demand_ratio",
  "opensearch_on_demand_ratio",
  "redshift_on_demand_ratio",
  "dynamodb_on_demand_ratio",
] as const;

export type FinopsKpiId = typeof FINOPS_KPI_IDS[number];
export type FinopsKpiDirection = "higher_is_better" | "lower_is_better";

export interface FinopsKpiFormula {
  readonly id: FinopsKpiId;
  readonly formulaVersion: "1.0.0";
  readonly label: string;
  readonly numeratorDefinition: string;
  readonly denominatorDefinition: string;
  readonly targetDirection: FinopsKpiDirection;
  readonly authoritativeEvidenceRequired: boolean;
  readonly curClassification: "candidate_estimate";
}

export const FINOPS_KPI_FORMULAS: readonly FinopsKpiFormula[] = [
  {
    id: "ec2_previous_generation",
    formulaVersion: "1.0.0",
    label: "EC2 previous-generation share",
    numeratorDefinition: "Classifiable EC2 instance usage on the versioned previous-generation family set.",
    denominatorDefinition: "Classifiable EC2 instance usage.",
    targetDirection: "lower_is_better",
    authoritativeEvidenceRequired: false,
    curClassification: "candidate_estimate",
  },
  {
    id: "ec2_spot_share",
    formulaVersion: "1.0.0",
    label: "EC2 Spot share",
    numeratorDefinition: "Classifiable EC2 instance usage carrying Spot pricing evidence.",
    denominatorDefinition: "Classifiable EC2 instance usage with a pricing model.",
    targetDirection: "higher_is_better",
    authoritativeEvidenceRequired: false,
    curClassification: "candidate_estimate",
  },
  {
    id: "ec2_graviton_share",
    formulaVersion: "1.0.0",
    label: "EC2 Graviton share",
    numeratorDefinition: "Classifiable EC2 instance usage whose current family is Graviton.",
    denominatorDefinition: "EC2 instance usage with a classifiable processor family.",
    targetDirection: "higher_is_better",
    authoritativeEvidenceRequired: false,
    curClassification: "candidate_estimate",
  },
  {
    id: "ec2_amd_share",
    formulaVersion: "1.0.0",
    label: "EC2 AMD share",
    numeratorDefinition: "Classifiable EC2 instance usage whose current family is AMD.",
    denominatorDefinition: "EC2 instance usage with a classifiable processor family.",
    targetDirection: "higher_is_better",
    authoritativeEvidenceRequired: false,
    curClassification: "candidate_estimate",
  },
  {
    id: "ebs_gp3_adoption",
    formulaVersion: "1.0.0",
    label: "EBS gp3 adoption",
    numeratorDefinition: "Classifiable EBS volume usage on gp3.",
    denominatorDefinition: "Classifiable EBS volume usage.",
    targetDirection: "higher_is_better",
    authoritativeEvidenceRequired: false,
    curClassification: "candidate_estimate",
  },
  {
    id: "aged_snapshots",
    formulaVersion: "1.0.0",
    label: "Aged snapshot share",
    numeratorDefinition: `Snapshot usage backed by authoritative creation evidence at least ${SNAPSHOT_AGE_DAYS} days old.`,
    denominatorDefinition: "Snapshot usage with authoritative creation-age evidence.",
    targetDirection: "lower_is_better",
    authoritativeEvidenceRequired: true,
    curClassification: "candidate_estimate",
  },
  {
    id: "s3_standard_concentration",
    formulaVersion: "1.0.0",
    label: "S3 Standard concentration",
    numeratorDefinition: "Classifiable S3 storage usage in the Standard storage class.",
    denominatorDefinition: "Classifiable S3 storage-class usage.",
    targetDirection: "lower_is_better",
    authoritativeEvidenceRequired: false,
    curClassification: "candidate_estimate",
  },
  {
    id: "rds_graviton_share",
    formulaVersion: "1.0.0",
    label: "RDS Graviton share",
    numeratorDefinition: "Classifiable RDS instance usage whose current family is Graviton.",
    denominatorDefinition: "RDS instance usage with a classifiable processor family.",
    targetDirection: "higher_is_better",
    authoritativeEvidenceRequired: false,
    curClassification: "candidate_estimate",
  },
  {
    id: "rds_open_source_engine_share",
    formulaVersion: "1.0.0",
    label: "RDS open-source engine share",
    numeratorDefinition: "Classifiable RDS usage for Aurora, PostgreSQL, MySQL, or MariaDB.",
    denominatorDefinition: "RDS usage with a classifiable database engine.",
    targetDirection: "higher_is_better",
    authoritativeEvidenceRequired: false,
    curClassification: "candidate_estimate",
  },
  {
    id: "elasticache_graviton_share",
    formulaVersion: "1.0.0",
    label: "ElastiCache Graviton share",
    numeratorDefinition: "Classifiable ElastiCache node usage whose current family is Graviton.",
    denominatorDefinition: "ElastiCache node usage with a classifiable processor family.",
    targetDirection: "higher_is_better",
    authoritativeEvidenceRequired: false,
    curClassification: "candidate_estimate",
  },
  {
    id: "opensearch_graviton_share",
    formulaVersion: "1.0.0",
    label: "OpenSearch Graviton share",
    numeratorDefinition: "Classifiable OpenSearch node usage whose current family is Graviton.",
    denominatorDefinition: "OpenSearch node usage with a classifiable processor family.",
    targetDirection: "higher_is_better",
    authoritativeEvidenceRequired: false,
    curClassification: "candidate_estimate",
  },
  {
    id: "lambda_graviton_share",
    formulaVersion: "1.0.0",
    label: "Lambda Graviton share",
    numeratorDefinition: "Classifiable Lambda usage carrying arm64 architecture evidence.",
    denominatorDefinition: "Lambda usage with classifiable arm64 or x86_64 architecture.",
    targetDirection: "higher_is_better",
    authoritativeEvidenceRequired: false,
    curClassification: "candidate_estimate",
  },
  ...([
    ["compute_on_demand_ratio", "Compute On-Demand ratio", "EC2 compute"],
    ["sagemaker_on_demand_ratio", "SageMaker On-Demand ratio", "SageMaker"],
    ["rds_on_demand_ratio", "RDS On-Demand ratio", "RDS"],
    ["elasticache_on_demand_ratio", "ElastiCache On-Demand ratio", "ElastiCache"],
    ["opensearch_on_demand_ratio", "OpenSearch On-Demand ratio", "OpenSearch"],
    ["redshift_on_demand_ratio", "Redshift On-Demand ratio", "Redshift"],
    ["dynamodb_on_demand_ratio", "DynamoDB On-Demand ratio", "DynamoDB"],
  ] as const).map(([id, label, service]): FinopsKpiFormula => ({
    id,
    formulaVersion: "1.0.0",
    label,
    numeratorDefinition: `Classifiable ${service} usage carrying On-Demand pricing evidence.`,
    denominatorDefinition: `Classifiable ${service} usage with an On-Demand, committed, provisioned, or Spot pricing model.`,
    targetDirection: "lower_is_better",
    authoritativeEvidenceRequired: false,
    curClassification: "candidate_estimate",
  })),
];

export interface FinopsKpiRbacDecisionEvidence {
  readonly decisionId: string;
  readonly decision: "allow" | "deny";
  readonly action: "finops:kpi-goal:write";
  readonly resource: string;
  readonly actorId: string;
  readonly decidedAtIso: string;
  readonly policyVersion: string;
  readonly evidenceReference: string;
}

/**
 * Configuration and independently collected evidence persist across billing
 * deliveries. They are tenant/connection scoped, while canonical billing rows
 * remain bound to one exact export, period, and active generation.
 */
export interface FinopsKpiTenantScope {
  readonly organizationId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

export interface FinopsKpiGoalVersion extends FinopsKpiTenantScope {
  readonly id: string;
  readonly version: number;
  readonly kpiId: FinopsKpiId;
  readonly targetDirection: FinopsKpiDirection;
  readonly targetBasisPoints: number;
  readonly effectiveFromIso: string;
  readonly effectiveToIso: string | null;
  readonly actorId: string;
  readonly auditReference: string;
  readonly rbacDecision: FinopsKpiRbacDecisionEvidence;
}

export interface FinopsKpiResourceAgeEvidence extends FinopsKpiTenantScope {
  readonly resourceId: string;
  readonly createdAtIso: string;
  readonly observedAtIso: string;
  readonly source: "aws_ec2_describe_snapshots";
  readonly sourceEvidenceId: string;
}

export interface FinopsKpiSavingsAssumption extends FinopsKpiTenantScope {
  readonly id: string;
  readonly version: number;
  readonly kpiId: FinopsKpiId;
  readonly currency: string;
  readonly basis: "unblended_cost";
  readonly savingsRateBasisPoints: number;
  readonly effectiveFromIso: string;
  readonly effectiveToIso: string | null;
  readonly sourceReference: string;
  readonly compatibleEvidenceReference: string;
  readonly actorId: string;
  readonly auditReference: string;
}

export interface FinopsKpiInput {
  readonly scope: FinopsReconciliationScope;
  readonly rows: readonly ScopedCanonicalBillingRow[];
  readonly evidenceWindow: {
    readonly startIso: string;
    readonly endIso: string;
    readonly evaluatedAtIso: string;
    readonly sourceEvidenceId: string;
    readonly manifestSha256: string;
  };
  readonly goals?: readonly FinopsKpiGoalVersion[];
  readonly resourceAgeEvidence?: readonly FinopsKpiResourceAgeEvidence[];
  readonly savingsAssumptions?: readonly FinopsKpiSavingsAssumption[];
  readonly maxOpportunities?: number;
}

export type FinopsKpiFailureCode =
  | "INVALID_SCOPE"
  | "INVALID_INPUT"
  | "ROW_LIMIT_EXCEEDED"
  | "ROW_SCOPE_MISMATCH"
  | "INVALID_CANONICAL_ROW"
  | "DUPLICATE_SOURCE_LINE"
  | "INVALID_GOAL"
  | "GOAL_SCOPE_MISMATCH"
  | "GOAL_RBAC_DENIED"
  | "OVERLAPPING_GOALS"
  | "INVALID_RESOURCE_EVIDENCE"
  | "RESOURCE_EVIDENCE_SCOPE_MISMATCH"
  | "INVALID_SAVINGS_ASSUMPTION"
  | "SAVINGS_ASSUMPTION_SCOPE_MISMATCH"
  | "AMBIGUOUS_SAVINGS_ASSUMPTION";

export interface FinopsKpiFailure {
  readonly code: FinopsKpiFailureCode;
  readonly field: string;
  readonly index?: number;
}

export interface FinopsKpiSelectedGoal {
  readonly id: string;
  readonly version: number;
  readonly targetDirection: FinopsKpiDirection;
  readonly targetBasisPoints: number;
  readonly effectiveFromIso: string;
  readonly effectiveToIso: string | null;
  readonly actorId: string;
  readonly auditReference: string;
  readonly rbacDecisionId: string;
  readonly rbacEvidenceReference: string;
}

export interface FinopsKpiMeasurementSegment {
  readonly basis: "usage_quantity" | "unblended_cost";
  readonly currency: string;
  readonly usageUnit: string | null;
  readonly numerator: string;
  readonly denominator: string;
  readonly currentBasisPoints: number;
  readonly ratioRemainder: string;
  readonly ratioDenominator: "10000";
  readonly goalStatus: "met" | "not_met" | "no_goal";
  readonly gapBasisPoints: number | null;
  readonly sourceLineIds: readonly string[];
  readonly sourceLineIdsTruncated: boolean;
}

export interface FinopsKpiMeasurement {
  readonly kpiId: FinopsKpiId;
  readonly formulaVersion: "1.0.0";
  readonly state: "measured" | "missing" | "not_applicable" | "insufficient_evidence";
  readonly findingKind: "candidate_estimate";
  readonly validationRequired: true;
  readonly selectedGoal: FinopsKpiSelectedGoal | null;
  readonly eligibleLineCount: number;
  readonly classifiableLineCount: number;
  readonly unclassifiedLineCount: number;
  readonly evidenceCompleteness: "complete" | "partial" | "none";
  readonly reasonCodes: readonly string[];
  readonly segments: readonly FinopsKpiMeasurementSegment[];
}

export interface FinopsKpiOpportunity {
  readonly kpiId: FinopsKpiId;
  readonly formulaVersion: "1.0.0";
  readonly evidenceWindowStartIso: string;
  readonly evidenceWindowEndIso: string;
  readonly sourceEvidenceId: string;
  readonly sourceLineId: string;
  readonly resourceId: string | null;
  readonly currency: string;
  readonly usageUnit: string | null;
  readonly findingKind: "candidate_estimate";
  readonly confidence: "low" | "medium" | "high";
  readonly validationRequired: true;
  readonly assumptionIds: readonly string[];
  readonly assumptionReferences: readonly string[];
  readonly estimatedSavingsMicros: string | null;
  readonly rateApplicationRemainder: string | null;
  readonly rateDenominator: "10000" | null;
  readonly reasonCode: string;
}

export type FinopsKpiResult =
  | {
      readonly ok: true;
      readonly schema: "sutra.finops-kpi.v1";
      readonly scope: FinopsReconciliationScope;
      readonly formulaRegistry: readonly FinopsKpiFormula[];
      readonly evidenceWindow: FinopsKpiInput["evidenceWindow"];
      readonly measurements: readonly FinopsKpiMeasurement[];
      readonly opportunities: readonly FinopsKpiOpportunity[];
      readonly opportunitiesTruncated: boolean;
      readonly failures: readonly [];
    }
  | {
      readonly ok: false;
      readonly schema: "sutra.finops-kpi.v1";
      readonly failures: readonly FinopsKpiFailure[];
    };

interface Classification {
  readonly eligible: boolean;
  readonly numerator: boolean | null;
  readonly confidence: "low" | "medium" | "high";
  readonly reasonCode: string;
}

interface WeightedLine {
  readonly row: ScopedCanonicalBillingRow;
  readonly basis: "usage_quantity" | "unblended_cost";
  readonly currency: string;
  readonly usageUnit: string | null;
  readonly weight: bigint;
  readonly numerator: boolean;
  readonly confidence: "low" | "medium" | "high";
  readonly reasonCode: string;
}

interface MutableSegment {
  numerator: bigint;
  denominator: bigint;
  readonly sourceLineIds: string[];
}

const KPI_SET = new Set<string>(FINOPS_KPI_IDS);
const FORMULA_BY_ID = new Map(
  FINOPS_KPI_FORMULAS.map((formula) => [formula.id, formula]),
);
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
const PREVIOUS_EC2_FAMILIES = new Set([
  "m1", "m2", "m3", "m4", "c1", "c3", "c4", "r3", "r4", "t1", "t2",
  "i2", "d2", "g2", "p2", "x1",
]);
const GRAVITON_FAMILY = /^(?:a1|[cmrt]\d+g|g5g|im4gn|is4gen|i4g|x2gd|c6gn|c7gn|r6gd|m6gd)$/u;
const AMD_FAMILY = /^(?:[cmrt]\d+a|hpc6a)$/u;
const INSTANCE_FAMILY = /(?:^|[-:/.])([a-z][a-z0-9]*\d[a-z0-9]*)\./iu;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 1_024): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= max
    && !value.includes("\0");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validIso(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validScope(value: unknown): value is FinopsReconciliationScope {
  if (!isRecord(value)) return false;
  return typeof value.organizationId === "string"
    && IDENTIFIER.test(value.organizationId)
    && typeof value.customerId === "string"
    && IDENTIFIER.test(value.customerId)
    && typeof value.connectionId === "string"
    && IDENTIFIER.test(value.connectionId)
    && text(value.exportName, 256)
    && typeof value.billingPeriod === "string"
    && PERIOD.test(value.billingPeriod)
    && typeof value.generationId === "string"
    && GENERATION_ID.test(value.generationId);
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

function validTenantScope(value: unknown): value is FinopsKpiTenantScope {
  if (!isRecord(value)) return false;
  return typeof value.organizationId === "string"
    && IDENTIFIER.test(value.organizationId)
    && typeof value.customerId === "string"
    && IDENTIFIER.test(value.customerId)
    && typeof value.connectionId === "string"
    && IDENTIFIER.test(value.connectionId);
}

function sameTenantScope(
  active: FinopsReconciliationScope,
  candidate: FinopsKpiTenantScope,
): boolean {
  return active.organizationId === candidate.organizationId
    && active.customerId === candidate.customerId
    && active.connectionId === candidate.connectionId;
}

function fail(
  code: FinopsKpiFailureCode,
  field: string,
  index?: number,
): FinopsKpiResult {
  return {
    ok: false,
    schema: "sutra.finops-kpi.v1",
    failures: [{ code, field, ...(index === undefined ? {} : { index }) }],
  };
}

function validCurrency(value: unknown): value is string {
  return typeof value === "string"
    && FINOPS_RECONCILIATION_CURRENCIES.has(
      value as (typeof FINOPS_RECONCILIATION_CURRENCIES extends Set<infer T> ? T : never),
    );
}

function validCanonicalLine(value: unknown): value is CanonicalCurLine {
  if (
    !isRecord(value)
    || !text(value.lineItemId, 4_096)
    || !text(value.service)
    || !text(value.usageAccountId, 256)
    || !text(value.chargeCategory, 512)
    || typeof value.chargeKind !== "string"
    || !CHARGE_KINDS.has(value.chargeKind as CurChargeKind)
    || !validCurrency(value.currency)
    || !validIso(value.usageStartIso)
    || typeof value.amountMicros !== "string"
    || !INTEGER.test(value.amountMicros)
  ) return false;
  if (
    value.usageAmountMicros !== null
    && (
      typeof value.usageAmountMicros !== "string"
      || !INTEGER.test(value.usageAmountMicros)
      || (value.usageUnit !== null && !text(value.usageUnit, 128))
    )
  ) return false;
  return true;
}

function serviceText(line: CanonicalCurLine): string {
  return [
    line.service,
    line.productCode ?? "",
    line.productName ?? "",
    line.productFamily ?? "",
    line.serviceCategory ?? "",
    line.serviceSubcategory ?? "",
  ].join(" ").toLowerCase();
}

function detailText(line: CanonicalCurLine): string {
  return [
    line.usageType ?? "",
    line.operation ?? "",
    line.resourceType ?? "",
    line.productFamily ?? "",
    line.productName ?? "",
    line.pricingCategory ?? "",
    line.pricingTerm ?? "",
  ].join(" ").toLowerCase();
}

function isService(line: CanonicalCurLine, token: string): boolean {
  return serviceText(line).includes(token);
}

function isEc2(line: CanonicalCurLine): boolean {
  const service = serviceText(line);
  return service.includes("amazonec2")
    || service.includes("elastic compute cloud")
    || service === "ec2";
}

function isEbs(line: CanonicalCurLine): boolean {
  const detail = detailText(line);
  return isEc2(line)
    && (
      detail.includes("ebs")
      || detail.includes("volumeusage")
      || (line.resourceId?.startsWith("vol-") ?? false)
    );
}

function isSnapshot(line: CanonicalCurLine): boolean {
  return isEc2(line)
    && (
      detailText(line).includes("snapshot")
      || (line.resourceId?.startsWith("snap-") ?? false)
    );
}

function isEc2Compute(line: CanonicalCurLine): boolean {
  return isEc2(line) && !isEbs(line) && !isSnapshot(line);
}

function instanceFamily(line: CanonicalCurLine): string | null {
  const match = INSTANCE_FAMILY.exec(detailText(line));
  return match?.[1]?.toLowerCase() ?? null;
}

function architecture(line: CanonicalCurLine): "graviton" | "amd" | "other" | null {
  const detail = detailText(line);
  if (detail.includes("arm64") || detail.includes("graviton")) return "graviton";
  if (detail.includes("x86_64") || detail.includes("x86-64")) return "other";
  const family = instanceFamily(line);
  if (family === null) return null;
  if (GRAVITON_FAMILY.test(family)) return "graviton";
  if (AMD_FAMILY.test(family)) return "amd";
  return "other";
}

function pricingModel(
  line: CanonicalCurLine,
  dynamodb = false,
): "on_demand" | "committed" | "spot" | "provisioned" | null {
  const detail = detailText(line);
  if (dynamodb) {
    if (detail.includes("payperrequest") || detail.includes("on-demand")) {
      return "on_demand";
    }
    if (
      detail.includes("readcapacityunit")
      || detail.includes("writecapacityunit")
      || detail.includes("provisioned")
    ) return "provisioned";
  }
  const commitment = line.commitmentType?.toLowerCase() ?? "";
  const pricing = line.pricingTerm?.toLowerCase() ?? "";
  if (
    commitment === "spot"
    || pricing === "spot"
    || line.chargeCategory.toLowerCase() === "spotusage"
  ) return "spot";
  if (
    commitment === "reserved"
    || commitment === "savings_plan"
    || pricing.includes("reserved")
    || pricing.includes("savings")
  ) return "committed";
  if (
    commitment === "on_demand"
    || pricing.includes("ondemand")
    || pricing.includes("on-demand")
    || line.chargeCategory.toLowerCase() === "usage"
  ) return "on_demand";
  return null;
}

function classifyStorageClass(line: CanonicalCurLine): "standard" | "other" | null {
  const detail = detailText(line);
  const storageEvidence = [
    "storage", "bytehrs", "byte-hrs", "timedstorage",
  ].some((token) => detail.includes(token));
  if (!storageEvidence) return null;
  if (
    [
      "standard-ia",
      "standard ia",
      "infrequent",
      "onezone",
      "one zone",
      "glacier",
      "deep archive",
      "intelligent",
      "express",
    ].some((token) => detail.includes(token))
  ) return "other";
  if (detail.includes("standard")) return "standard";
  return null;
}

function databaseEngine(line: CanonicalCurLine): "open_source" | "commercial" | null {
  const detail = detailText(line);
  if (["aurora", "postgres", "mysql", "mariadb"].some((token) => detail.includes(token))) {
    return "open_source";
  }
  if (["oracle", "sqlserver", "sql server"].some((token) => detail.includes(token))) {
    return "commercial";
  }
  return null;
}

function onDemandService(
  line: CanonicalCurLine,
  id: FinopsKpiId,
): boolean {
  switch (id) {
    case "compute_on_demand_ratio":
      return isEc2Compute(line);
    case "sagemaker_on_demand_ratio":
      return isService(line, "sagemaker");
    case "rds_on_demand_ratio":
      return isService(line, "rds")
        || isService(line, "relational database");
    case "elasticache_on_demand_ratio":
      return isService(line, "elasticache");
    case "opensearch_on_demand_ratio":
      return isService(line, "opensearch")
        || isService(line, "elasticsearch");
    case "redshift_on_demand_ratio":
      return isService(line, "redshift");
    case "dynamodb_on_demand_ratio":
      return isService(line, "dynamodb");
    default:
      return false;
  }
}

function classify(
  id: FinopsKpiId,
  line: CanonicalCurLine,
  ageEvidence: ReadonlyMap<string, FinopsKpiResourceAgeEvidence>,
  evaluatedAtIso: string,
): Classification {
  if (line.chargeKind !== "usage") {
    return {
      eligible: false,
      numerator: null,
      confidence: "low",
      reasonCode: "NON_USAGE_CHARGE_EXCLUDED",
    };
  }
  switch (id) {
    case "ec2_previous_generation": {
      if (!isEc2Compute(line)) return { eligible: false, numerator: null, confidence: "low", reasonCode: "SERVICE_NOT_APPLICABLE" };
      const family = instanceFamily(line);
      return {
        eligible: true,
        numerator: family === null ? null : PREVIOUS_EC2_FAMILIES.has(family),
        confidence: "medium",
        reasonCode: family === null ? "INSTANCE_FAMILY_NOT_CLASSIFIABLE" : "CUR_INSTANCE_FAMILY_CANDIDATE",
      };
    }
    case "ec2_spot_share": {
      if (!isEc2Compute(line)) return { eligible: false, numerator: null, confidence: "low", reasonCode: "SERVICE_NOT_APPLICABLE" };
      const model = pricingModel(line);
      return {
        eligible: true,
        numerator: model === null ? null : model === "spot",
        confidence: "medium",
        reasonCode: model === null ? "PRICING_MODEL_NOT_CLASSIFIABLE" : "CUR_PRICING_MODEL_CANDIDATE",
      };
    }
    case "ec2_graviton_share":
    case "ec2_amd_share": {
      if (!isEc2Compute(line)) return { eligible: false, numerator: null, confidence: "low", reasonCode: "SERVICE_NOT_APPLICABLE" };
      const arch = architecture(line);
      return {
        eligible: true,
        numerator: arch === null
          ? null
          : id === "ec2_graviton_share"
            ? arch === "graviton"
            : arch === "amd",
        confidence: "medium",
        reasonCode: arch === null ? "PROCESSOR_FAMILY_NOT_CLASSIFIABLE" : "CURRENT_PROCESSOR_FAMILY_CANDIDATE",
      };
    }
    case "ebs_gp3_adoption": {
      if (!isEbs(line) || isSnapshot(line)) return { eligible: false, numerator: null, confidence: "low", reasonCode: "SERVICE_NOT_APPLICABLE" };
      const detail = detailText(line);
      const volumeType = ["gp3", "gp2", "io1", "io2", "st1", "sc1", "standard"]
        .find((token) => detail.includes(token)) ?? null;
      return {
        eligible: true,
        numerator: volumeType === null ? null : volumeType === "gp3",
        confidence: "medium",
        reasonCode: volumeType === null ? "VOLUME_TYPE_NOT_CLASSIFIABLE" : "CUR_VOLUME_TYPE_CANDIDATE",
      };
    }
    case "aged_snapshots": {
      if (!isSnapshot(line)) return { eligible: false, numerator: null, confidence: "low", reasonCode: "SERVICE_NOT_APPLICABLE" };
      const resourceEvidence = line.resourceId === null
        ? undefined
        : ageEvidence.get(line.resourceId);
      if (resourceEvidence === undefined) {
        return {
          eligible: true,
          numerator: null,
          confidence: "low",
          reasonCode: "AUTHORITATIVE_SNAPSHOT_AGE_EVIDENCE_MISSING",
        };
      }
      const ageDays = Math.floor(
        (Date.parse(evaluatedAtIso) - Date.parse(resourceEvidence.createdAtIso))
        / (24 * 60 * 60 * 1_000),
      );
      return {
        eligible: true,
        numerator: ageDays >= SNAPSHOT_AGE_DAYS,
        confidence: "high",
        reasonCode: "AUTHORITATIVE_SNAPSHOT_AGE_EVIDENCE",
      };
    }
    case "s3_standard_concentration": {
      if (!isService(line, "s3") && !isService(line, "simple storage")) {
        return { eligible: false, numerator: null, confidence: "low", reasonCode: "SERVICE_NOT_APPLICABLE" };
      }
      const storageClass = classifyStorageClass(line);
      return {
        eligible: true,
        numerator: storageClass === null ? null : storageClass === "standard",
        confidence: "medium",
        reasonCode: storageClass === null ? "STORAGE_CLASS_NOT_CLASSIFIABLE" : "CUR_STORAGE_CLASS_CANDIDATE",
      };
    }
    case "rds_graviton_share":
    case "elasticache_graviton_share":
    case "opensearch_graviton_share": {
      const applicable = id === "rds_graviton_share"
        ? isService(line, "rds") || isService(line, "relational database")
        : id === "elasticache_graviton_share"
          ? isService(line, "elasticache")
          : isService(line, "opensearch") || isService(line, "elasticsearch");
      if (!applicable) return { eligible: false, numerator: null, confidence: "low", reasonCode: "SERVICE_NOT_APPLICABLE" };
      const arch = architecture(line);
      return {
        eligible: true,
        numerator: arch === null ? null : arch === "graviton",
        confidence: "medium",
        reasonCode: arch === null ? "PROCESSOR_FAMILY_NOT_CLASSIFIABLE" : "CURRENT_PROCESSOR_FAMILY_CANDIDATE",
      };
    }
    case "rds_open_source_engine_share": {
      if (!isService(line, "rds") && !isService(line, "relational database")) {
        return { eligible: false, numerator: null, confidence: "low", reasonCode: "SERVICE_NOT_APPLICABLE" };
      }
      const engine = databaseEngine(line);
      return {
        eligible: true,
        numerator: engine === null ? null : engine === "open_source",
        confidence: "medium",
        reasonCode: engine === null ? "DATABASE_ENGINE_NOT_CLASSIFIABLE" : "CUR_DATABASE_ENGINE_CANDIDATE",
      };
    }
    case "lambda_graviton_share": {
      if (!isService(line, "lambda")) return { eligible: false, numerator: null, confidence: "low", reasonCode: "SERVICE_NOT_APPLICABLE" };
      const detail = detailText(line);
      const arch = detail.includes("arm64")
        ? "graviton"
        : detail.includes("x86_64") || detail.includes("x86-64")
          ? "other"
          : null;
      return {
        eligible: true,
        numerator: arch === null ? null : arch === "graviton",
        confidence: "medium",
        reasonCode: arch === null ? "LAMBDA_ARCHITECTURE_NOT_CLASSIFIABLE" : "CUR_LAMBDA_ARCHITECTURE_CANDIDATE",
      };
    }
    default: {
      if (!onDemandService(line, id)) return { eligible: false, numerator: null, confidence: "low", reasonCode: "SERVICE_NOT_APPLICABLE" };
      const model = pricingModel(line, id === "dynamodb_on_demand_ratio");
      return {
        eligible: true,
        numerator: model === null ? null : model === "on_demand",
        confidence: "medium",
        reasonCode: model === null ? "PRICING_MODEL_NOT_CLASSIFIABLE" : "CUR_PRICING_MODEL_CANDIDATE",
      };
    }
  }
}

function weight(
  row: ScopedCanonicalBillingRow,
  classification: Classification,
): WeightedLine | null {
  if (classification.numerator === null) return null;
  if (
    row.line.usageAmountMicros !== null
    && row.line.usageUnit !== null
    && BigInt(row.line.usageAmountMicros) > BigInt(0)
  ) {
    return {
      row,
      basis: "usage_quantity",
      currency: row.line.currency,
      usageUnit: row.line.usageUnit,
      weight: BigInt(row.line.usageAmountMicros),
      numerator: classification.numerator,
      confidence: classification.confidence,
      reasonCode: classification.reasonCode,
    };
  }
  const amount = BigInt(row.line.amountMicros);
  if (amount <= BigInt(0)) return null;
  return {
    row,
    basis: "unblended_cost",
    currency: row.line.currency,
    usageUnit: null,
    weight: amount,
    numerator: classification.numerator,
    confidence: classification.confidence,
    reasonCode: classification.reasonCode,
  };
}

function goalResource(scope: FinopsReconciliationScope, kpiId: FinopsKpiId): string {
  return [
    "finops-kpi",
    scope.organizationId,
    scope.customerId,
    scope.connectionId,
    kpiId,
  ].join(":");
}

function normalizeGoals(
  scope: FinopsReconciliationScope,
  goals: readonly FinopsKpiGoalVersion[],
): { readonly goals: readonly FinopsKpiGoalVersion[] } | FinopsKpiResult {
  if (!Array.isArray(goals) || goals.length > MAX_GOALS) {
    return fail("INVALID_GOAL", "goals");
  }
  const ids = new Set<string>();
  const normalized: FinopsKpiGoalVersion[] = [];
  for (let index = 0; index < goals.length; index += 1) {
    const candidate: unknown = goals[index];
    if (!isRecord(candidate) || !validTenantScope(candidate)) {
      return fail("INVALID_GOAL", `goals[${index}]`, index);
    }
    if (!sameTenantScope(scope, candidate)) {
      return fail("GOAL_SCOPE_MISMATCH", `goals[${index}]`, index);
    }
    const goal = candidate as unknown as FinopsKpiGoalVersion;
    const formula = typeof goal.kpiId === "string"
      ? FORMULA_BY_ID.get(goal.kpiId as FinopsKpiId)
      : undefined;
    if (
      formula === undefined
      || !text(goal.id, 256)
      || ids.has(goal.id)
      || !Number.isSafeInteger(goal.version)
      || goal.version < 1
      || goal.targetDirection !== formula.targetDirection
      || !Number.isSafeInteger(goal.targetBasisPoints)
      || goal.targetBasisPoints < 0
      || goal.targetBasisPoints > 10_000
      || !validIso(goal.effectiveFromIso)
      || (goal.effectiveToIso !== null && !validIso(goal.effectiveToIso))
      || (
        goal.effectiveToIso !== null
        && Date.parse(goal.effectiveToIso) <= Date.parse(goal.effectiveFromIso)
      )
      || !text(goal.actorId, 256)
      || !text(goal.auditReference)
      || !isRecord(goal.rbacDecision)
      || !text(goal.rbacDecision.decisionId, 256)
      || goal.rbacDecision.action !== "finops:kpi-goal:write"
      || goal.rbacDecision.resource !== goalResource(scope, formula.id)
      || goal.rbacDecision.actorId !== goal.actorId
      || !validIso(goal.rbacDecision.decidedAtIso)
      || Date.parse(goal.rbacDecision.decidedAtIso) > Date.parse(goal.effectiveFromIso)
      || !text(goal.rbacDecision.policyVersion, 256)
      || !text(goal.rbacDecision.evidenceReference)
    ) return fail("INVALID_GOAL", `goals[${index}]`, index);
    if (goal.rbacDecision.decision !== "allow") {
      return fail("GOAL_RBAC_DENIED", `goals[${index}].rbacDecision`, index);
    }
    ids.add(goal.id);
    normalized.push(goal);
  }
  normalized.sort((left, right) =>
    compareText(left.kpiId, right.kpiId)
    || Date.parse(left.effectiveFromIso) - Date.parse(right.effectiveFromIso)
    || left.version - right.version
    || compareText(left.id, right.id));
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (
      previous.kpiId === current.kpiId
      && current.version <= previous.version
    ) return fail("INVALID_GOAL", "goals", index);
    if (
      previous.kpiId === current.kpiId
      && (
        previous.effectiveToIso === null
        || Date.parse(current.effectiveFromIso) < Date.parse(previous.effectiveToIso)
      )
    ) return fail("OVERLAPPING_GOALS", "goals", index);
  }
  return { goals: normalized };
}

function normalizeAgeEvidence(
  scope: FinopsReconciliationScope,
  entries: readonly FinopsKpiResourceAgeEvidence[],
  evaluatedAtIso: string,
): { readonly evidence: ReadonlyMap<string, FinopsKpiResourceAgeEvidence> } | FinopsKpiResult {
  if (!Array.isArray(entries) || entries.length > MAX_AGE_EVIDENCE) {
    return fail("INVALID_RESOURCE_EVIDENCE", "resourceAgeEvidence");
  }
  const evidence = new Map<string, FinopsKpiResourceAgeEvidence>();
  for (let index = 0; index < entries.length; index += 1) {
    const candidate: unknown = entries[index];
    if (!isRecord(candidate) || !validTenantScope(candidate)) {
      return fail("INVALID_RESOURCE_EVIDENCE", `resourceAgeEvidence[${index}]`, index);
    }
    if (!sameTenantScope(scope, candidate)) {
      return fail("RESOURCE_EVIDENCE_SCOPE_MISMATCH", `resourceAgeEvidence[${index}]`, index);
    }
    const entry = candidate as unknown as FinopsKpiResourceAgeEvidence;
    if (
      !text(entry.resourceId, 1_024)
      || evidence.has(entry.resourceId)
      || !validIso(entry.createdAtIso)
      || !validIso(entry.observedAtIso)
      || Date.parse(entry.createdAtIso) > Date.parse(entry.observedAtIso)
      || Date.parse(entry.observedAtIso) > Date.parse(evaluatedAtIso)
      || entry.source !== "aws_ec2_describe_snapshots"
      || !text(entry.sourceEvidenceId)
    ) return fail("INVALID_RESOURCE_EVIDENCE", `resourceAgeEvidence[${index}]`, index);
    evidence.set(entry.resourceId, entry);
  }
  return { evidence };
}

function normalizeAssumptions(
  scope: FinopsReconciliationScope,
  entries: readonly FinopsKpiSavingsAssumption[],
  evaluatedAtIso: string,
): {
  readonly active: ReadonlyMap<string, FinopsKpiSavingsAssumption>;
} | FinopsKpiResult {
  if (!Array.isArray(entries) || entries.length > MAX_ASSUMPTIONS) {
    return fail("INVALID_SAVINGS_ASSUMPTION", "savingsAssumptions");
  }
  const active = new Map<string, FinopsKpiSavingsAssumption>();
  const ids = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const candidate: unknown = entries[index];
    if (!isRecord(candidate) || !validTenantScope(candidate)) {
      return fail("INVALID_SAVINGS_ASSUMPTION", `savingsAssumptions[${index}]`, index);
    }
    if (!sameTenantScope(scope, candidate)) {
      return fail("SAVINGS_ASSUMPTION_SCOPE_MISMATCH", `savingsAssumptions[${index}]`, index);
    }
    const entry = candidate as unknown as FinopsKpiSavingsAssumption;
    if (
      !text(entry.id, 256)
      || ids.has(entry.id)
      || !Number.isSafeInteger(entry.version)
      || entry.version < 1
      || typeof entry.kpiId !== "string"
      || !KPI_SET.has(entry.kpiId)
      || !validCurrency(entry.currency)
      || entry.basis !== "unblended_cost"
      || !Number.isSafeInteger(entry.savingsRateBasisPoints)
      || entry.savingsRateBasisPoints < 1
      || entry.savingsRateBasisPoints > 10_000
      || !validIso(entry.effectiveFromIso)
      || (entry.effectiveToIso !== null && !validIso(entry.effectiveToIso))
      || (
        entry.effectiveToIso !== null
        && Date.parse(entry.effectiveToIso) <= Date.parse(entry.effectiveFromIso)
      )
      || !text(entry.sourceReference)
      || !text(entry.compatibleEvidenceReference)
      || !text(entry.actorId, 256)
      || !text(entry.auditReference)
    ) return fail("INVALID_SAVINGS_ASSUMPTION", `savingsAssumptions[${index}]`, index);
    ids.add(entry.id);
    const effective = Date.parse(entry.effectiveFromIso) <= Date.parse(evaluatedAtIso)
      && (
        entry.effectiveToIso === null
        || Date.parse(evaluatedAtIso) < Date.parse(entry.effectiveToIso)
      );
    if (!effective) continue;
    const key = `${entry.kpiId}\0${entry.currency}`;
    if (active.has(key)) {
      return fail("AMBIGUOUS_SAVINGS_ASSUMPTION", "savingsAssumptions", index);
    }
    active.set(key, entry);
  }
  return { active };
}

function selectGoal(
  goals: readonly FinopsKpiGoalVersion[],
  id: FinopsKpiId,
  evaluatedAtIso: string,
): FinopsKpiSelectedGoal | null {
  const evaluated = Date.parse(evaluatedAtIso);
  const goal = goals.find((entry) =>
    entry.kpiId === id
    && Date.parse(entry.effectiveFromIso) <= evaluated
    && (
      entry.effectiveToIso === null
      || evaluated < Date.parse(entry.effectiveToIso)
    ));
  if (goal === undefined) return null;
  return {
    id: goal.id,
    version: goal.version,
    targetDirection: goal.targetDirection,
    targetBasisPoints: goal.targetBasisPoints,
    effectiveFromIso: goal.effectiveFromIso,
    effectiveToIso: goal.effectiveToIso,
    actorId: goal.actorId,
    auditReference: goal.auditReference,
    rbacDecisionId: goal.rbacDecision.decisionId,
    rbacEvidenceReference: goal.rbacDecision.evidenceReference,
  };
}

function measurementState(
  totalRows: number,
  eligible: number,
  classifiable: number,
): FinopsKpiMeasurement["state"] {
  if (totalRows === 0) return "missing";
  if (eligible === 0) return "not_applicable";
  if (classifiable === 0) return "insufficient_evidence";
  return "measured";
}

function opportunityFor(
  formula: FinopsKpiFormula,
  weighted: WeightedLine,
): boolean {
  return formula.targetDirection === "higher_is_better"
    ? !weighted.numerator
    : weighted.numerator;
}

function buildOpportunity(
  formula: FinopsKpiFormula,
  weighted: WeightedLine,
  input: FinopsKpiInput,
  assumption: FinopsKpiSavingsAssumption | undefined,
): FinopsKpiOpportunity {
  let estimatedSavingsMicros: string | null = null;
  let rateApplicationRemainder: string | null = null;
  let rateDenominator: "10000" | null = null;
  if (assumption !== undefined) {
    const amount = BigInt(weighted.row.line.amountMicros);
    if (amount > BigInt(0)) {
      const product = amount * BigInt(assumption.savingsRateBasisPoints);
      estimatedSavingsMicros = (product / RATIO_DENOMINATOR).toString();
      rateApplicationRemainder = (product % RATIO_DENOMINATOR).toString();
      rateDenominator = "10000";
    }
  }
  return {
    kpiId: formula.id,
    formulaVersion: formula.formulaVersion,
    evidenceWindowStartIso: input.evidenceWindow.startIso,
    evidenceWindowEndIso: input.evidenceWindow.endIso,
    sourceEvidenceId: input.evidenceWindow.sourceEvidenceId,
    sourceLineId: weighted.row.line.lineItemId,
    resourceId: weighted.row.line.resourceId,
    currency: weighted.currency,
    usageUnit: weighted.usageUnit,
    findingKind: "candidate_estimate",
    confidence: weighted.confidence,
    validationRequired: true,
    assumptionIds: assumption === undefined ? [] : [assumption.id],
    assumptionReferences: assumption === undefined
      ? []
      : [
          assumption.sourceReference,
          assumption.compatibleEvidenceReference,
          assumption.auditReference,
        ],
    estimatedSavingsMicros,
    rateApplicationRemainder,
    rateDenominator,
    reasonCode: weighted.reasonCode,
  };
}

function buildMeasurement(
  formula: FinopsKpiFormula,
  rows: readonly ScopedCanonicalBillingRow[],
  ageEvidence: ReadonlyMap<string, FinopsKpiResourceAgeEvidence>,
  goals: readonly FinopsKpiGoalVersion[],
  assumptions: ReadonlyMap<string, FinopsKpiSavingsAssumption>,
  input: FinopsKpiInput,
): {
  readonly measurement: FinopsKpiMeasurement;
  readonly opportunities: readonly FinopsKpiOpportunity[];
} {
  let eligibleLineCount = 0;
  let classifiableLineCount = 0;
  const reasons = new Set<string>();
  const weightedLines: WeightedLine[] = [];
  for (const row of rows) {
    const classification = classify(
      formula.id,
      row.line,
      ageEvidence,
      input.evidenceWindow.evaluatedAtIso,
    );
    if (!classification.eligible) continue;
    eligibleLineCount += 1;
    if (classification.numerator === null) {
      reasons.add(classification.reasonCode);
      continue;
    }
    const weighted = weight(row, classification);
    if (weighted === null) {
      reasons.add("COMPATIBLE_POSITIVE_USAGE_OR_COST_WEIGHT_MISSING");
      continue;
    }
    classifiableLineCount += 1;
    weightedLines.push(weighted);
  }

  const goal = selectGoal(
    goals,
    formula.id,
    input.evidenceWindow.evaluatedAtIso,
  );
  const segmentMap = new Map<string, MutableSegment>();
  for (const weighted of weightedLines) {
    const key = JSON.stringify([
      weighted.basis,
      weighted.currency,
      weighted.usageUnit,
    ]);
    const segment = segmentMap.get(key) ?? {
      numerator: BigInt(0),
      denominator: BigInt(0),
      sourceLineIds: [],
    };
    segment.denominator += weighted.weight;
    if (weighted.numerator) segment.numerator += weighted.weight;
    segment.sourceLineIds.push(weighted.row.line.lineItemId);
    segmentMap.set(key, segment);
  }
  const segments = [...segmentMap.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, segment]): FinopsKpiMeasurementSegment => {
      const [basis, currency, usageUnit] = JSON.parse(key) as [
        "usage_quantity" | "unblended_cost",
        string,
        string | null,
      ];
      const scaled = segment.numerator * RATIO_DENOMINATOR;
      const currentBasisPoints = Number(scaled / segment.denominator);
      const sourceLineIds = [...segment.sourceLineIds].sort(compareText);
      const goalStatus = goal === null
        ? "no_goal"
        : goal.targetDirection === "higher_is_better"
          ? currentBasisPoints >= goal.targetBasisPoints ? "met" : "not_met"
          : currentBasisPoints <= goal.targetBasisPoints ? "met" : "not_met";
      const gapBasisPoints = goal === null
        ? null
        : goal.targetDirection === "higher_is_better"
          ? Math.max(goal.targetBasisPoints - currentBasisPoints, 0)
          : Math.max(currentBasisPoints - goal.targetBasisPoints, 0);
      return {
        basis,
        currency,
        usageUnit,
        numerator: segment.numerator.toString(),
        denominator: segment.denominator.toString(),
        currentBasisPoints,
        ratioRemainder: (scaled % segment.denominator).toString(),
        ratioDenominator: "10000",
        goalStatus,
        gapBasisPoints,
        sourceLineIds: sourceLineIds.slice(0, 1_000),
        sourceLineIdsTruncated: sourceLineIds.length > 1_000,
      };
    });

  const opportunities = weightedLines
    .filter((weighted) => opportunityFor(formula, weighted))
    .sort((left, right) =>
      compareText(left.currency, right.currency)
      || compareText(left.usageUnit ?? "", right.usageUnit ?? "")
      || compareText(left.row.line.lineItemId, right.row.line.lineItemId))
    .map((weighted) => buildOpportunity(
      formula,
      weighted,
      input,
      assumptions.get(`${formula.id}\0${weighted.currency}`),
    ));
  const state = measurementState(
    rows.length,
    eligibleLineCount,
    classifiableLineCount,
  );
  if (state === "missing") reasons.add("NO_CANONICAL_ACTIVE_GENERATION_ROWS");
  if (state === "not_applicable") reasons.add("NO_APPLICABLE_USAGE_LINES");
  if (state === "insufficient_evidence" && reasons.size === 0) {
    reasons.add("NO_CLASSIFIABLE_EVIDENCE");
  }
  return {
    measurement: {
      kpiId: formula.id,
      formulaVersion: formula.formulaVersion,
      state,
      findingKind: "candidate_estimate",
      validationRequired: true,
      selectedGoal: goal,
      eligibleLineCount,
      classifiableLineCount,
      unclassifiedLineCount: eligibleLineCount - classifiableLineCount,
      evidenceCompleteness: classifiableLineCount === 0
        ? "none"
        : classifiableLineCount === eligibleLineCount
          ? "complete"
          : "partial",
      reasonCodes: [...reasons].sort(compareText),
      segments,
    },
    opportunities,
  };
}

/**
 * Evaluate every versioned Foundational KPI formula for one tenant-bound active
 * generation. Any invalid authorization, goal, evidence, assumption, row, or
 * scope rejects the whole deterministic evaluation.
 */
export function evaluateFinopsKpis(input: FinopsKpiInput): FinopsKpiResult {
  if (!isRecord(input) || !validScope(input.scope)) {
    return fail("INVALID_SCOPE", "scope");
  }
  if (
    !isRecord(input.evidenceWindow)
    || !validIso(input.evidenceWindow.startIso)
    || !validIso(input.evidenceWindow.endIso)
    || !validIso(input.evidenceWindow.evaluatedAtIso)
    || Date.parse(input.evidenceWindow.endIso) <= Date.parse(input.evidenceWindow.startIso)
    || Date.parse(input.evidenceWindow.evaluatedAtIso) < Date.parse(input.evidenceWindow.endIso)
    || !text(input.evidenceWindow.sourceEvidenceId)
    || typeof input.evidenceWindow.manifestSha256 !== "string"
    || !/^[a-f0-9]{64}$/u.test(input.evidenceWindow.manifestSha256)
    || !Array.isArray(input.rows)
    || input.rows.length > MAX_ROWS
  ) return fail(
    Array.isArray(input.rows) && input.rows.length > MAX_ROWS
      ? "ROW_LIMIT_EXCEEDED"
      : "INVALID_INPUT",
    "input",
  );
  const lineIds = new Set<string>();
  const activeRows: ScopedCanonicalBillingRow[] = [];
  for (let index = 0; index < input.rows.length; index += 1) {
    const candidate: unknown = input.rows[index];
    if (!isRecord(candidate) || !validScope(candidate) || !sameScope(input.scope, candidate)) {
      return fail("ROW_SCOPE_MISMATCH", `rows[${index}]`, index);
    }
    const row = candidate as unknown as ScopedCanonicalBillingRow;
    if (!validCanonicalLine(row.line)) {
      return fail("INVALID_CANONICAL_ROW", `rows[${index}].line`, index);
    }
    if (lineIds.has(row.line.lineItemId)) {
      return fail("DUPLICATE_SOURCE_LINE", `rows[${index}].line.lineItemId`, index);
    }
    lineIds.add(row.line.lineItemId);
    const usageStart = Date.parse(row.line.usageStartIso);
    if (
      usageStart >= Date.parse(input.evidenceWindow.startIso)
      && usageStart < Date.parse(input.evidenceWindow.endIso)
    ) activeRows.push(row);
  }
  activeRows.sort((left, right) =>
    compareText(left.line.lineItemId, right.line.lineItemId));

  const normalizedGoals = normalizeGoals(input.scope, input.goals ?? []);
  if ("ok" in normalizedGoals) return normalizedGoals;
  const normalizedAgeEvidence = normalizeAgeEvidence(
    input.scope,
    input.resourceAgeEvidence ?? [],
    input.evidenceWindow.evaluatedAtIso,
  );
  if ("ok" in normalizedAgeEvidence) return normalizedAgeEvidence;
  const normalizedAssumptions = normalizeAssumptions(
    input.scope,
    input.savingsAssumptions ?? [],
    input.evidenceWindow.evaluatedAtIso,
  );
  if ("ok" in normalizedAssumptions) return normalizedAssumptions;
  const maxOpportunities = input.maxOpportunities
    ?? DEFAULT_MAX_OPPORTUNITIES;
  if (
    !Number.isSafeInteger(maxOpportunities)
    || maxOpportunities < 1
    || maxOpportunities > MAX_OPPORTUNITIES
  ) return fail("INVALID_INPUT", "maxOpportunities");

  const measurements: FinopsKpiMeasurement[] = [];
  const opportunities: FinopsKpiOpportunity[] = [];
  for (const formula of FINOPS_KPI_FORMULAS) {
    const result = buildMeasurement(
      formula,
      activeRows,
      normalizedAgeEvidence.evidence,
      normalizedGoals.goals,
      normalizedAssumptions.active,
      input,
    );
    measurements.push(result.measurement);
    opportunities.push(...result.opportunities);
  }
  opportunities.sort((left, right) =>
    compareText(left.kpiId, right.kpiId)
    || compareText(left.currency, right.currency)
    || compareText(left.sourceLineId, right.sourceLineId));
  return {
    ok: true,
    schema: "sutra.finops-kpi.v1",
    scope: input.scope,
    formulaRegistry: FINOPS_KPI_FORMULAS,
    evidenceWindow: input.evidenceWindow,
    measurements,
    opportunities: opportunities.slice(0, maxOpportunities),
    opportunitiesTruncated: opportunities.length > maxOpportunities,
    failures: [],
  };
}
