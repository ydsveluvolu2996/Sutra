/**
 * Pure all-Region materialization boundary for AWS Compute Optimizer exports.
 *
 * A partial attempt is useful evidence, but can never become an accepted head.
 * Only an exact Region x export-family matrix can be finalized. The complete
 * mapped evidence is retained in the content address; numeric evidence is
 * validated without passing monetary values through JavaScript floating point.
 */

import { canonicalJson } from "./canonical-json.ts";
import type {
  ComputeOptimizerMappedFieldEvidence,
  ComputeOptimizerMappedFinding,
  ComputeOptimizerMappedRankedOption,
  ComputeOptimizerMappedRdsRecommendation,
  ComputeOptimizerMappedRecommendation,
  ComputeOptimizerMappedSavingsChannel,
  ComputeOptimizerMappedTagEvidence,
  ComputeOptimizerOpaqueIdleSavingsChannel,
  ComputeOptimizerRejectedRowEvidence,
  ComputeOptimizerSavingsChannel,
  MappedComputeOptimizerExportTarget,
} from "./finops-compute-optimizer-export-mapper.ts";
import { COMPUTE_OPTIMIZER_EXPORT_MAPPER_BOUNDS } from "./finops-compute-optimizer-export-mapper.ts";
import type {
  ComputeOptimizerExportFamily,
  ComputeOptimizerExportPlanSet,
  ComputeOptimizerExportPlanTarget,
} from "./finops-compute-optimizer-export-plan.ts";
import {
  COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS,
  verifyComputeOptimizerExportPlanSet,
} from "./finops-compute-optimizer-export-plan.ts";
import { COMPUTE_OPTIMIZER_EXPORT_PARSER_BOUNDS } from "./finops-compute-optimizer-export-parser.ts";
import {
  COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS,
  type FreshComputeOptimizerExportBinding,
} from "./finops-compute-optimizer-export-fresh-resolver.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const ARN = /^arn:(aws|aws-cn|aws-us-gov):([^:]+):([^:]*):(\d{12}):(.+)$/u;
const SIGNED_INTEGER = /^-?(?:0|[1-9]\d*)$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const DATE = /^\d{4}-\d{2}-\d{2}$/u;
const SAFE_IDENTITY = /^[^\u0000-\u0020\u007f<>]{1,1024}$/u;
const RUN_ID = /^cor_[a-f0-9]{64}$/u;
const SCHEDULED_WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const SIGNED_64_MIN = -(BigInt(1) << BigInt(63));
const SIGNED_64_MAX = (BigInt(1) << BigInt(63)) - BigInt(1);
const MAX_SOURCE_BYTES_PER_TARGET =
  COMPUTE_OPTIMIZER_EXPORT_PARSER_BOUNDS.maximumCsvBytes
  + COMPUTE_OPTIMIZER_EXPORT_PARSER_BOUNDS.maximumMetadataBytes;

export const COMPUTE_OPTIMIZER_EXPORT_GENERATION_BOUNDS = Object.freeze({
  maximumTargets: COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumPlanSetTargets,
  maximumAggregateRows:
    COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumPlanSetTargets
    * COMPUTE_OPTIMIZER_EXPORT_MAPPER_BOUNDS.maximumRows,
  maximumRecommendations:
    COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumPlanSetTargets
    * COMPUTE_OPTIMIZER_EXPORT_MAPPER_BOUNDS.maximumRows,
  maximumRejectedRows:
    COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumPlanSetTargets
    * COMPUTE_OPTIMIZER_EXPORT_MAPPER_BOUNDS.maximumRows,
  maximumAggregateSourceBytes:
    COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumPlanSetTargets * MAX_SOURCE_BYTES_PER_TARGET,
  maximumSerializedBytes: 256 * 1_024 * 1_024,
} as const);

export interface ComputeOptimizerExportGenerationLimits {
  readonly maximumTargets: number;
  readonly maximumAggregateRows: number;
  readonly maximumRecommendations: number;
  readonly maximumRejectedRows: number;
  readonly maximumAggregateSourceBytes: number;
  readonly maximumSerializedBytes: number;
}

export interface ComputeOptimizerExportGenerationOptions {
  /** Server-owned daily UTC execution identity. */
  readonly scheduledWindow: string;
  /** Exact consumption instant; this boundary never substitutes persistence time. */
  readonly materializedAtMs: number;
  readonly limits?: Partial<ComputeOptimizerExportGenerationLimits>;
}

export interface ComputeOptimizerExportGenerationTargetKey {
  readonly region: string;
  readonly exportFamily: ComputeOptimizerExportFamily;
}

export interface ComputeOptimizerExportGenerationCoverage {
  readonly expectedTargetCount: number;
  readonly mappedTargetCount: number;
  readonly rowCount: number;
  readonly recommendationCount: number;
  readonly rejectedRowCount: number;
  readonly sourceBytes: number;
}

export interface ComputeOptimizerExportGenerationUnresolvedEvidence {
  readonly targetCount: number;
  readonly savingsChannelCount: number;
  readonly targetKeys: readonly ComputeOptimizerExportGenerationTargetKey[];
}

interface ComputeOptimizerExportGenerationEvidence {
  readonly planSetId: string;
  readonly planSetContentSha256: string;
  readonly scope: ComputeOptimizerExportPlanSet["scope"];
  readonly requesterAccountId: string;
  readonly partition: ComputeOptimizerExportPlanSet["partition"];
  readonly regions: readonly string[];
  readonly exportFamilies: readonly ComputeOptimizerExportFamily[];
  readonly planIds: readonly string[];
  readonly scheduledWindow: string;
  readonly materializedAtIso: string;
  /** Oldest completed target update across the complete regional plan set. */
  readonly dataThroughAtIso: string;
  /** Newest regional resolver observation, independent of target/hash order. */
  readonly observedAtIso: string;
  readonly freshBindings: readonly FreshComputeOptimizerExportBinding[];
  readonly coverage: ComputeOptimizerExportGenerationCoverage;
  readonly schemaAssurances: readonly MappedComputeOptimizerExportTarget["schemaAssurance"][];
  readonly unresolvedEvidence: ComputeOptimizerExportGenerationUnresolvedEvidence;
  readonly targets: readonly MappedComputeOptimizerExportTarget[];
}

export interface ComputeOptimizerExportGenerationAttempt
  extends ComputeOptimizerExportGenerationEvidence {
  readonly schemaVersion: "sutra.compute-optimizer-export-generation-attempt.v1";
  readonly attemptId: string;
  readonly contentSha256: string;
  readonly state: "PARTIAL" | "ALL_REGION_COMPLETE";
  /** Attempts are evidence only. Even a complete attempt must be finalized. */
  readonly acceptedHeadEligible: false;
  readonly missingTargets: readonly ComputeOptimizerExportGenerationTargetKey[];
}

export interface ComputeOptimizerExportGeneration
  extends ComputeOptimizerExportGenerationEvidence {
  readonly schemaVersion: "sutra.compute-optimizer-export-generation.v1";
  readonly generationId: string;
  readonly contentSha256: string;
  readonly state: "ALL_REGION_ACCEPTED";
  readonly acceptedHeadEligible: true;
  readonly missingTargets: readonly [];
}

export class ComputeOptimizerExportGenerationError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "LIMIT_EXCEEDED"
      | "PLAN_SET_INVALID"
      | "FRESH_BINDING_INVALID"
      | "DUPLICATE_FRESH_BINDING"
      | "MISSING_FRESH_BINDING"
      | "FRESH_BINDING_EXPIRED"
      | "CHRONOLOGY_INVALID"
      | "DUPLICATE_TARGET"
      | "TARGET_SUBSTITUTION"
      | "OBJECT_SUBSTITUTION"
      | "DUPLICATE_OBJECT"
      | "ROW_EVIDENCE_INVALID"
      | "NUMERIC_EVIDENCE_INVALID"
      | "DUPLICATE_RESOURCE"
      | "INCOMPLETE_COVERAGE"
      | "CONTENT_HASH_MISMATCH",
  ) {
    super("Compute Optimizer export generation rejected");
    this.name = "ComputeOptimizerExportGenerationError";
  }
}

function reject(code: ComputeOptimizerExportGenerationError["code"]): never {
  throw new ComputeOptimizerExportGenerationError(code);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function pair(region: string, family: string): string {
  return `${region}\u0000${family}`;
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function canonicalClone<T>(value: T): T {
  try {
    return JSON.parse(canonicalJson(value)) as T;
  } catch {
    reject("INVALID_INPUT");
  }
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function limitsFrom(options: ComputeOptimizerExportGenerationOptions): ComputeOptimizerExportGenerationLimits {
  if (!isRecord(options) || !exactKeys(
    options,
    options.limits === undefined
      ? ["scheduledWindow", "materializedAtMs"]
      : ["scheduledWindow", "materializedAtMs", "limits"],
  )) {
    reject("INVALID_INPUT");
  }
  if (typeof options.scheduledWindow !== "string"
    || !Number.isSafeInteger(options.materializedAtMs)
    || options.materializedAtMs < 0) reject("INVALID_INPUT");
  const scheduledWindowMs = Date.parse(options.scheduledWindow);
  if (
    !SCHEDULED_WINDOW.test(options.scheduledWindow)
    || !Number.isSafeInteger(scheduledWindowMs)
    || new Date(scheduledWindowMs).toISOString() !== options.scheduledWindow
    || scheduledWindowMs > options.materializedAtMs
  ) reject("INVALID_INPUT");
  if (options.limits !== undefined && !isRecord(options.limits)) reject("INVALID_INPUT");
  const overrides = options.limits ?? {};
  const allowed = Object.keys(COMPUTE_OPTIMIZER_EXPORT_GENERATION_BOUNDS);
  if (Object.keys(overrides).some((key) => !allowed.includes(key))) reject("INVALID_INPUT");
  const result = {
    ...COMPUTE_OPTIMIZER_EXPORT_GENERATION_BOUNDS,
    ...overrides,
  } as ComputeOptimizerExportGenerationLimits;
  for (const key of allowed as (keyof ComputeOptimizerExportGenerationLimits)[]) {
    const value = result[key];
    if (
      !Number.isSafeInteger(value)
      || value < 1
      || value > COMPUTE_OPTIMIZER_EXPORT_GENERATION_BOUNDS[key]
    ) reject("INVALID_INPUT");
  }
  return result;
}

function safeAdd(left: number, right: number): number {
  const total = left + right;
  if (!Number.isSafeInteger(total)) reject("LIMIT_EXCEEDED");
  return total;
}

function validFieldEvidence(value: unknown): value is ComputeOptimizerMappedFieldEvidence {
  return isRecord(value)
    && exactKeys(value, ["apiField", "column", "datatype", "raw", "assurance"])
    && typeof value.apiField === "string"
    && value.apiField.length > 0
    && typeof value.column === "string"
    && value.column.length > 0
    && (value.datatype === "string" || value.datatype === "integer"
      || value.datatype === "double" || value.datatype === "datetime")
    && typeof value.raw === "string"
    && (value.assurance === "USER_GUIDE_CSV_LABEL" || value.assurance === "API_FIELD_NAME_ONLY");
}

function validFinding(value: unknown): value is ComputeOptimizerMappedFinding {
  return isRecord(value)
    && exactKeys(value, ["scope", "finding", "reasons"])
    && (value.scope === "RESOURCE" || value.scope === "INSTANCE" || value.scope === "STORAGE")
    && validFieldEvidence(value.finding)
    && Array.isArray(value.reasons)
    && value.reasons.every(validFieldEvidence);
}

function validNormalizedSavings(value: unknown): value is ComputeOptimizerMappedSavingsChannel {
  if (!isRecord(value)) return false;
  if (
    !exactKeys(value, [
      "scope", "includesExistingDiscounts", "normalizationState", "currency",
      "amountMicros", "percentageBasisPoints", "evidence",
    ])
    || (value.scope !== "RESOURCE" && value.scope !== "INSTANCE" && value.scope !== "STORAGE")
    || typeof value.includesExistingDiscounts !== "boolean"
    || (value.normalizationState !== "EXACT_DOCUMENTED_CSV_LABEL"
      && value.normalizationState !== "EXACT_API_FIELD_NAME_UNVERIFIED")
    || typeof value.currency !== "string"
    || !CURRENCY.test(value.currency)
    || typeof value.amountMicros !== "string"
    || !SIGNED_INTEGER.test(value.amountMicros)
    || value.amountMicros === "-0"
    || !Number.isSafeInteger(value.percentageBasisPoints)
    || (value.percentageBasisPoints as number) < 0
    || (value.percentageBasisPoints as number) > 10_000
    || !Array.isArray(value.evidence)
    || !value.evidence.every(validFieldEvidence)
  ) return false;
  try {
    const amount = BigInt(value.amountMicros);
    return amount >= SIGNED_64_MIN && amount <= SIGNED_64_MAX;
  } catch {
    return false;
  }
}

function validOpaqueSavings(value: unknown): value is ComputeOptimizerOpaqueIdleSavingsChannel {
  return isRecord(value) && exactKeys(value, [
    "scope", "includesExistingDiscounts", "normalizationState", "apiField", "raw", "evidence",
  ])
    && value.scope === "RESOURCE"
    && typeof value.includesExistingDiscounts === "boolean"
    && value.normalizationState === "UNRESOLVED_PROVIDER_CSV_LABEL"
    && (value.apiField === "SavingsOpportunity" || value.apiField === "SavingsOpportunityAfterDiscount")
    && typeof value.raw === "string"
    && validFieldEvidence(value.evidence);
}

function validSavings(value: unknown): value is ComputeOptimizerSavingsChannel {
  return validNormalizedSavings(value) || validOpaqueSavings(value);
}

function validRankedOption(value: unknown): value is ComputeOptimizerMappedRankedOption {
  return isRecord(value)
    && exactKeys(value, ["rank", "configuration", "risk"])
    && Number.isSafeInteger(value.rank)
    && (value.rank as number) >= 1
    && (value.rank as number) <= COMPUTE_OPTIMIZER_EXPORT_MAPPER_BOUNDS.maximumOptionsPerRow
    && Array.isArray(value.configuration)
    && value.configuration.every(validFieldEvidence)
    && (value.risk === null || validFieldEvidence(value.risk));
}

function validTag(value: unknown): value is ComputeOptimizerMappedTagEvidence {
  return isRecord(value)
    && exactKeys(value, ["key", "value", "column", "assurance"])
    && typeof value.key === "string"
    && value.key.length > 0
    && typeof value.value === "string"
    && typeof value.column === "string"
    && value.column.length > 0
    && value.assurance === "CSVW_NAME_AND_TITLE";
}

function validRdsBranch(value: unknown, includeRisk: boolean): boolean {
  if (!isRecord(value)) return false;
  const expected = includeRisk
    ? ["availability", "finding", "configuration", "risk", "savings"]
    : ["availability", "finding", "configuration", "savings"];
  return exactKeys(value, expected)
    && (value.availability === "PRESENT" || value.availability === "ABSENT_IN_PROVIDER_ROW")
    && (value.finding === null || validFinding(value.finding))
    && Array.isArray(value.configuration)
    && value.configuration.every(validFieldEvidence)
    && (!includeRisk || (Array.isArray(value.risk) && value.risk.every(validFieldEvidence)))
    && Array.isArray(value.savings)
    && value.savings.every(validSavings);
}

function validRds(value: unknown): value is ComputeOptimizerMappedRdsRecommendation {
  if (!isRecord(value) || !exactKeys(value, ["instance", "storage", "auroraStorageIdentity"])) {
    return false;
  }
  if (!validRdsBranch(value.instance, true) || !validRdsBranch(value.storage, false)) return false;
  if (value.auroraStorageIdentity === null) return true;
  return isRecord(value.auroraStorageIdentity)
    && exactKeys(value.auroraStorageIdentity, [
      "providerResourceType", "dbClusterIdentifier", "clusterWriter", "promotionTier",
    ])
    && (value.auroraStorageIdentity.providerResourceType === "AuroraDBClusterStorage")
    && validFieldEvidence(value.auroraStorageIdentity.dbClusterIdentifier)
    && (value.auroraStorageIdentity.clusterWriter === null
      || validFieldEvidence(value.auroraStorageIdentity.clusterWriter))
    && (value.auroraStorageIdentity.promotionTier === null
      || validFieldEvidence(value.auroraStorageIdentity.promotionTier));
}

function validRecommendation(
  value: unknown,
  source: MappedComputeOptimizerExportTarget["source"],
  rowCount: number,
  partition: ComputeOptimizerExportPlanSet["partition"],
): value is ComputeOptimizerMappedRecommendation {
  const arnMatch = isRecord(value) && typeof value.resourceArn === "string"
    ? ARN.exec(value.resourceArn)
    : null;
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "rowNumber", "accountId", "resourceArn", "resourceId", "resourceIdSource", "region",
      "exportFamily", "findings", "lastRefreshTimestamp", "lookbackPeriodLexeme",
      "currentConfiguration", "recommendedConfiguration", "currentRisk", "rankedOptions",
      "savings", "tags", "rds",
    ])
    || !Number.isSafeInteger(value.rowNumber)
    || (value.rowNumber as number) < 1
    || (value.rowNumber as number) > rowCount
    || typeof value.accountId !== "string"
    || !ACCOUNT_ID.test(value.accountId)
    || typeof value.resourceArn !== "string"
    || arnMatch === null
    || arnMatch[1] !== partition
    || arnMatch[4] !== value.accountId
    || (arnMatch[3] !== "" && arnMatch[3] !== source.region)
    || typeof value.resourceId !== "string"
    || value.resourceId.length < 1
    || (value.resourceIdSource !== "EXPORTED" && value.resourceIdSource !== "ARN"
      && value.resourceIdSource !== "EXPORTED_NAME")
    || value.region !== source.region
    || value.exportFamily !== source.exportFamily
    || !Array.isArray(value.findings)
    || !value.findings.every(validFinding)
    || typeof value.lastRefreshTimestamp !== "string"
    || typeof value.lookbackPeriodLexeme !== "string"
    || !Array.isArray(value.currentConfiguration)
    || !value.currentConfiguration.every(validFieldEvidence)
    || !Array.isArray(value.recommendedConfiguration)
    || !value.recommendedConfiguration.every(validFieldEvidence)
    || !Array.isArray(value.currentRisk)
    || !value.currentRisk.every(validFieldEvidence)
    || !Array.isArray(value.rankedOptions)
    || !value.rankedOptions.every(validRankedOption)
    || !value.rankedOptions.every((option, index) => option.rank === index + 1)
    || !Array.isArray(value.savings)
    || !value.savings.every(validSavings)
    || !Array.isArray(value.tags)
    || !value.tags.every(validTag)
    || (source.exportFamily === "RDS_DATABASE"
      ? (value.rds === null
        || !validRds(value.rds)
        || (source.providerResourceType === "AuroraDBClusterStorage")
          !== (value.rds.auroraStorageIdentity !== null))
      : value.rds !== null)
  ) return false;
  const savings = value.savings as ComputeOptimizerSavingsChannel[];
  return new Set(savings.map((channel) => `${channel.scope}:${String(channel.includesExistingDiscounts)}`)).size
    === savings.length;
}

function validRejectedRow(
  value: unknown,
  rowCount: number,
  source: MappedComputeOptimizerExportTarget["source"],
  partition: ComputeOptimizerExportPlanSet["partition"],
): value is ComputeOptimizerRejectedRowEvidence {
  if (!(isRecord(value)
    && exactKeys(value, ["rowNumber", "errorCode", "errorMessage", "accountId", "resourceArn"])
    && Number.isSafeInteger(value.rowNumber)
    && (value.rowNumber as number) >= 1
    && (value.rowNumber as number) <= rowCount
    && typeof value.errorCode === "string"
    && value.errorCode.length > 0
    && typeof value.errorMessage === "string"
    && (value.accountId === null || (typeof value.accountId === "string" && ACCOUNT_ID.test(value.accountId)))
    && (value.resourceArn === null || (typeof value.resourceArn === "string" && ARN.test(value.resourceArn))))) {
    return false;
  }
  if (value.resourceArn === null) return true;
  const arn = ARN.exec(value.resourceArn);
  return arn !== null
    && arn[1] === partition
    && (arn[3] === "" || arn[3] === source.region)
    && (value.accountId === null || arn[4] === value.accountId);
}

function validObjectIdentity(value: unknown): value is MappedComputeOptimizerExportTarget["source"]["csvObject"] {
  return isRecord(value)
    && exactKeys(value, ["key", "eTag", "versionId", "bytes", "sha256"])
    && typeof value.key === "string"
    && value.key.length > 0
    && typeof value.eTag === "string"
    && SAFE_IDENTITY.test(value.eTag)
    && (value.versionId === null
      || (typeof value.versionId === "string" && SAFE_IDENTITY.test(value.versionId)))
    && Number.isSafeInteger(value.bytes)
    && (value.bytes as number) >= 1
    && typeof value.sha256 === "string"
    && SHA256.test(value.sha256);
}

function validateTargetShape(
  target: unknown,
  planned: ComputeOptimizerExportPlanTarget,
  partition: ComputeOptimizerExportPlanSet["partition"],
): asserts target is MappedComputeOptimizerExportTarget {
  if (
    !isRecord(target)
    || !exactKeys(target, [
      "schemaVersion", "source", "schemaAssurance", "rowCount", "recommendationCount",
      "rejectedRowCount", "recommendations", "rejectedRows",
    ])
    || target.schemaVersion !== "sutra.compute-optimizer-export-mapped-target.v1"
    || !isRecord(target.source)
    || !exactKeys(target.source, [
      "region", "exportFamily", "providerResourceType", "requestSha256", "jobId", "bucket",
      "csvObject", "metadataObject", "csvBasename", "csvSha256", "metadataSha256", "modifiedDate",
    ])
    || (target.schemaAssurance !== "OFFICIAL_USER_GUIDE_CSV_LABELS"
      && target.schemaAssurance !== "API_FIELD_NAME_ONLY_UNVERIFIED"
      && target.schemaAssurance !== "METADATA_DERIVED_TAG_COLUMNS_UNVERIFIED")
    || !Number.isSafeInteger(target.rowCount)
    || (target.rowCount as number) < 0
    || (target.rowCount as number) > COMPUTE_OPTIMIZER_EXPORT_MAPPER_BOUNDS.maximumRows
    || !Number.isSafeInteger(target.recommendationCount)
    || !Number.isSafeInteger(target.rejectedRowCount)
    || !Array.isArray(target.recommendations)
    || !Array.isArray(target.rejectedRows)
    || !validObjectIdentity(target.source.csvObject)
    || !validObjectIdentity(target.source.metadataObject)
    || (target.source.csvObject as { bytes: number }).bytes
      > COMPUTE_OPTIMIZER_EXPORT_PARSER_BOUNDS.maximumCsvBytes
    || (target.source.metadataObject as { bytes: number }).bytes
      > COMPUTE_OPTIMIZER_EXPORT_PARSER_BOUNDS.maximumMetadataBytes
    || typeof target.source.csvBasename !== "string"
    || target.source.csvBasename.length < 1
    || typeof target.source.csvSha256 !== "string"
    || typeof target.source.metadataSha256 !== "string"
    || (target.source.modifiedDate !== null
      && (typeof target.source.modifiedDate !== "string" || !DATE.test(target.source.modifiedDate)))
  ) reject("ROW_EVIDENCE_INVALID");

  const source = target.source as unknown as MappedComputeOptimizerExportTarget["source"];
  if (
    (source.exportFamily === "LICENSE"
      || source.exportFamily === "RDS_DATABASE"
      || source.exportFamily === "IDLE_RESOURCE")
    && target.schemaAssurance !== "API_FIELD_NAME_ONLY_UNVERIFIED"
  ) reject("ROW_EVIDENCE_INVALID");
  if (
    source.region !== planned.region
    || source.exportFamily !== planned.exportFamily
    || source.providerResourceType !== planned.expectedJob.providerResourceType
    || source.requestSha256 !== planned.requestSha256
    || source.jobId !== planned.expectedJob.jobId
    || source.bucket !== planned.expectedJob.bucket
  ) reject("TARGET_SUBSTITUTION");
  if (
    source.csvObject.key !== planned.expectedJob.objectKey
    || source.metadataObject.key !== planned.expectedJob.metadataKey
    || source.csvSha256 !== source.csvObject.sha256
    || source.metadataSha256 !== source.metadataObject.sha256
    || source.csvBasename !== planned.expectedJob.objectKey.slice(
      planned.expectedJob.objectKey.lastIndexOf("/") + 1,
    )
  ) reject("OBJECT_SUBSTITUTION");

  const rowCount = target.rowCount as number;
  if (
    target.recommendationCount !== target.recommendations.length
    || target.rejectedRowCount !== target.rejectedRows.length
    || rowCount !== target.recommendations.length + target.rejectedRows.length
    || !target.recommendations.every((value) => validRecommendation(
      value,
      source,
      rowCount,
      partition,
    ))
    || !target.rejectedRows.every((value) => validRejectedRow(
      value,
      rowCount,
      source,
      partition,
    ))
  ) reject("ROW_EVIDENCE_INVALID");
  const recommendations = target.recommendations as unknown as ComputeOptimizerMappedRecommendation[];
  const rejectedRows = target.rejectedRows as unknown as ComputeOptimizerRejectedRowEvidence[];
  if (!recommendations.every((value, index) => index === 0
    || compare(recommendations[index - 1]!.accountId, value.accountId) < 0
    || (recommendations[index - 1]!.accountId === value.accountId
      && (compare(recommendations[index - 1]!.resourceArn, value.resourceArn) < 0
        || (recommendations[index - 1]!.resourceArn === value.resourceArn
          && recommendations[index - 1]!.rowNumber < value.rowNumber))))) {
    reject("ROW_EVIDENCE_INVALID");
  }
  if (!rejectedRows.every((value, index) => index === 0
    || rejectedRows[index - 1]!.rowNumber < value.rowNumber)) reject("ROW_EVIDENCE_INVALID");
  const rowNumbers = [
    ...recommendations.map((value) => value.rowNumber),
    ...rejectedRows.map((value) => value.rowNumber),
  ].sort((left, right) => left - right);
  if (!rowNumbers.every((value, index) => value === index + 1)) reject("ROW_EVIDENCE_INVALID");
}

interface AssessedEvidence extends ComputeOptimizerExportGenerationEvidence {
  readonly missingTargets: readonly ComputeOptimizerExportGenerationTargetKey[];
}

interface ValidatedFreshChronology {
  readonly bindings: readonly FreshComputeOptimizerExportBinding[];
  readonly dataThroughAtIso: string;
  readonly observedAtIso: string;
}

function canonicalIsoMs(value: unknown): number {
  if (typeof value !== "string") reject("CHRONOLOGY_INVALID");
  const epoch = Date.parse(value);
  if (!Number.isSafeInteger(epoch) || epoch < 0 || new Date(epoch).toISOString() !== value) {
    reject("CHRONOLOGY_INVALID");
  }
  return epoch;
}

function sameFreshTarget(
  value: unknown,
  target: ComputeOptimizerExportPlanTarget,
): boolean {
  return isRecord(value)
    && exactKeys(value, [
      "region", "exportFamily", "providerResourceType", "requestSha256", "jobId",
      "bucket", "objectKey", "metadataKey",
    ])
    && value.region === target.region
    && value.exportFamily === target.exportFamily
    && value.providerResourceType === target.expectedJob.providerResourceType
    && value.requestSha256 === target.requestSha256
    && value.jobId === target.expectedJob.jobId
    && value.bucket === target.expectedJob.bucket
    && value.objectKey === target.expectedJob.objectKey
    && value.metadataKey === target.expectedJob.metadataKey;
}

function validateFreshBindings(
  planSet: ComputeOptimizerExportPlanSet,
  unsafeBindings: readonly FreshComputeOptimizerExportBinding[],
  materializedAtMs: number,
): ValidatedFreshChronology {
  if (!Array.isArray(unsafeBindings)) reject("FRESH_BINDING_INVALID");
  const bindings = canonicalClone([...unsafeBindings]) as FreshComputeOptimizerExportBinding[];
  if (bindings.length !== planSet.plans.length) {
    if (bindings.length < planSet.plans.length) reject("MISSING_FRESH_BINDING");
    reject("DUPLICATE_FRESH_BINDING");
  }
  const planById = new Map(planSet.plans.map((plan, index) => [plan.planId, { plan, index }]));
  const seenPlans = new Set<string>();
  const seenRuns = new Set<string>();
  const seenJobs = new Set<string>();
  let oldestLastUpdatedMs = Number.MAX_SAFE_INTEGER;
  let newestResolvedMs = -1;
  const indexed: Array<{ index: number; binding: FreshComputeOptimizerExportBinding }> = [];

  for (const binding of bindings as unknown[]) {
    if (
      !isRecord(binding)
      || !exactKeys(binding, [
        "schemaVersion", "discoveryRunId", "resolvedAtIso", "expiresAtIso", "binding",
        "jobChronology",
      ])
      || binding.schemaVersion !== "sutra.compute-optimizer-export-fresh-binding.v1"
      || typeof binding.discoveryRunId !== "string"
      || !RUN_ID.test(binding.discoveryRunId)
      || !isRecord(binding.binding)
      || !exactKeys(binding.binding, ["planId", "contentSha256", "targets"])
      || typeof binding.binding.planId !== "string"
      || typeof binding.binding.contentSha256 !== "string"
      || !Array.isArray(binding.binding.targets)
      || !Array.isArray(binding.jobChronology)
    ) reject("FRESH_BINDING_INVALID");
    const planned = planById.get(binding.binding.planId);
    if (planned === undefined || binding.binding.contentSha256 !== planned.plan.contentSha256) {
      reject("FRESH_BINDING_INVALID");
    }
    if (seenPlans.has(planned.plan.planId) || seenRuns.has(binding.discoveryRunId)) {
      reject("DUPLICATE_FRESH_BINDING");
    }
    seenPlans.add(planned.plan.planId);
    seenRuns.add(binding.discoveryRunId);
    if (
      binding.binding.targets.length !== planned.plan.targets.length
      || binding.jobChronology.length !== planned.plan.targets.length
    ) reject("CHRONOLOGY_INVALID");

    const resolvedAtMs = canonicalIsoMs(binding.resolvedAtIso);
    const expiresAtMs = canonicalIsoMs(binding.expiresAtIso);
    if (
      resolvedAtMs >= expiresAtMs
      || materializedAtMs < resolvedAtMs
      || expiresAtMs > resolvedAtMs
        + COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumBindingLifetimeMs
    ) reject("CHRONOLOGY_INVALID");
    if (materializedAtMs >= expiresAtMs) reject("FRESH_BINDING_EXPIRED");
    newestResolvedMs = Math.max(newestResolvedMs, resolvedAtMs);

    for (let index = 0; index < planned.plan.targets.length; index += 1) {
      const target = planned.plan.targets[index]!;
      const boundTarget = binding.binding.targets[index];
      const chronology = binding.jobChronology[index];
      if (!sameFreshTarget(boundTarget, target)
        || !isRecord(chronology)
        || !exactKeys(chronology, [
          "jobId", "creationTimestampIso", "lastUpdatedTimestampIso",
        ])
        || chronology.jobId !== target.expectedJob.jobId
        || seenJobs.has(chronology.jobId as string)) reject("CHRONOLOGY_INVALID");
      seenJobs.add(chronology.jobId as string);
      const creationMs = canonicalIsoMs(chronology.creationTimestampIso);
      const lastUpdatedMs = canonicalIsoMs(chronology.lastUpdatedTimestampIso);
      const visibilityExpiry = creationMs
        + COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.describeVisibilityMs
        - COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.minimumVisibilityRemainingMs;
      if (
        lastUpdatedMs < creationMs
        || lastUpdatedMs > resolvedAtMs
          + COMPUTE_OPTIMIZER_EXPORT_FRESH_RESOLVER_BOUNDS.maximumClockSkewMs
        || expiresAtMs > visibilityExpiry
      ) reject("CHRONOLOGY_INVALID");
      oldestLastUpdatedMs = Math.min(oldestLastUpdatedMs, lastUpdatedMs);
    }
    indexed.push({
      index: planned.index,
      binding: binding as unknown as FreshComputeOptimizerExportBinding,
    });
  }
  if (seenPlans.size !== planSet.plans.length) reject("MISSING_FRESH_BINDING");
  if (oldestLastUpdatedMs === Number.MAX_SAFE_INTEGER || newestResolvedMs < 0) {
    reject("CHRONOLOGY_INVALID");
  }
  indexed.sort((left, right) => left.index - right.index);
  return deepFreeze({
    bindings: indexed.map((value) => value.binding),
    dataThroughAtIso: new Date(oldestLastUpdatedMs).toISOString(),
    observedAtIso: new Date(newestResolvedMs).toISOString(),
  });
}

async function assess(
  unsafePlanSet: ComputeOptimizerExportPlanSet,
  unsafeTargets: readonly MappedComputeOptimizerExportTarget[],
  unsafeFreshBindings: readonly FreshComputeOptimizerExportBinding[],
  options: ComputeOptimizerExportGenerationOptions,
): Promise<AssessedEvidence> {
  const limits = limitsFrom(options);
  let planSet: ComputeOptimizerExportPlanSet;
  try {
    planSet = await verifyComputeOptimizerExportPlanSet(structuredClone(unsafePlanSet));
  } catch {
    reject("PLAN_SET_INVALID");
  }
  const chronology = validateFreshBindings(
    planSet,
    unsafeFreshBindings,
    options.materializedAtMs,
  );
  if (!Array.isArray(unsafeTargets)) reject("INVALID_INPUT");
  if (unsafeTargets.length > limits.maximumTargets) reject("LIMIT_EXCEEDED");
  const targets = canonicalClone([...unsafeTargets]) as MappedComputeOptimizerExportTarget[];
  const plannedByPair = new Map<string, ComputeOptimizerExportPlanTarget>();
  for (const plan of planSet.plans) {
    for (const target of plan.targets) plannedByPair.set(pair(target.region, target.exportFamily), target);
  }
  if (plannedByPair.size > limits.maximumTargets) reject("LIMIT_EXCEEDED");

  const seenPairs = new Set<string>();
  const seenJobs = new Set<string>();
  const seenObjects = new Set<string>();
  const seenResources = new Set<string>();
  let rowCount = 0;
  let recommendationCount = 0;
  let rejectedRowCount = 0;
  let sourceBytes = 0;
  for (const target of targets as unknown[]) {
    if (!isRecord(target) || !isRecord(target.source)
      || typeof target.source.region !== "string" || typeof target.source.exportFamily !== "string") {
      reject("TARGET_SUBSTITUTION");
    }
    const key = pair(target.source.region, target.source.exportFamily);
    if (seenPairs.has(key)) reject("DUPLICATE_TARGET");
    const planned = plannedByPair.get(key);
    if (planned === undefined) reject("TARGET_SUBSTITUTION");
    if (Array.isArray(target.recommendations)) {
      for (const recommendation of target.recommendations) {
        if (!isRecord(recommendation) || !Array.isArray(recommendation.savings)) continue;
        for (const channel of recommendation.savings) {
          if (isRecord(channel)
            && (channel.normalizationState === "EXACT_DOCUMENTED_CSV_LABEL"
              || channel.normalizationState === "EXACT_API_FIELD_NAME_UNVERIFIED")
            && !validNormalizedSavings(channel)) reject("NUMERIC_EVIDENCE_INVALID");
        }
      }
    }
    validateTargetShape(target, planned, planSet.partition);
    seenPairs.add(key);
    if (seenJobs.has(target.source.jobId)) reject("TARGET_SUBSTITUTION");
    seenJobs.add(target.source.jobId);
    for (const object of [target.source.csvObject, target.source.metadataObject]) {
      const address = `${target.source.region}\u0000${target.source.bucket}\u0000${object.key}\u0000${object.versionId ?? "CURRENT"}`;
      if (seenObjects.has(address)) reject("DUPLICATE_OBJECT");
      seenObjects.add(address);
      sourceBytes = safeAdd(sourceBytes, object.bytes);
    }
    rowCount = safeAdd(rowCount, target.rowCount);
    recommendationCount = safeAdd(recommendationCount, target.recommendationCount);
    rejectedRowCount = safeAdd(rejectedRowCount, target.rejectedRowCount);
    for (const recommendation of target.recommendations) {
      // Idle-resource exports intentionally overlap dedicated resource-family
      // exports. Uniqueness is therefore target-scoped and mirrors the mapper's
      // account/ARN/native-ID key instead of discarding valid cross-family evidence.
      const resource = `${key}\u0000${recommendation.accountId}\u0000${recommendation.resourceArn}\u0000${recommendation.resourceId}`;
      if (seenResources.has(resource)) reject("DUPLICATE_RESOURCE");
      seenResources.add(resource);
    }
  }
  if (
    rowCount > limits.maximumAggregateRows
    || recommendationCount > limits.maximumRecommendations
    || rejectedRowCount > limits.maximumRejectedRows
    || sourceBytes > limits.maximumAggregateSourceBytes
  ) reject("LIMIT_EXCEEDED");

  targets.sort((left, right) => compare(left.source.region, right.source.region)
    || compare(left.source.exportFamily, right.source.exportFamily));
  const missingTargets = [...plannedByPair]
    .filter(([key]) => !seenPairs.has(key))
    .map(([, target]) => ({ region: target.region, exportFamily: target.exportFamily }))
    .sort((left, right) => compare(left.region, right.region)
      || compare(left.exportFamily, right.exportFamily));
  const assurances = [...new Set(targets.map((target) => target.schemaAssurance))].sort();
  const unresolvedKeys = targets
    .filter((target) => target.schemaAssurance !== "OFFICIAL_USER_GUIDE_CSV_LABELS"
      || target.recommendations.some((recommendation) => recommendation.savings.some(
        (channel) => channel.normalizationState !== "EXACT_DOCUMENTED_CSV_LABEL",
      )))
    .map((target) => ({ region: target.source.region, exportFamily: target.source.exportFamily }));
  const unresolvedSavings = targets.reduce((sum, target) => sum + target.recommendations.reduce(
    (inner, recommendation) => inner + recommendation.savings.filter(
      (channel) => channel.normalizationState !== "EXACT_DOCUMENTED_CSV_LABEL",
    ).length,
    0,
  ), 0);
  const evidence: AssessedEvidence = {
    planSetId: planSet.planSetId,
    planSetContentSha256: planSet.contentSha256,
    scope: { ...planSet.scope },
    requesterAccountId: planSet.requesterAccountId,
    partition: planSet.partition,
    regions: [...planSet.regions],
    exportFamilies: [...planSet.exportFamilies],
    planIds: [...planSet.planIds],
    scheduledWindow: options.scheduledWindow,
    materializedAtIso: new Date(options.materializedAtMs).toISOString(),
    dataThroughAtIso: chronology.dataThroughAtIso,
    observedAtIso: chronology.observedAtIso,
    freshBindings: chronology.bindings,
    coverage: {
      expectedTargetCount: plannedByPair.size,
      mappedTargetCount: targets.length,
      rowCount,
      recommendationCount,
      rejectedRowCount,
      sourceBytes,
    },
    schemaAssurances: assurances,
    unresolvedEvidence: {
      targetCount: unresolvedKeys.length,
      savingsChannelCount: unresolvedSavings,
      targetKeys: unresolvedKeys,
    },
    targets,
    missingTargets,
  };
  const serializedBytes = new TextEncoder().encode(canonicalJson(evidence)).byteLength;
  if (serializedBytes > limits.maximumSerializedBytes) reject("LIMIT_EXCEEDED");
  return deepFreeze(evidence);
}

export async function createComputeOptimizerExportGenerationAttempt(
  planSet: ComputeOptimizerExportPlanSet,
  mappedTargets: readonly MappedComputeOptimizerExportTarget[],
  freshBindings: readonly FreshComputeOptimizerExportBinding[],
  options: ComputeOptimizerExportGenerationOptions,
): Promise<ComputeOptimizerExportGenerationAttempt> {
  const evidence = await assess(planSet, mappedTargets, freshBindings, options);
  const body = {
    schemaVersion: "sutra.compute-optimizer-export-generation-attempt.v1" as const,
    ...evidence,
    state: evidence.missingTargets.length === 0 ? "ALL_REGION_COMPLETE" as const : "PARTIAL" as const,
    acceptedHeadEligible: false as const,
  };
  const canonical = canonicalJson(body);
  if (new TextEncoder().encode(canonical).byteLength
    > limitsFrom(options).maximumSerializedBytes) reject("LIMIT_EXCEEDED");
  const contentSha256 = await sha256(canonical);
  return deepFreeze({
    ...body,
    attemptId: `coa_${contentSha256}`,
    contentSha256,
  });
}

export async function finalizeComputeOptimizerExportGeneration(
  planSet: ComputeOptimizerExportPlanSet,
  mappedTargets: readonly MappedComputeOptimizerExportTarget[],
  freshBindings: readonly FreshComputeOptimizerExportBinding[],
  options: ComputeOptimizerExportGenerationOptions,
): Promise<ComputeOptimizerExportGeneration> {
  const evidence = await assess(planSet, mappedTargets, freshBindings, options);
  if (evidence.missingTargets.length !== 0) reject("INCOMPLETE_COVERAGE");
  const body = {
    schemaVersion: "sutra.compute-optimizer-export-generation.v1" as const,
    planSetId: evidence.planSetId,
    planSetContentSha256: evidence.planSetContentSha256,
    scope: evidence.scope,
    requesterAccountId: evidence.requesterAccountId,
    partition: evidence.partition,
    regions: evidence.regions,
    exportFamilies: evidence.exportFamilies,
    planIds: evidence.planIds,
    scheduledWindow: evidence.scheduledWindow,
    materializedAtIso: evidence.materializedAtIso,
    dataThroughAtIso: evidence.dataThroughAtIso,
    observedAtIso: evidence.observedAtIso,
    freshBindings: evidence.freshBindings,
    coverage: evidence.coverage,
    schemaAssurances: evidence.schemaAssurances,
    unresolvedEvidence: evidence.unresolvedEvidence,
    targets: evidence.targets,
    state: "ALL_REGION_ACCEPTED" as const,
    acceptedHeadEligible: true as const,
    missingTargets: [] as const,
  };
  const canonical = canonicalJson(body);
  const limits = limitsFrom(options);
  if (new TextEncoder().encode(canonical).byteLength > limits.maximumSerializedBytes) {
    reject("LIMIT_EXCEEDED");
  }
  const contentSha256 = await sha256(canonical);
  return deepFreeze({
    ...body,
    generationId: `cog_${contentSha256}`,
    contentSha256,
  });
}

export async function verifyComputeOptimizerExportGeneration(
  planSet: ComputeOptimizerExportPlanSet,
  value: unknown,
  options: ComputeOptimizerExportGenerationOptions,
): Promise<ComputeOptimizerExportGeneration> {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "generationId", "contentSha256", "planSetId", "planSetContentSha256",
      "scope", "requesterAccountId", "partition", "regions", "exportFamilies", "planIds",
      "scheduledWindow", "materializedAtIso", "dataThroughAtIso", "observedAtIso", "freshBindings",
      "coverage", "schemaAssurances", "unresolvedEvidence", "targets", "state",
      "acceptedHeadEligible", "missingTargets",
    ])
    || value.schemaVersion !== "sutra.compute-optimizer-export-generation.v1"
    || typeof value.generationId !== "string"
    || typeof value.contentSha256 !== "string"
    || !SHA256.test(value.contentSha256)
    || !Array.isArray(value.targets)
    || !Array.isArray(value.freshBindings)
  ) reject("INVALID_INPUT");
  const regenerated = await finalizeComputeOptimizerExportGeneration(
    planSet,
    value.targets as MappedComputeOptimizerExportTarget[],
    value.freshBindings as FreshComputeOptimizerExportBinding[],
    options,
  );
  if (canonicalJson(value) !== canonicalJson(regenerated)) reject("CONTENT_HASH_MISMATCH");
  return regenerated;
}
