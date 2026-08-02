/**
 * Evidence-exact mapper for one validated AWS Compute Optimizer CSVW bundle.
 *
 * Numeric evidence is never converted through JavaScript floating point.
 * Money is normalized with BigInt to signed 64-bit micros and percentages to
 * exact integer basis points. A single malformed row rejects the whole bundle.
 */

import {
  COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG,
  validateComputeOptimizerFieldsToExport,
} from "./finops-compute-optimizer-export-field-catalog.ts";
import type {
  LoadedComputeOptimizerExportObjectIdentity,
  LoadedComputeOptimizerExportTargetBundle,
} from "./finops-compute-optimizer-export-object-set.ts";
import type {
  ComputeOptimizerCsvwColumn,
  ParsedComputeOptimizerExportCell,
  ParsedComputeOptimizerExportRow,
} from "./finops-compute-optimizer-export-parser.ts";
import type {
  ComputeOptimizerExportFamily,
  ComputeOptimizerExportPlan,
  ComputeOptimizerExportPlanTarget,
  ComputeOptimizerProviderExportJobResourceType,
} from "./finops-compute-optimizer-export-plan.ts";
import { verifyComputeOptimizerExportPlan } from "./finops-compute-optimizer-export-plan.ts";

const ACCOUNT_ID = /^\d{12}$/u;
const ARN = /^arn:(aws|aws-cn|aws-us-gov):([^:]+):([^:]*):(\d{12}):(.+)$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f<>]{1,4096}$/u;
const CURRENCY = /^[A-Z]{3}$/u;
const TAG_KEY = /^[\p{L}\p{N}\p{Zs}_.:/=+@-]{1,128}$/u;
const MAX_TAG_VALUE_BYTES = 256;
const BIGINT_ZERO = BigInt(0);
const BIGINT_ONE = BigInt(1);
const SIGNED_64_MIN = -(BIGINT_ONE << BigInt(63));
const SIGNED_64_MAX = (BIGINT_ONE << BigInt(63)) - BIGINT_ONE;

export const COMPUTE_OPTIMIZER_EXPORT_MAPPER_BOUNDS = Object.freeze({
  maximumRows: 100_000,
  maximumOptionsPerRow: 10,
  maximumTagsPerRow: 256,
  maximumColumns: 2_048,
} as const);

export const COMPUTE_OPTIMIZER_EXPORT_MAPPER_DISCLOSURE = Object.freeze({
  officialCsvLabelSource:
    "https://docs.aws.amazon.com/compute-optimizer/latest/ug/exported-files.html",
  retrievedOn: "2026-08-02",
  unresolvedCsvLabelFamilies: Object.freeze([
    "LICENSE",
    "RDS_DATABASE",
    "IDLE_RESOURCE",
  ] as const),
  disclosure:
    "AWS publishes API field names but not separate CSV labels/types for the License, RDS/Aurora, and Idle list sections. Those families accept only exact API-field metadata names and retain API_FIELD_NAME_ONLY assurance until a provider CSVW fixture is captured. Dynamic tags are emitted only when CSVW metadata explicitly pairs tags_<key> with title Tag: <key>; this metadata-derived convention remains marked unverified.",
} as const);

type Datatype = ComputeOptimizerCsvwColumn["datatype"];
type MappingAssurance = "USER_GUIDE_CSV_LABEL" | "API_FIELD_NAME_ONLY";
type FieldRole =
  | "identity"
  | "finding"
  | "refresh"
  | "lookback"
  | "configuration"
  | "risk"
  | "savings"
  | "rank";

interface FieldRule {
  readonly apiField: string;
  readonly role: FieldRole;
  readonly datatypes: ReadonlySet<Datatype>;
  readonly exactColumn: string | null;
  readonly columnPattern: RegExp | null;
  readonly assurance: MappingAssurance;
  readonly ranked: boolean;
}

interface BoundColumn {
  readonly apiField: string;
  readonly role: FieldRole;
  readonly column: ComputeOptimizerCsvwColumn;
  readonly assurance: MappingAssurance;
  readonly rank: number | null;
  readonly reasonCode: string | null;
}

interface FamilyProfile {
  readonly apiProjection: readonly string[];
  readonly rules: readonly FieldRule[];
  readonly arnField: string;
  readonly nativeIdField: string | null;
}

export interface ComputeOptimizerMappedFieldEvidence {
  readonly apiField: string;
  readonly column: string;
  readonly datatype: Datatype;
  readonly raw: string;
  readonly assurance: MappingAssurance;
}

export interface ComputeOptimizerMappedFinding {
  readonly scope: "RESOURCE" | "INSTANCE" | "STORAGE";
  readonly finding: ComputeOptimizerMappedFieldEvidence;
  readonly reasons: readonly ComputeOptimizerMappedFieldEvidence[];
}

export interface ComputeOptimizerMappedSavingsChannel {
  readonly scope: "RESOURCE" | "INSTANCE" | "STORAGE";
  readonly includesExistingDiscounts: boolean;
  readonly normalizationState:
    | "EXACT_DOCUMENTED_CSV_LABEL"
    | "EXACT_API_FIELD_NAME_UNVERIFIED";
  readonly currency: string;
  readonly amountMicros: string;
  readonly percentageBasisPoints: number;
  readonly evidence: readonly ComputeOptimizerMappedFieldEvidence[];
}

export interface ComputeOptimizerOpaqueIdleSavingsChannel {
  readonly scope: "RESOURCE";
  readonly includesExistingDiscounts: boolean;
  readonly normalizationState: "UNRESOLVED_PROVIDER_CSV_LABEL";
  readonly apiField: "SavingsOpportunity" | "SavingsOpportunityAfterDiscount";
  readonly raw: string;
  readonly evidence: ComputeOptimizerMappedFieldEvidence;
}

export type ComputeOptimizerSavingsChannel =
  | ComputeOptimizerMappedSavingsChannel
  | ComputeOptimizerOpaqueIdleSavingsChannel;

export interface ComputeOptimizerMappedTagEvidence {
  readonly key: string;
  readonly value: string;
  readonly column: string;
  readonly assurance: "CSVW_NAME_AND_TITLE";
}

export interface ComputeOptimizerMappedRankedOption {
  readonly rank: number;
  readonly configuration: readonly ComputeOptimizerMappedFieldEvidence[];
  readonly risk: ComputeOptimizerMappedFieldEvidence | null;
}

export interface ComputeOptimizerMappedRdsRecommendation {
  readonly instance: {
    readonly availability: "PRESENT" | "ABSENT_IN_PROVIDER_ROW";
    readonly finding: ComputeOptimizerMappedFinding | null;
    readonly configuration: readonly ComputeOptimizerMappedFieldEvidence[];
    readonly risk: readonly ComputeOptimizerMappedFieldEvidence[];
    readonly savings: readonly ComputeOptimizerSavingsChannel[];
  };
  readonly storage: {
    readonly availability: "PRESENT" | "ABSENT_IN_PROVIDER_ROW";
    readonly finding: ComputeOptimizerMappedFinding | null;
    readonly configuration: readonly ComputeOptimizerMappedFieldEvidence[];
    readonly savings: readonly ComputeOptimizerSavingsChannel[];
  };
  readonly auroraStorageIdentity: {
    readonly providerResourceType: ComputeOptimizerProviderExportJobResourceType;
    readonly dbClusterIdentifier: ComputeOptimizerMappedFieldEvidence;
    readonly clusterWriter: ComputeOptimizerMappedFieldEvidence | null;
    readonly promotionTier: ComputeOptimizerMappedFieldEvidence | null;
  } | null;
}

export interface ComputeOptimizerMappedRecommendation {
  readonly rowNumber: number;
  readonly accountId: string;
  readonly resourceArn: string;
  readonly resourceId: string;
  readonly resourceIdSource: "EXPORTED" | "ARN" | "EXPORTED_NAME";
  readonly region: string;
  readonly exportFamily: ComputeOptimizerExportFamily;
  readonly findings: readonly ComputeOptimizerMappedFinding[];
  readonly lastRefreshTimestamp: string;
  readonly lookbackPeriodLexeme: string;
  readonly currentConfiguration: readonly ComputeOptimizerMappedFieldEvidence[];
  readonly recommendedConfiguration: readonly ComputeOptimizerMappedFieldEvidence[];
  readonly currentRisk: readonly ComputeOptimizerMappedFieldEvidence[];
  readonly rankedOptions: readonly ComputeOptimizerMappedRankedOption[];
  readonly savings: readonly ComputeOptimizerSavingsChannel[];
  readonly tags: readonly ComputeOptimizerMappedTagEvidence[];
  readonly rds: ComputeOptimizerMappedRdsRecommendation | null;
}

export interface ComputeOptimizerRejectedRowEvidence {
  readonly rowNumber: number;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly accountId: string | null;
  readonly resourceArn: string | null;
}

export interface ComputeOptimizerMappedSourceLineage {
  readonly region: string;
  readonly exportFamily: ComputeOptimizerExportFamily;
  readonly providerResourceType: ComputeOptimizerProviderExportJobResourceType;
  readonly requestSha256: string;
  readonly jobId: string;
  readonly bucket: string;
  readonly csvObject: LoadedComputeOptimizerExportObjectIdentity;
  readonly metadataObject: LoadedComputeOptimizerExportObjectIdentity;
  readonly csvBasename: string;
  readonly csvSha256: string;
  readonly metadataSha256: string;
  readonly modifiedDate: string | null;
}

export interface MappedComputeOptimizerExportTarget {
  readonly schemaVersion: "sutra.compute-optimizer-export-mapped-target.v1";
  readonly source: ComputeOptimizerMappedSourceLineage;
  readonly schemaAssurance:
    | "OFFICIAL_USER_GUIDE_CSV_LABELS"
    | "API_FIELD_NAME_ONLY_UNVERIFIED"
    | "METADATA_DERIVED_TAG_COLUMNS_UNVERIFIED";
  readonly rowCount: number;
  readonly recommendationCount: number;
  readonly rejectedRowCount: number;
  readonly recommendations: readonly ComputeOptimizerMappedRecommendation[];
  readonly rejectedRows: readonly ComputeOptimizerRejectedRowEvidence[];
}

export class ComputeOptimizerExportMapperError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "LIMIT_EXCEEDED"
      | "SOURCE_LINEAGE_MISMATCH"
      | "PROJECTION_MISMATCH"
      | "SCHEMA_MISMATCH"
      | "ROW_EVIDENCE_INVALID"
      | "NUMERIC_EVIDENCE_INVALID"
      | "TAG_EVIDENCE_INVALID"
      | "RANK_MISMATCH"
      | "DUPLICATE_RESOURCE",
  ) {
    super("Compute Optimizer export mapping rejected");
    this.name = "ComputeOptimizerExportMapperError";
  }
}

function reject(code: ComputeOptimizerExportMapperError["code"]): never {
  throw new ComputeOptimizerExportMapperError(code);
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function set(...values: Datatype[]): ReadonlySet<Datatype> {
  return new Set(values);
}

const STRING = set("string");
const DATETIME = set("datetime");
const INTEGER = set("integer");
const NUMERIC = set("integer", "double");
const RISK = set("string", "double", "integer");

const USER_GUIDE_COLUMNS: Readonly<
  Partial<Record<ComputeOptimizerExportFamily, Readonly<Record<string, string>>>>
> = Object.freeze({
  EC2_INSTANCE: Object.freeze({
    AccountId: "accountId",
    CurrentInstanceType: "currentInstanceType",
    Finding: "finding",
    InstanceArn: "instanceArn",
    LastRefreshTimestamp: "lastRefreshTimestamp_UTC",
    LookbackPeriodInDays: "lookBackPeriodInDays",
  }),
  AUTO_SCALING_GROUP: Object.freeze({
    AccountId: "accountId",
    AutoScalingGroupArn: "autoScalingGroupArn",
    AutoScalingGroupName: "autoScalingGroupName",
    CurrentConfigurationDesiredCapacity: "currentConfiguration_desiredCapacity",
    CurrentConfigurationInstanceType: "currentConfiguration_instanceType",
    Finding: "finding",
    LastRefreshTimestamp: "lastRefreshTimestamp",
    LookbackPeriodInDays: "lookBackPeriodInDays",
  }),
  EBS_VOLUME: Object.freeze({
    AccountId: "accountId",
    Finding: "finding",
    LastRefreshTimestamp: "lastRefreshTimestamp",
    LookbackPeriodInDays: "lookBackPeriodInDays",
  }),
  LAMBDA_FUNCTION: Object.freeze({
    AccountId: "accountId",
    Finding: "finding",
    LastRefreshTimestamp: "lastRefreshTimestamp",
    LookbackPeriodInDays: "lookBackPeriodInDays",
  }),
  ECS_SERVICE: Object.freeze({
    AccountId: "accountId",
    CurrentServiceConfigurationCpu: "currentServiceConfiguration_cpu",
    CurrentServiceConfigurationMemory: "currentServiceConfiguration_memory",
    CurrentServiceConfigurationTaskDefinitionArn: "currentServiceConfiguration_taskDefinitionArn",
    Finding: "findings",
    LastRefreshTimestamp: "lastRefreshTimestamp_UTC",
    LaunchType: "launchType",
    LookbackPeriodInDays: "lookBackPeriodInDays",
    ServiceArn: "serviceArn",
  }),
});

const RANKED_PATTERNS: Readonly<
  Partial<Record<ComputeOptimizerExportFamily, Readonly<Record<string, RegExp>>>>
> = Object.freeze({
  EC2_INSTANCE: Object.freeze({
    RecommendationOptionsInstanceType: /^recommendationOptions_([1-9]\d*)_instanceType$/u,
    RecommendationOptionsPerformanceRisk: /^recommendationOptions_([1-9]\d*)_performanceRisk$/u,
  }),
  AUTO_SCALING_GROUP: Object.freeze({
    RecommendationOptionsConfigurationDesiredCapacity:
      /^recommendationOptions_([1-9]\d*)_configuration_desiredCapacity$/u,
    RecommendationOptionsConfigurationInstanceType:
      /^recommendationOptions_([1-9]\d*)_configuration_instanceType$/u,
    RecommendationOptionsPerformanceRisk: /^recommendationOptions_([1-9]\d*)_performanceRisk$/u,
  }),
  EBS_VOLUME: Object.freeze({
    RecommendationOptionsConfigurationVolumeBaselineIOPS:
      /^RecommendationOptions_([1-9]\d*)_ConfigurationVolumeBaselineIOPS$/u,
    RecommendationOptionsConfigurationVolumeBaselineThroughput:
      /^RecommendationOptions_([1-9]\d*)_ConfigurationVolumeBaselineThroughput$/u,
    RecommendationOptionsConfigurationVolumeSize:
      /^RecommendationOptions_([1-9]\d*)_ConfigurationVolumeSize$/u,
    RecommendationOptionsConfigurationVolumeType:
      /^RecommendationOptions_([1-9]\d*)_ConfigurationVolumeType$/u,
    RecommendationOptionsPerformanceRisk: /^recommendationOptions_([1-9]\d*)_performanceRisk$/u,
  }),
  LAMBDA_FUNCTION: Object.freeze({
    RecommendationOptionsConfigurationMemorySize:
      /^RecommendationOptions_([1-9]\d*)_ConfigurationMemorySize$/u,
  }),
  ECS_SERVICE: Object.freeze({
    RecommendationOptionsCpu: /^recommendationOptions_([1-9]\d*)_cpu$/u,
    RecommendationOptionsMemory: /^recommendationOptions_([1-9]\d*)_memory$/u,
  }),
});

const REASON_PATTERNS: Readonly<Partial<Record<ComputeOptimizerExportFamily, RegExp>>> =
  Object.freeze({
    EC2_INSTANCE: /^findingReasonCodes_([A-Za-z0-9]+)$/u,
    ECS_SERVICE: /^findingReasonCodes_([A-Za-z0-9]+)$/u,
  });

const INTEGER_FIELDS = new Set([
  "CurrentConfigurationDesiredCapacity",
  "RecommendationOptionsConfigurationDesiredCapacity",
  "CurrentConfigurationVolumeBaselineIOPS",
  "CurrentConfigurationVolumeBaselineThroughput",
  "CurrentConfigurationVolumeSize",
  "RecommendationOptionsConfigurationVolumeBaselineIOPS",
  "RecommendationOptionsConfigurationVolumeBaselineThroughput",
  "RecommendationOptionsConfigurationVolumeSize",
  "CurrentConfigurationMemorySize",
  "CurrentConfigurationTimeout",
  "RecommendationOptionsConfigurationMemorySize",
  "CurrentServiceConfigurationCpu",
  "CurrentServiceConfigurationMemory",
  "RecommendationOptionsCpu",
  "RecommendationOptionsMemory",
  "CurrentLicenseConfigurationNumberOfCores",
  "CurrentStorageConfigurationAllocatedStorage",
  "CurrentStorageConfigurationIOPS",
  "CurrentStorageConfigurationMaxAllocatedStorage",
  "CurrentStorageConfigurationStorageThroughput",
  "StorageRecommendationOptionsAllocatedStorage",
  "StorageRecommendationOptionsIOPS",
  "StorageRecommendationOptionsMaxAllocatedStorage",
  "StorageRecommendationOptionsStorageThroughput",
  "InstanceRecommendationOptionsRank",
  "StorageRecommendationOptionsRank",
  "PromotionTier",
]);

function roleFor(family: ComputeOptimizerExportFamily, apiField: string): FieldRole {
  const capabilities = COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[family].capabilityProjection;
  if (apiField === "LookbackPeriodInDays") return "lookback";
  if (apiField.endsWith("Rank")) return "rank";
  for (const role of [
    "identity",
    "finding",
    "refresh",
    "configuration",
    "risk",
    "savings",
  ] as const) {
    if (capabilities[role].fields.includes(apiField)) return role;
  }
  if (/Savings|Currency|Percentage/u.test(apiField)) return "savings";
  reject("PROJECTION_MISMATCH");
}

function datatypesFor(apiField: string, role: FieldRole): ReadonlySet<Datatype> {
  if (apiField === "LastRefreshTimestamp") return DATETIME;
  if (apiField === "LookbackPeriodInDays") return NUMERIC;
  if (apiField.includes("EstimatedMonthlySavingsValue")) return NUMERIC;
  if (/SavingsOpportunity.*Percentage$/u.test(apiField)) return NUMERIC;
  if (apiField === "SavingsOpportunity" || apiField === "SavingsOpportunityAfterDiscount") {
    return STRING;
  }
  if (INTEGER_FIELDS.has(apiField)) return INTEGER;
  if (role === "risk") return RISK;
  return STRING;
}

function additionalProjection(family: ComputeOptimizerExportFamily): readonly string[] {
  if (family === "IDLE_RESOURCE") return ["LookbackPeriodInDays"];
  const additions = ["LookbackPeriodInDays"];
  if (["EC2_INSTANCE", "AUTO_SCALING_GROUP", "EBS_VOLUME", "LAMBDA_FUNCTION", "ECS_SERVICE"]
    .includes(family)) {
    additions.push(
      "RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
      "RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
      "RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
    );
  }
  if (family === "RDS_DATABASE") {
    additions.push(
      "InstanceRecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
      "InstanceRecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
      "InstanceRecommendationOptionsRank",
      "InstanceRecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
      "StorageRecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
      "StorageRecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
      "StorageRecommendationOptionsRank",
      "StorageRecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
    );
  }
  return additions;
}

function buildProfile(
  family: ComputeOptimizerExportFamily,
  requestedProjection: readonly string[],
): FamilyProfile {
  const catalog = COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[family];
  const apiProjection = Object.freeze([...requestedProjection]);
  validateComputeOptimizerFieldsToExport(family, catalog.operation, apiProjection);
  const supported = new Set([...catalog.minimumProjection, ...additionalProjection(family)]);
  if (
    !apiProjection.includes("LookbackPeriodInDays")
    || apiProjection.some((field) => !supported.has(field))
  ) reject("PROJECTION_MISMATCH");
  const guide = USER_GUIDE_COLUMNS[family] ?? {};
  const ranked = RANKED_PATTERNS[family] ?? {};
  const reasonPattern = REASON_PATTERNS[family];
  const rules = apiProjection
    .filter((apiField) => apiField !== "Tags")
    .map((apiField): FieldRule => {
      const role = roleFor(family, apiField);
      const rankPattern = ranked[apiField];
      const isReason = apiField.endsWith("FindingReasonCodes")
        || apiField === "FindingReasonCodes";
      const columnPattern = rankPattern ?? (isReason ? reasonPattern : undefined) ?? null;
      const exactColumn = columnPattern === null ? (guide[apiField] ?? apiField) : null;
      return Object.freeze({
        apiField,
        role,
        datatypes: datatypesFor(apiField, role),
        exactColumn,
        columnPattern,
        assurance: guide[apiField] !== undefined || columnPattern !== null
          ? "USER_GUIDE_CSV_LABEL"
          : "API_FIELD_NAME_ONLY",
        ranked: rankPattern !== undefined,
      });
    });
  const arnField = ({
    EC2_INSTANCE: "InstanceArn",
    AUTO_SCALING_GROUP: "AutoScalingGroupArn",
    EBS_VOLUME: "VolumeArn",
    LAMBDA_FUNCTION: "FunctionArn",
    ECS_SERVICE: "ServiceArn",
    LICENSE: "ResourceArn",
    RDS_DATABASE: "ResourceArn",
    IDLE_RESOURCE: "ResourceArn",
  } as const)[family];
  const nativeIdField = family === "IDLE_RESOURCE"
    ? "ResourceId"
    : family === "AUTO_SCALING_GROUP" ? "AutoScalingGroupName" : null;
  return Object.freeze({ apiProjection, rules: Object.freeze(rules), arnField, nativeIdField });
}

function bindColumns(
  family: ComputeOptimizerExportFamily,
  columns: readonly ComputeOptimizerCsvwColumn[],
  profile: FamilyProfile,
): { readonly fields: ReadonlyMap<string, readonly BoundColumn[]>; readonly tagColumns: readonly ComputeOptimizerCsvwColumn[] } {
  if (columns.length < 1 || columns.length > COMPUTE_OPTIMIZER_EXPORT_MAPPER_BOUNDS.maximumColumns) {
    reject("LIMIT_EXCEEDED");
  }
  const byName = new Map(columns.map((column) => [column.name, column]));
  if (byName.size !== columns.length) reject("SCHEMA_MISMATCH");
  const count = byName.get("recommendations_count");
  const errorCode = byName.get("errorCode");
  const errorMessage = byName.get("errorMessage");
  if (
    count?.datatype !== "integer"
    || errorCode?.datatype !== "string"
    || errorMessage?.datatype !== "string"
  ) reject("SCHEMA_MISMATCH");

  const consumed = new Set(["recommendations_count", "errorCode", "errorMessage"]);
  const fields = new Map<string, readonly BoundColumn[]>();
  for (const rule of profile.rules) {
    const matches: BoundColumn[] = [];
    for (const column of columns) {
      let rank: number | null = null;
      let reasonCode: string | null = null;
      let matched = rule.exactColumn === column.name;
      if (!matched && rule.columnPattern !== null) {
        const match = rule.columnPattern.exec(column.name);
        if (match !== null) {
          matched = true;
          if (rule.ranked) {
            const parsedRank = BigInt(match[1]!);
            if (
              parsedRank < BIGINT_ONE
              || parsedRank > BigInt(COMPUTE_OPTIMIZER_EXPORT_MAPPER_BOUNDS.maximumOptionsPerRow)
            ) reject("LIMIT_EXCEEDED");
            rank = Number(parsedRank);
          } else {
            reasonCode = match[1] ?? null;
          }
        }
      }
      if (!matched) continue;
      if (!rule.datatypes.has(column.datatype)) reject("SCHEMA_MISMATCH");
      consumed.add(column.name);
      matches.push(Object.freeze({
        apiField: rule.apiField,
        role: rule.role,
        column,
        assurance: rule.assurance,
        rank,
        reasonCode,
      }));
    }
    if (matches.length < 1) reject("PROJECTION_MISMATCH");
    if (rule.columnPattern === null && matches.length !== 1) reject("SCHEMA_MISMATCH");
    fields.set(rule.apiField, Object.freeze(matches.sort((left, right) =>
      (left.rank ?? 0) - (right.rank ?? 0) || compare(left.column.name, right.column.name))));
  }

  const tagColumns: ComputeOptimizerCsvwColumn[] = [];
  if (COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[family].capabilityProjection.tags.supported) {
    for (const column of columns) {
      if (!column.name.startsWith("tags_")) continue;
      const key = column.name.slice(5);
      if (
        column.datatype !== "string"
        || column.titles !== `Tag: ${key}`
        || !TAG_KEY.test(key)
        || key.trim() !== key
        || ["__proto__", "prototype", "constructor"].includes(key)
      ) reject("TAG_EVIDENCE_INVALID");
      consumed.add(column.name);
      tagColumns.push(column);
    }
  }
  if (tagColumns.length > COMPUTE_OPTIMIZER_EXPORT_MAPPER_BOUNDS.maximumTagsPerRow) {
    reject("LIMIT_EXCEEDED");
  }
  if (columns.some((column) => !consumed.has(column.name))) reject("SCHEMA_MISMATCH");
  return Object.freeze({
    fields,
    tagColumns: Object.freeze(tagColumns.sort((left, right) => compare(left.name, right.name))),
  });
}

function rowCells(row: ParsedComputeOptimizerExportRow): ReadonlyMap<string, ParsedComputeOptimizerExportCell> {
  const result = new Map(row.cells.map((cell) => [cell.column, cell]));
  if (result.size !== row.cells.length) reject("SCHEMA_MISMATCH");
  return result;
}

function cellFor(
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
  column: string,
): ParsedComputeOptimizerExportCell {
  const cell = cells.get(column);
  if (cell === undefined) reject("SCHEMA_MISMATCH");
  return cell;
}

function evidence(bound: BoundColumn, cell: ParsedComputeOptimizerExportCell): ComputeOptimizerMappedFieldEvidence {
  if (cell.isNull || cell.raw.length === 0) reject("ROW_EVIDENCE_INVALID");
  return Object.freeze({
    apiField: bound.apiField,
    column: bound.column.name,
    datatype: bound.column.datatype,
    raw: cell.raw,
    assurance: bound.assurance,
  });
}

function valuesFor(
  apiField: string,
  bound: ReadonlyMap<string, readonly BoundColumn[]>,
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
): readonly ComputeOptimizerMappedFieldEvidence[] {
  const columns = bound.get(apiField);
  if (columns === undefined) reject("PROJECTION_MISMATCH");
  return Object.freeze(columns.flatMap((column) => {
    const cell = cellFor(cells, column.column.name);
    return cell.isNull || cell.raw.length === 0 ? [] : [evidence(column, cell)];
  }));
}

function requiredValue(
  apiField: string,
  bound: ReadonlyMap<string, readonly BoundColumn[]>,
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
): ComputeOptimizerMappedFieldEvidence {
  const values = valuesFor(apiField, bound, cells);
  if (values.length !== 1) reject("ROW_EVIDENCE_INVALID");
  return values[0]!;
}

function optionalValue(
  apiField: string,
  bound: ReadonlyMap<string, readonly BoundColumn[]>,
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
): ComputeOptimizerMappedFieldEvidence | null {
  const values = valuesFor(apiField, bound, cells);
  if (values.length > 1) reject("ROW_EVIDENCE_INVALID");
  return values[0] ?? null;
}

function numericLexeme(
  field: ComputeOptimizerMappedFieldEvidence,
  cell: ParsedComputeOptimizerExportCell,
): string {
  if (field.datatype === "integer" && cell.integerLexeme !== null) return cell.integerLexeme;
  if (field.datatype === "double" && cell.decimalLexeme !== null) return cell.decimalLexeme;
  reject("NUMERIC_EVIDENCE_INVALID");
}

function scaledInteger(lexeme: string, scale: number): bigint {
  const negative = lexeme.startsWith("-");
  const unsigned = negative ? lexeme.slice(1) : lexeme;
  const [whole, fraction = ""] = unsigned.split(".");
  if (whole === undefined || fraction.slice(scale).replaceAll("0", "") !== "") {
    reject("NUMERIC_EVIDENCE_INVALID");
  }
  const result = BigInt(`${whole}${fraction.slice(0, scale).padEnd(scale, "0")}`);
  return negative ? -result : result;
}

function exactMoneyMicros(
  value: ComputeOptimizerMappedFieldEvidence,
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
): string {
  const scaled = scaledInteger(numericLexeme(value, cellFor(cells, value.column)), 6);
  if (scaled < SIGNED_64_MIN || scaled > SIGNED_64_MAX) reject("NUMERIC_EVIDENCE_INVALID");
  return scaled.toString();
}

function exactBasisPoints(
  value: ComputeOptimizerMappedFieldEvidence,
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
): number {
  const scaled = scaledInteger(numericLexeme(value, cellFor(cells, value.column)), 2);
  if (scaled < BIGINT_ZERO || scaled > BigInt(10_000)) reject("NUMERIC_EVIDENCE_INVALID");
  return Number(scaled);
}

function savingsChannel(
  scope: "RESOURCE" | "INSTANCE" | "STORAGE",
  includesExistingDiscounts: boolean,
  prefix: string,
  suffix: string,
  bound: ReadonlyMap<string, readonly BoundColumn[]>,
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
): ComputeOptimizerMappedSavingsChannel | null {
  const fields = [
    `${prefix}EstimatedMonthlySavingsCurrency${suffix}`,
    `${prefix}EstimatedMonthlySavingsValue${suffix}`,
    `${prefix}SavingsOpportunity${suffix}Percentage`,
  ] as const;
  if (fields.some((field) => !bound.has(field))) return null;
  const projected = fields.map((field) => valuesFor(field, bound, cells));
  const present = projected.reduce((sum, values) => sum + values.length, 0);
  if (present === 0) return null;
  if (present !== fields.length || projected.some((values) => values.length !== 1)) {
    reject("ROW_EVIDENCE_INVALID");
  }
  const [currency, amount, percentage] = projected.map((values) => values[0]!) as [
    ComputeOptimizerMappedFieldEvidence,
    ComputeOptimizerMappedFieldEvidence,
    ComputeOptimizerMappedFieldEvidence,
  ];
  if (!CURRENCY.test(currency.raw)) reject("NUMERIC_EVIDENCE_INVALID");
  return Object.freeze({
    scope,
    includesExistingDiscounts,
    normalizationState: [currency, amount, percentage].some((field) =>
      field.assurance === "API_FIELD_NAME_ONLY")
      ? "EXACT_API_FIELD_NAME_UNVERIFIED"
      : "EXACT_DOCUMENTED_CSV_LABEL",
    currency: currency.raw,
    amountMicros: exactMoneyMicros(amount, cells),
    percentageBasisPoints: exactBasisPoints(percentage, cells),
    evidence: Object.freeze([currency, amount, percentage].sort((left, right) =>
      compare(left.apiField, right.apiField))),
  });
}

function mappedSavings(
  family: ComputeOptimizerExportFamily,
  bound: ReadonlyMap<string, readonly BoundColumn[]>,
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
): readonly ComputeOptimizerSavingsChannel[] {
  if (family === "IDLE_RESOURCE") {
    return Object.freeze(([
      ["SavingsOpportunity", false],
      ["SavingsOpportunityAfterDiscount", true],
    ] as const).flatMap(([apiField, discounted]) => {
      if (!bound.has(apiField)) return [];
      const values = valuesFor(apiField, bound, cells);
      if (values.length === 0) return [];
      if (values.length !== 1) reject("ROW_EVIDENCE_INVALID");
      const value = values[0]!;
      return Object.freeze({
        scope: "RESOURCE",
        includesExistingDiscounts: discounted as boolean,
        normalizationState: "UNRESOLVED_PROVIDER_CSV_LABEL",
        apiField: apiField as "SavingsOpportunity" | "SavingsOpportunityAfterDiscount",
        raw: value.raw,
        evidence: value,
      }) as ComputeOptimizerOpaqueIdleSavingsChannel;
    }));
  }
  if (family === "RDS_DATABASE") {
    return Object.freeze(([
      savingsChannel("INSTANCE", false, "InstanceRecommendationOptions", "", bound, cells),
      savingsChannel(
        "INSTANCE",
        true,
        "InstanceRecommendationOptions",
        "AfterDiscounts",
        bound,
        cells,
      ),
      savingsChannel("STORAGE", false, "StorageRecommendationOptions", "", bound, cells),
      savingsChannel(
        "STORAGE",
        true,
        "StorageRecommendationOptions",
        "AfterDiscounts",
        bound,
        cells,
      ),
    ]).filter((channel): channel is ComputeOptimizerMappedSavingsChannel => channel !== null));
  }
  const channels = [
    savingsChannel("RESOURCE", false, "RecommendationOptions", "", bound, cells),
  ];
  if (family !== "LICENSE") channels.push(
    savingsChannel(
      "RESOURCE",
      true,
      "RecommendationOptions",
      "AfterDiscounts",
      bound,
      cells,
    ),
  );
  return Object.freeze(channels.filter(
    (channel): channel is ComputeOptimizerMappedSavingsChannel => channel !== null,
  ));
}

function nativeIdFromArn(arn: string): string {
  const match = ARN.exec(arn);
  if (match === null) reject("ROW_EVIDENCE_INVALID");
  const resource = match[5]!;
  const lastSlash = resource.lastIndexOf("/");
  const lastColon = resource.lastIndexOf(":");
  const split = Math.max(lastSlash, lastColon);
  const value = split >= 0 ? resource.slice(split + 1) : resource;
  if (!SAFE_TEXT.test(value)) reject("ROW_EVIDENCE_INVALID");
  return value;
}

function validateArn(arn: string, accountId: string, region: string): void {
  const match = ARN.exec(arn);
  if (
    match === null
    || match[4] !== accountId
    || (match[3] !== "" && match[3] !== region)
  ) reject("ROW_EVIDENCE_INVALID");
}

function mappedFindings(
  family: ComputeOptimizerExportFamily,
  bound: ReadonlyMap<string, readonly BoundColumn[]>,
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
): readonly ComputeOptimizerMappedFinding[] {
  if (family === "RDS_DATABASE") {
    const optional = (
      scope: "INSTANCE" | "STORAGE",
      findingField: string,
      reasonField: string,
    ): ComputeOptimizerMappedFinding | null => {
      const finding = optionalValue(findingField, bound, cells);
      const reasons = valuesFor(reasonField, bound, cells);
      if (finding === null) {
        if (reasons.length > 0) reject("ROW_EVIDENCE_INVALID");
        return null;
      }
      return Object.freeze({ scope, finding, reasons });
    };
    const result = [
      optional("INSTANCE", "InstanceFinding", "InstanceFindingReasonCodes"),
      optional("STORAGE", "StorageFinding", "StorageFindingReasonCodes"),
    ].filter((finding): finding is ComputeOptimizerMappedFinding => finding !== null);
    if (result.length === 0) reject("ROW_EVIDENCE_INVALID");
    return Object.freeze(result);
  }
  const reasonField = family === "IDLE_RESOURCE" ? "FindingDescription" : "FindingReasonCodes";
  const reasonColumns = bound.has(reasonField) ? valuesFor(reasonField, bound, cells) : Object.freeze([]);
  return Object.freeze([Object.freeze({
    scope: "RESOURCE",
    finding: requiredValue("Finding", bound, cells),
    reasons: reasonColumns,
  })]);
}

function mappedTags(
  tagColumns: readonly ComputeOptimizerCsvwColumn[],
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
): readonly ComputeOptimizerMappedTagEvidence[] {
  const result: ComputeOptimizerMappedTagEvidence[] = [];
  const keys = new Set<string>();
  for (const column of tagColumns) {
    const cell = cellFor(cells, column.name);
    if (cell.isNull || cell.raw.length === 0) continue;
    const key = column.name.slice(5);
    if (
      keys.has(key)
      || new TextEncoder().encode(cell.raw).byteLength > MAX_TAG_VALUE_BYTES
      || !SAFE_TEXT.test(cell.raw)
    ) reject("TAG_EVIDENCE_INVALID");
    keys.add(key);
    result.push(Object.freeze({
      key,
      value: cell.raw,
      column: column.name,
      assurance: "CSVW_NAME_AND_TITLE",
    }));
  }
  return Object.freeze(result.sort((left, right) =>
    compare(left.key, right.key) || compare(left.value, right.value)));
}

function fieldsByRole(
  role: FieldRole,
  bound: ReadonlyMap<string, readonly BoundColumn[]>,
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
  ranked: boolean,
): readonly ComputeOptimizerMappedFieldEvidence[] {
  const result: ComputeOptimizerMappedFieldEvidence[] = [];
  for (const columns of bound.values()) {
    for (const column of columns) {
      if (column.role !== role || (column.rank !== null) !== ranked) continue;
      const cell = cellFor(cells, column.column.name);
      if (!cell.isNull && cell.raw.length > 0) result.push(evidence(column, cell));
    }
  }
  return Object.freeze(result.sort((left, right) =>
    compare(left.apiField, right.apiField) || compare(left.column, right.column)));
}

function rankedOptions(
  expectedCount: number,
  bound: ReadonlyMap<string, readonly BoundColumn[]>,
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
): readonly ComputeOptimizerMappedRankedOption[] {
  const rankedRules = [...bound.entries()].filter(([, columns]) =>
    columns.some((column) => column.rank !== null));
  if (rankedRules.length === 0) return Object.freeze([]);
  const expectedRanks = Array.from({ length: expectedCount }, (_, index) => index + 1);
  for (const [, columns] of rankedRules) {
    const present = columns.flatMap((column) => {
      const cell = cellFor(cells, column.column.name);
      return cell.isNull || cell.raw.length === 0 ? [] : [column.rank!];
    });
    if (
      present.length !== expectedRanks.length
      || present.some((rank, index) => rank !== expectedRanks[index])
    ) reject("RANK_MISMATCH");
  }
  return Object.freeze(expectedRanks.map((rank) => {
    const configuration: ComputeOptimizerMappedFieldEvidence[] = [];
    let risk: ComputeOptimizerMappedFieldEvidence | null = null;
    for (const columns of bound.values()) {
      const column = columns.find((candidate) => candidate.rank === rank);
      if (column === undefined) continue;
      const value = evidence(column, cellFor(cells, column.column.name));
      if (column.role === "risk") {
        if (risk !== null) reject("RANK_MISMATCH");
        risk = value;
      } else if (column.role === "configuration") {
        configuration.push(value);
      }
    }
    return Object.freeze({
      rank,
      configuration: Object.freeze(configuration.sort((left, right) =>
        compare(left.apiField, right.apiField))),
      risk,
    });
  }));
}

function recommendationCount(
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
): number {
  const cell = cellFor(cells, "recommendations_count");
  if (cell.integerLexeme === null) reject("ROW_EVIDENCE_INVALID");
  const count = BigInt(cell.integerLexeme);
  if (
    count < BIGINT_ZERO
    || count > BigInt(COMPUTE_OPTIMIZER_EXPORT_MAPPER_BOUNDS.maximumOptionsPerRow)
  ) reject("LIMIT_EXCEEDED");
  return Number(count);
}

function rdsRecommendation(
  bundle: LoadedComputeOptimizerExportTargetBundle,
  findings: readonly ComputeOptimizerMappedFinding[],
  configuration: readonly ComputeOptimizerMappedFieldEvidence[],
  risk: readonly ComputeOptimizerMappedFieldEvidence[],
  savings: readonly ComputeOptimizerSavingsChannel[],
  bound: ReadonlyMap<string, readonly BoundColumn[]>,
  cells: ReadonlyMap<string, ParsedComputeOptimizerExportCell>,
): ComputeOptimizerMappedRdsRecommendation {
  const instanceFinding = findings.find((finding) => finding.scope === "INSTANCE");
  const storageFinding = findings.find((finding) => finding.scope === "STORAGE");
  const isAurora = bundle.providerResourceType === "AuroraDBClusterStorage";
  const auroraIdentifier = optionalValue("DBClusterIdentifier", bound, cells);
  if (isAurora && auroraIdentifier === null) reject("ROW_EVIDENCE_INVALID");
  return Object.freeze({
    instance: Object.freeze({
      availability: instanceFinding === undefined ? "ABSENT_IN_PROVIDER_ROW" : "PRESENT",
      finding: instanceFinding ?? null,
      configuration: Object.freeze(configuration.filter((field) =>
        !field.apiField.includes("Storage"))),
      risk,
      savings: Object.freeze(savings.filter((channel) => channel.scope === "INSTANCE")),
    }),
    storage: Object.freeze({
      availability: storageFinding === undefined ? "ABSENT_IN_PROVIDER_ROW" : "PRESENT",
      finding: storageFinding ?? null,
      configuration: Object.freeze(configuration.filter((field) =>
        field.apiField.includes("Storage"))),
      savings: Object.freeze(savings.filter((channel) => channel.scope === "STORAGE")),
    }),
    auroraStorageIdentity: isAurora ? Object.freeze({
      providerResourceType: bundle.providerResourceType,
      dbClusterIdentifier: auroraIdentifier!,
      clusterWriter: optionalValue("ClusterWriter", bound, cells),
      promotionTier: optionalValue("PromotionTier", bound, cells),
    }) : null,
  });
}

function sourceLineage(bundle: LoadedComputeOptimizerExportTargetBundle): ComputeOptimizerMappedSourceLineage {
  if (
    !REGION.test(bundle.region)
    || !SHA256.test(bundle.requestSha256)
    || !JOB_ID.test(bundle.jobId)
    || bundle.parsed.objectSha256 !== bundle.csvObject.sha256
    || bundle.parsed.metadataSha256 !== bundle.metadataObject.sha256
    || !SHA256.test(bundle.parsed.objectSha256)
    || !SHA256.test(bundle.parsed.metadataSha256)
    || bundle.parsed.csvBasename !== bundle.csvObject.key.slice(
      bundle.csvObject.key.lastIndexOf("/") + 1,
    )
  ) reject("SOURCE_LINEAGE_MISMATCH");
  return Object.freeze({
    region: bundle.region,
    exportFamily: bundle.exportFamily,
    providerResourceType: bundle.providerResourceType,
    requestSha256: bundle.requestSha256,
    jobId: bundle.jobId,
    bucket: bundle.bucket,
    csvObject: bundle.csvObject,
    metadataObject: bundle.metadataObject,
    csvBasename: bundle.parsed.csvBasename,
    csvSha256: bundle.parsed.objectSha256,
    metadataSha256: bundle.parsed.metadataSha256,
    modifiedDate: bundle.parsed.modifiedDate,
  });
}

async function verifiedPlanTarget(
  bundle: LoadedComputeOptimizerExportTargetBundle,
  plan: ComputeOptimizerExportPlan,
): Promise<ComputeOptimizerExportPlanTarget> {
  let verified: ComputeOptimizerExportPlan;
  try {
    verified = await verifyComputeOptimizerExportPlan(plan);
  } catch {
    return reject("SOURCE_LINEAGE_MISMATCH");
  }
  const matches = verified.targets.filter((target) =>
    target.region === bundle.region && target.exportFamily === bundle.exportFamily);
  if (matches.length !== 1) reject("SOURCE_LINEAGE_MISMATCH");
  const target = matches[0]!;
  if (
    target.requestSha256 !== bundle.requestSha256
    || target.bucket !== bundle.bucket
    || target.expectedJob.jobId !== bundle.jobId
    || target.expectedJob.providerResourceType !== bundle.providerResourceType
    || target.expectedJob.bucket !== bundle.bucket
    || target.expectedJob.objectKey !== bundle.csvObject.key
    || target.expectedJob.metadataKey !== bundle.metadataObject.key
  ) reject("SOURCE_LINEAGE_MISMATCH");
  return target;
}

export async function mapComputeOptimizerExportTarget(
  bundle: LoadedComputeOptimizerExportTargetBundle,
  plan: ComputeOptimizerExportPlan,
): Promise<MappedComputeOptimizerExportTarget> {
  if (typeof bundle !== "object" || bundle === null || Array.isArray(bundle)) reject("INVALID_INPUT");
  const planTarget = await verifiedPlanTarget(bundle, plan);
  const source = sourceLineage(bundle);
  const rows = bundle.parsed.rows;
  if (
    rows.length !== bundle.parsed.rowCount
    || rows.length > COMPUTE_OPTIMIZER_EXPORT_MAPPER_BOUNDS.maximumRows
  ) reject(rows.length > COMPUTE_OPTIMIZER_EXPORT_MAPPER_BOUNDS.maximumRows
    ? "LIMIT_EXCEEDED" : "SOURCE_LINEAGE_MISMATCH");
  const profile = buildProfile(bundle.exportFamily, planTarget.request.fieldsToExport);
  const { fields, tagColumns } = bindColumns(
    bundle.exportFamily,
    bundle.parsed.columns,
    profile,
  );
  const schemaAssurance: MappedComputeOptimizerExportTarget["schemaAssurance"] =
    [...fields.values()].flat().some((field) => field.assurance === "API_FIELD_NAME_ONLY")
      ? "API_FIELD_NAME_ONLY_UNVERIFIED"
      : tagColumns.length > 0
        ? "METADATA_DERIVED_TAG_COLUMNS_UNVERIFIED"
        : "OFFICIAL_USER_GUIDE_CSV_LABELS";
  const recommendations: ComputeOptimizerMappedRecommendation[] = [];
  const rejectedRows: ComputeOptimizerRejectedRowEvidence[] = [];
  const resourceKeys = new Set<string>();

  for (const row of rows) {
    const cells = rowCells(row);
    const count = recommendationCount(cells);
    const errorCode = cellFor(cells, "errorCode").raw;
    const errorMessage = cellFor(cells, "errorMessage").raw;
    if ((errorCode === "") !== (errorMessage === "")) reject("ROW_EVIDENCE_INVALID");
    if (errorCode !== "") {
      if (!SAFE_TEXT.test(errorCode) || !SAFE_TEXT.test(errorMessage) || count !== 0) {
        reject("ROW_EVIDENCE_INVALID");
      }
      const account = valuesFor("AccountId", fields, cells)[0]?.raw ?? null;
      const arn = valuesFor(profile.arnField, fields, cells)[0]?.raw ?? null;
      rejectedRows.push(Object.freeze({
        rowNumber: row.rowNumber,
        errorCode,
        errorMessage,
        accountId: account,
        resourceArn: arn,
      }));
      continue;
    }

    const account = requiredValue("AccountId", fields, cells);
    const arn = requiredValue(profile.arnField, fields, cells);
    if (!ACCOUNT_ID.test(account.raw)) reject("ROW_EVIDENCE_INVALID");
    validateArn(arn.raw, account.raw, bundle.region);
    let resourceId: string;
    let resourceIdSource: ComputeOptimizerMappedRecommendation["resourceIdSource"];
    if (profile.nativeIdField !== null) {
      resourceId = requiredValue(profile.nativeIdField, fields, cells).raw;
      resourceIdSource = profile.nativeIdField === "ResourceId" ? "EXPORTED" : "EXPORTED_NAME";
    } else {
      resourceId = nativeIdFromArn(arn.raw);
      resourceIdSource = "ARN";
    }
    if (!SAFE_TEXT.test(resourceId)) reject("ROW_EVIDENCE_INVALID");
    const resourceKey = `${account.raw}\u0000${arn.raw}\u0000${resourceId}`;
    if (resourceKeys.has(resourceKey)) reject("DUPLICATE_RESOURCE");
    resourceKeys.add(resourceKey);

    const refresh = requiredValue("LastRefreshTimestamp", fields, cells);
    const lookback = requiredValue("LookbackPeriodInDays", fields, cells);
    const lookbackCell = cellFor(cells, lookback.column);
    const findings = mappedFindings(bundle.exportFamily, fields, cells);
    const currentConfiguration = fieldsByRole("configuration", fields, cells, false)
      .filter((field) => !field.apiField.startsWith("RecommendationOptions")
        && !field.apiField.startsWith("InstanceRecommendationOptions")
        && !field.apiField.startsWith("StorageRecommendationOptions"));
    const recommendedConfiguration = fieldsByRole("configuration", fields, cells, false)
      .filter((field) => field.apiField.startsWith("RecommendationOptions")
        || field.apiField.startsWith("InstanceRecommendationOptions")
        || field.apiField.startsWith("StorageRecommendationOptions"));
    const currentRisk = fieldsByRole("risk", fields, cells, false)
      .filter((field) => field.apiField.startsWith("Current"));
    const options = rankedOptions(count, fields, cells);
    const savings = mappedSavings(bundle.exportFamily, fields, cells);
    const rds = bundle.exportFamily === "RDS_DATABASE"
      ? rdsRecommendation(
        bundle,
        findings,
        Object.freeze([...currentConfiguration, ...recommendedConfiguration]),
        fieldsByRole("risk", fields, cells, false),
        savings,
        fields,
        cells,
      )
      : null;
    recommendations.push(Object.freeze({
      rowNumber: row.rowNumber,
      accountId: account.raw,
      resourceArn: arn.raw,
      resourceId,
      resourceIdSource,
      region: bundle.region,
      exportFamily: bundle.exportFamily,
      findings,
      lastRefreshTimestamp: refresh.raw,
      lookbackPeriodLexeme: numericLexeme(lookback, lookbackCell),
      currentConfiguration: Object.freeze(currentConfiguration),
      recommendedConfiguration: Object.freeze(recommendedConfiguration),
      currentRisk,
      rankedOptions: options,
      savings,
      tags: mappedTags(tagColumns, cells),
      rds,
    }));
  }

  recommendations.sort((left, right) =>
    compare(left.accountId, right.accountId)
      || compare(left.resourceArn, right.resourceArn)
      || left.rowNumber - right.rowNumber);
  rejectedRows.sort((left, right) => left.rowNumber - right.rowNumber);
  return deepFreeze({
    schemaVersion: "sutra.compute-optimizer-export-mapped-target.v1",
    source,
    schemaAssurance,
    rowCount: rows.length,
    recommendationCount: recommendations.length,
    rejectedRowCount: rejectedRows.length,
    recommendations,
    rejectedRows,
  });
}
