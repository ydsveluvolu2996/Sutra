import { createHash } from "node:crypto";
import {
  ComputeOptimizerClient,
  ExportAutoScalingGroupRecommendationsCommand,
  ExportEBSVolumeRecommendationsCommand,
  ExportEC2InstanceRecommendationsCommand,
  ExportECSServiceRecommendationsCommand,
  ExportIdleRecommendationsCommand,
  ExportLambdaFunctionRecommendationsCommand,
  ExportLicenseRecommendationsCommand,
  ExportRDSDatabaseRecommendationsCommand,
  type ExportableAutoScalingGroupField,
  type ExportableECSServiceField,
  type ExportableIdleField,
  type ExportableInstanceField,
  type ExportableLambdaFunctionField,
  type ExportableLicenseField,
  type ExportableRDSDBField,
  type ExportableVolumeField,
} from "@aws-sdk/client-compute-optimizer";

import { canonicalJson } from "./canonical-json.js";
import { workloadIdentityAwsClientConfig } from "./role-broker.js";
import type { AwsPartition, AwsTemporaryCredentials } from "./types.js";

const ACCOUNT_ID = /^\d{12}$/u;
const BUCKET =
  /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!xn--)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const ATTEMPT_ID = /^coela_[a-f0-9]{64}$/u;
const BATCH_ID = /^coelb_[a-f0-9]{64}$/u;
const TARGET_ID = /^coelt_[a-f0-9]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DAILY_WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const FIELD = /^[A-Za-z][A-Za-z0-9]{0,127}$/u;
const MAX_KEY_BYTES = 1_024;

export const COMPUTE_OPTIMIZER_EXPORT_LAUNCHER_BOUNDS = Object.freeze({
  maximumTargets: 8,
  maximumFieldsPerTarget: 256,
  maximumAttemptNumber: 1_000,
  maximumEnvelopeBytes: 512 * 1_024,
  maximumOverallDeadlineMs: 120_000,
  maximumCommandDeadlineMs: 20_000,
} as const);

export const COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY = Object.freeze({
  AUTO_SCALING_GROUP: "ExportAutoScalingGroupRecommendations",
  EBS_VOLUME: "ExportEBSVolumeRecommendations",
  EC2_INSTANCE: "ExportEC2InstanceRecommendations",
  ECS_SERVICE: "ExportECSServiceRecommendations",
  IDLE_RESOURCE: "ExportIdleRecommendations",
  LAMBDA_FUNCTION: "ExportLambdaFunctionRecommendations",
  LICENSE: "ExportLicenseRecommendations",
  RDS_DATABASE: "ExportRDSDatabaseRecommendations",
} as const);

type ExportFamily = keyof typeof COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY;
type ExportOperation = (typeof COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY)[ExportFamily];
type Partition = "aws" | "aws-us-gov" | "aws-cn";

/** Compiled broker-side mirror of the control-plane materialization projection. */
export const COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MATERIALIZATION_PROJECTION = Object.freeze({
  AUTO_SCALING_GROUP: Object.freeze([
    "AccountId", "AutoScalingGroupArn", "AutoScalingGroupName", "CurrentConfigurationDesiredCapacity",
    "CurrentConfigurationInstanceType", "CurrentPerformanceRisk", "Finding", "LastRefreshTimestamp",
    "LookbackPeriodInDays",
    "RecommendationOptionsConfigurationDesiredCapacity", "RecommendationOptionsConfigurationInstanceType",
    "RecommendationOptionsEstimatedMonthlySavingsCurrency",
    "RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "RecommendationOptionsEstimatedMonthlySavingsValue",
    "RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
    "RecommendationOptionsPerformanceRisk", "RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
    "RecommendationOptionsSavingsOpportunityPercentage",
  ] satisfies readonly ExportableAutoScalingGroupField[]),
  EBS_VOLUME: Object.freeze([
    "AccountId", "CurrentConfigurationVolumeBaselineIOPS", "CurrentConfigurationVolumeBaselineThroughput",
    "CurrentConfigurationVolumeSize", "CurrentConfigurationVolumeType", "CurrentPerformanceRisk", "Finding",
    "LastRefreshTimestamp", "LookbackPeriodInDays", "RecommendationOptionsConfigurationVolumeBaselineIOPS",
    "RecommendationOptionsConfigurationVolumeBaselineThroughput", "RecommendationOptionsConfigurationVolumeSize",
    "RecommendationOptionsConfigurationVolumeType", "RecommendationOptionsEstimatedMonthlySavingsCurrency",
    "RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "RecommendationOptionsEstimatedMonthlySavingsValue",
    "RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts", "RecommendationOptionsPerformanceRisk",
    "RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
    "RecommendationOptionsSavingsOpportunityPercentage", "Tags", "VolumeArn",
  ] satisfies readonly ExportableVolumeField[]),
  EC2_INSTANCE: Object.freeze([
    "AccountId", "CurrentInstanceType", "CurrentPerformanceRisk", "Finding", "FindingReasonCodes", "InstanceArn",
    "LastRefreshTimestamp", "LookbackPeriodInDays",
    "RecommendationOptionsEstimatedMonthlySavingsCurrency",
    "RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "RecommendationOptionsEstimatedMonthlySavingsValue",
    "RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts", "RecommendationOptionsInstanceType",
    "RecommendationOptionsPerformanceRisk", "RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
    "RecommendationOptionsSavingsOpportunityPercentage", "Tags",
  ] satisfies readonly ExportableInstanceField[]),
  ECS_SERVICE: Object.freeze([
    "AccountId", "CurrentPerformanceRisk", "CurrentServiceConfigurationCpu", "CurrentServiceConfigurationMemory",
    "CurrentServiceConfigurationTaskDefinitionArn", "Finding", "FindingReasonCodes", "LastRefreshTimestamp",
    "LaunchType", "LookbackPeriodInDays", "RecommendationOptionsCpu",
    "RecommendationOptionsEstimatedMonthlySavingsCurrency",
    "RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "RecommendationOptionsEstimatedMonthlySavingsValue",
    "RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts", "RecommendationOptionsMemory",
    "RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
    "RecommendationOptionsSavingsOpportunityPercentage", "ServiceArn", "Tags",
  ] satisfies readonly ExportableECSServiceField[]),
  IDLE_RESOURCE: Object.freeze([
    "AccountId", "Finding", "FindingDescription", "LastRefreshTimestamp", "LookbackPeriodInDays",
    "ResourceArn", "ResourceId",
    "ResourceType", "SavingsOpportunity", "SavingsOpportunityAfterDiscount", "Tags",
  ] satisfies readonly ExportableIdleField[]),
  LAMBDA_FUNCTION: Object.freeze([
    "AccountId", "CurrentConfigurationMemorySize", "CurrentConfigurationTimeout", "CurrentPerformanceRisk",
    "Finding", "FindingReasonCodes", "FunctionArn", "FunctionVersion", "LastRefreshTimestamp",
    "LookbackPeriodInDays", "RecommendationOptionsConfigurationMemorySize",
    "RecommendationOptionsEstimatedMonthlySavingsCurrency",
    "RecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "RecommendationOptionsEstimatedMonthlySavingsValue",
    "RecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
    "RecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
    "RecommendationOptionsSavingsOpportunityPercentage", "Tags",
  ] satisfies readonly ExportableLambdaFunctionField[]),
  LICENSE: Object.freeze([
    "AccountId", "CurrentLicenseConfigurationInstanceType", "CurrentLicenseConfigurationLicenseEdition",
    "CurrentLicenseConfigurationLicenseModel", "CurrentLicenseConfigurationLicenseName",
    "CurrentLicenseConfigurationLicenseVersion", "CurrentLicenseConfigurationNumberOfCores",
    "CurrentLicenseConfigurationOperatingSystem", "Finding", "FindingReasonCodes", "LastRefreshTimestamp",
    "LookbackPeriodInDays",
    "RecommendationOptionsEstimatedMonthlySavingsCurrency", "RecommendationOptionsEstimatedMonthlySavingsValue",
    "RecommendationOptionsLicenseEdition", "RecommendationOptionsLicenseModel", "RecommendationOptionsOperatingSystem",
    "RecommendationOptionsSavingsOpportunityPercentage", "ResourceArn", "Tags",
  ] satisfies readonly ExportableLicenseField[]),
  RDS_DATABASE: Object.freeze([
    "AccountId", "ClusterWriter", "CurrentDBInstanceClass", "CurrentInstancePerformanceRisk",
    "CurrentStorageConfigurationAllocatedStorage", "CurrentStorageConfigurationIOPS",
    "CurrentStorageConfigurationMaxAllocatedStorage", "CurrentStorageConfigurationStorageThroughput",
    "CurrentStorageConfigurationStorageType", "DBClusterIdentifier", "Engine", "EngineVersion", "InstanceFinding",
    "InstanceFindingReasonCodes", "InstanceRecommendationOptionsDBInstanceClass",
    "InstanceRecommendationOptionsEstimatedMonthlySavingsCurrency",
    "InstanceRecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "InstanceRecommendationOptionsEstimatedMonthlySavingsValue",
    "InstanceRecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts",
    "InstanceRecommendationOptionsPerformanceRisk", "InstanceRecommendationOptionsRank",
    "InstanceRecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
    "InstanceRecommendationOptionsSavingsOpportunityPercentage", "LastRefreshTimestamp", "LookbackPeriodInDays",
    "MultiAZDBInstance",
    "PromotionTier", "ResourceArn", "StorageFinding", "StorageFindingReasonCodes",
    "StorageRecommendationOptionsAllocatedStorage", "StorageRecommendationOptionsEstimatedMonthlySavingsCurrency",
    "StorageRecommendationOptionsEstimatedMonthlySavingsCurrencyAfterDiscounts",
    "StorageRecommendationOptionsEstimatedMonthlySavingsValue",
    "StorageRecommendationOptionsEstimatedMonthlySavingsValueAfterDiscounts", "StorageRecommendationOptionsIOPS",
    "StorageRecommendationOptionsMaxAllocatedStorage", "StorageRecommendationOptionsRank",
    "StorageRecommendationOptionsSavingsOpportunityAfterDiscountsPercentage",
    "StorageRecommendationOptionsSavingsOpportunityPercentage",
    "StorageRecommendationOptionsStorageThroughput", "StorageRecommendationOptionsStorageType", "Tags",
  ] satisfies readonly ExportableRDSDBField[]),
}) satisfies Readonly<Record<ExportFamily, readonly string[]>>;

/** @deprecated Use the materialization projection name for new code. */
export const COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MINIMUM_PROJECTION =
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MATERIALIZATION_PROJECTION;

type ExportCommand =
  | ExportAutoScalingGroupRecommendationsCommand
  | ExportEBSVolumeRecommendationsCommand
  | ExportEC2InstanceRecommendationsCommand
  | ExportECSServiceRecommendationsCommand
  | ExportIdleRecommendationsCommand
  | ExportLambdaFunctionRecommendationsCommand
  | ExportLicenseRecommendationsCommand
  | ExportRDSDatabaseRecommendationsCommand;

interface LaunchTarget {
  readonly targetId: string;
  readonly exportFamily: ExportFamily;
  readonly operation: ExportOperation;
  readonly region: string;
  readonly bucket: string;
  readonly optionalPrefix: string | null;
  readonly effectivePrefix: string;
  readonly request: {
    readonly fileFormat: "Csv";
    readonly includeMemberAccounts: true;
    readonly filters: readonly [];
    readonly fieldsToExport: readonly string[];
    readonly s3DestinationConfig: {
      readonly bucket: string;
      readonly keyPrefix: string | null;
    };
  };
  readonly requestSha256: string;
}

interface LaunchAttempt {
  readonly schemaVersion: "sutra.compute-optimizer-export-launch-attempt.v1";
  readonly requestBatchId: string;
  readonly launchAttemptId: string;
  readonly contentSha256: string;
  readonly scope: {
    readonly orgId: string;
    readonly customerId: string;
    readonly connectionId: string;
  };
  readonly requesterAccountId: string;
  readonly partition: Partition;
  readonly region: string;
  readonly scheduledWindow: string;
  readonly sealedAtIso: string;
  readonly attemptNumber: number;
  readonly targets: readonly LaunchTarget[];
}
export type ComputeOptimizerExportLaunchAttempt = LaunchAttempt;

export type ComputeOptimizerExportLaunchPublicErrorCode =
  | "ABORTED"
  | "ACCESS_DENIED"
  | "CONCURRENT_EXPORT_LIMIT"
  | "DEADLINE_EXCEEDED"
  | "ENROLLMENT_REQUIRED"
  | "INVALID_PROVIDER_RESPONSE"
  | "INVALID_REQUEST"
  | "PROVIDER_REQUEST_FAILED"
  | "RATE_LIMITED"
  | "SERVICE_UNAVAILABLE";

export type ComputeOptimizerExportLaunchOutcome =
  | {
      readonly targetId: string;
      readonly exportFamily: ExportFamily;
      readonly operation: ExportOperation;
      readonly status: "SUCCEEDED";
      readonly jobId: string;
      readonly bucket: string;
      readonly objectKey: string;
      readonly metadataKey: string;
      readonly errorCode: null;
    }
  | {
      readonly targetId: string;
      readonly exportFamily: ExportFamily;
      readonly operation: ExportOperation;
      readonly status: "FAILED" | "NOT_ATTEMPTED";
      readonly jobId: null;
      readonly bucket: null;
      readonly objectKey: null;
      readonly metadataKey: null;
      readonly errorCode: ComputeOptimizerExportLaunchPublicErrorCode;
    };

export interface ComputeOptimizerExportLaunchExecution {
  readonly schemaVersion: "sutra.compute-optimizer-export-launch-execution.v1";
  readonly executionId: string;
  readonly contentSha256: string;
  readonly requestBatchId: string;
  readonly launchAttemptId: string;
  readonly status: "COMPLETE" | "PARTIAL";
  readonly startedAtIso: string;
  readonly finishedAtIso: string;
  readonly outcomes: readonly ComputeOptimizerExportLaunchOutcome[];
}

export interface ComputeOptimizerExportLaunchClient {
  send(command: ExportCommand, options: { readonly abortSignal: AbortSignal }): Promise<unknown>;
}

export interface RunComputeOptimizerExportLaunchOptions {
  readonly attempt: unknown;
  readonly client: ComputeOptimizerExportLaunchClient;
  readonly now?: () => Date;
  readonly overallDeadlineMs?: number;
  readonly commandDeadlineMs?: number;
  readonly abortSignal?: AbortSignal;
}

export class ComputeOptimizerExportLauncherError extends Error {
  public readonly code: "INVALID_ATTEMPT" | "LIMIT_EXCEEDED";

  public constructor(code: ComputeOptimizerExportLauncherError["code"]) {
    super("Compute Optimizer export launch rejected");
    this.name = "ComputeOptimizerExportLauncherError";
    this.code = code;
  }
}

function reject(code: ComputeOptimizerExportLauncherError["code"]): never {
  throw new ComputeOptimizerExportLauncherError(code);
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

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validRegionForPartition(region: string, partition: Partition): boolean {
  if (!REGION.test(region)) return false;
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function validObjectKey(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || new TextEncoder().encode(value).byteLength > MAX_KEY_BYTES
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("%")
    || value.includes("\0")
  ) return false;
  return !value.split("/").some((part) => part.length === 0 || part === "." || part === "..");
}

function validPrefix(value: unknown): value is string {
  return validObjectKey(value) && !(value as string).endsWith("/");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function batchIdentityBody(attempt: LaunchAttempt): unknown {
  return {
    schemaVersion: attempt.schemaVersion,
    scope: attempt.scope,
    requesterAccountId: attempt.requesterAccountId,
    partition: attempt.partition,
    region: attempt.region,
    scheduledWindow: attempt.scheduledWindow,
    targets: attempt.targets,
  };
}

function attemptContentBody(attempt: LaunchAttempt): unknown {
  return {
    schemaVersion: attempt.schemaVersion,
    requestBatchId: attempt.requestBatchId,
    scope: attempt.scope,
    requesterAccountId: attempt.requesterAccountId,
    partition: attempt.partition,
    region: attempt.region,
    scheduledWindow: attempt.scheduledWindow,
    sealedAtIso: attempt.sealedAtIso,
    attemptNumber: attempt.attemptNumber,
    targets: attempt.targets,
  };
}

function validateAttempt(value: unknown): LaunchAttempt {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "requestBatchId", "launchAttemptId", "contentSha256", "scope",
      "requesterAccountId", "partition", "region", "scheduledWindow", "sealedAtIso",
      "attemptNumber", "targets",
    ])
    || value.schemaVersion !== "sutra.compute-optimizer-export-launch-attempt.v1"
    || typeof value.requestBatchId !== "string"
    || !BATCH_ID.test(value.requestBatchId)
    || typeof value.launchAttemptId !== "string"
    || !ATTEMPT_ID.test(value.launchAttemptId)
    || typeof value.contentSha256 !== "string"
    || !SHA256.test(value.contentSha256)
    || !isRecord(value.scope)
    || !exactKeys(value.scope, ["orgId", "customerId", "connectionId"])
    || typeof value.scope.orgId !== "string"
    || !IDENTIFIER.test(value.scope.orgId)
    || typeof value.scope.customerId !== "string"
    || !IDENTIFIER.test(value.scope.customerId)
    || typeof value.scope.connectionId !== "string"
    || !CONNECTION_ID.test(value.scope.connectionId)
    || typeof value.requesterAccountId !== "string"
    || !ACCOUNT_ID.test(value.requesterAccountId)
    || (value.partition !== "aws" && value.partition !== "aws-us-gov" && value.partition !== "aws-cn")
    || typeof value.region !== "string"
    || !validRegionForPartition(value.region, value.partition)
    || !validTimestamp(value.scheduledWindow)
    || !DAILY_WINDOW.test(value.scheduledWindow)
    || !validTimestamp(value.sealedAtIso)
    || Date.parse(value.scheduledWindow) > Date.parse(value.sealedAtIso)
    || !Number.isSafeInteger(value.attemptNumber)
    || (value.attemptNumber as number) < 1
    || (value.attemptNumber as number) > COMPUTE_OPTIMIZER_EXPORT_LAUNCHER_BOUNDS.maximumAttemptNumber
    || !Array.isArray(value.targets)
    || value.targets.length !== COMPUTE_OPTIMIZER_EXPORT_LAUNCHER_BOUNDS.maximumTargets
  ) reject("INVALID_ATTEMPT");
  const attempt = value as unknown as LaunchAttempt;
  const families = Object.keys(COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY).sort() as ExportFamily[];
  for (let index = 0; index < families.length; index += 1) {
    const target = attempt.targets[index];
    const family = families[index]!;
    if (
      target === undefined
      || !isRecord(target)
      || !exactKeys(target, [
        "targetId", "exportFamily", "operation", "region", "bucket", "optionalPrefix",
        "effectivePrefix", "request", "requestSha256",
      ])
      || target.exportFamily !== family
      || target.operation !== COMPUTE_OPTIMIZER_EXPORT_LAUNCH_OPERATION_BY_FAMILY[family]
      || target.region !== attempt.region
      || typeof target.targetId !== "string"
      || !TARGET_ID.test(target.targetId)
      || typeof target.bucket !== "string"
      || !BUCKET.test(target.bucket)
      || (target.optionalPrefix !== null && !validPrefix(target.optionalPrefix))
      || typeof target.effectivePrefix !== "string"
      || target.effectivePrefix !== (target.optionalPrefix === null
        ? `compute-optimizer/${attempt.requesterAccountId}/`
        : `${target.optionalPrefix}/compute-optimizer/${attempt.requesterAccountId}/`)
      || !isRecord(target.request)
      || !exactKeys(target.request, [
        "fileFormat", "includeMemberAccounts", "filters", "fieldsToExport", "s3DestinationConfig",
      ])
      || target.request.fileFormat !== "Csv"
      || target.request.includeMemberAccounts !== true
      || !Array.isArray(target.request.filters)
      || target.request.filters.length !== 0
      || !Array.isArray(target.request.fieldsToExport)
      || target.request.fieldsToExport.length < 1
      || target.request.fieldsToExport.length > COMPUTE_OPTIMIZER_EXPORT_LAUNCHER_BOUNDS.maximumFieldsPerTarget
      || target.request.fieldsToExport.some((field) => typeof field !== "string" || !FIELD.test(field))
      || new Set(target.request.fieldsToExport).size !== target.request.fieldsToExport.length
      || target.request.fieldsToExport.some((field, fieldIndex) =>
        fieldIndex > 0 && target.request.fieldsToExport[fieldIndex - 1]! >= field)
      || !sameStrings(
        target.request.fieldsToExport as string[],
        COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MATERIALIZATION_PROJECTION[family],
      )
      || !isRecord(target.request.s3DestinationConfig)
      || !exactKeys(target.request.s3DestinationConfig, ["bucket", "keyPrefix"])
      || target.request.s3DestinationConfig.bucket !== target.bucket
      || target.request.s3DestinationConfig.keyPrefix !== target.optionalPrefix
      || typeof target.requestSha256 !== "string"
      || !SHA256.test(target.requestSha256)
    ) reject("INVALID_ATTEMPT");
    const requestSha256 = sha256(canonicalJson({
      operation: target.operation,
      region: target.region,
      ...target.request,
    }));
    const targetId = `coelt_${sha256(canonicalJson({
      exportFamily: target.exportFamily,
      operation: target.operation,
      region: target.region,
      requestSha256,
    }))}`;
    if (target.requestSha256 !== requestSha256 || target.targetId !== targetId) {
      reject("INVALID_ATTEMPT");
    }
  }
  const requestBatchId = `coelb_${sha256(canonicalJson(batchIdentityBody(attempt)))}`;
  const contentSha256 = sha256(canonicalJson(attemptContentBody(attempt)));
  if (
    attempt.requestBatchId !== requestBatchId
    || attempt.contentSha256 !== contentSha256
    || attempt.launchAttemptId !== `coela_${contentSha256}`
  ) reject("INVALID_ATTEMPT");
  if (new TextEncoder().encode(canonicalJson(attempt)).byteLength
    > COMPUTE_OPTIMIZER_EXPORT_LAUNCHER_BOUNDS.maximumEnvelopeBytes) {
    reject("LIMIT_EXCEEDED");
  }
  return structuredClone(attempt);
}

/** Parse and clone a sealed attempt before any credential or provider work. */
export function parseComputeOptimizerExportLaunchAttempt(
  value: unknown,
): ComputeOptimizerExportLaunchAttempt {
  return deepFreeze(validateAttempt(value));
}

export function createAwsComputeOptimizerExportLaunchClient(
  partition: AwsPartition,
  region: string,
  credentials: AwsTemporaryCredentials,
): ComputeOptimizerExportLaunchClient {
  if (!validRegionForPartition(region, partition)) reject("INVALID_ATTEMPT");
  const client = new ComputeOptimizerClient({
    ...workloadIdentityAwsClientConfig(region, 3),
    endpoint: computeOptimizerExportEndpoint(partition, region),
    credentials: {
      accessKeyId: credentials.accessKeyId,
      secretAccessKey: credentials.secretAccessKey,
      sessionToken: credentials.sessionToken,
      expiration: credentials.expiration,
    },
  });
  return {
    send: (command, options) => {
      const handlerOptions = { abortSignal: options.abortSignal };
      if (command instanceof ExportAutoScalingGroupRecommendationsCommand) {
        return client.send(command, handlerOptions);
      }
      if (command instanceof ExportEBSVolumeRecommendationsCommand) {
        return client.send(command, handlerOptions);
      }
      if (command instanceof ExportEC2InstanceRecommendationsCommand) {
        return client.send(command, handlerOptions);
      }
      if (command instanceof ExportECSServiceRecommendationsCommand) {
        return client.send(command, handlerOptions);
      }
      if (command instanceof ExportIdleRecommendationsCommand) {
        return client.send(command, handlerOptions);
      }
      if (command instanceof ExportLambdaFunctionRecommendationsCommand) {
        return client.send(command, handlerOptions);
      }
      if (command instanceof ExportLicenseRecommendationsCommand) {
        return client.send(command, handlerOptions);
      }
      if (command instanceof ExportRDSDatabaseRecommendationsCommand) {
        return client.send(command, handlerOptions);
      }
      return Promise.reject(new ComputeOptimizerExportLauncherError("INVALID_ATTEMPT"));
    },
  };
}

export function computeOptimizerExportEndpoint(
  partition: AwsPartition,
  region: string,
): string {
  if (!validRegionForPartition(region, partition)) reject("INVALID_ATTEMPT");
  const suffix = partition === "aws-cn" ? "amazonaws.com.cn" : "amazonaws.com";
  return `https://compute-optimizer.${region}.${suffix}`;
}

function bounded(value: number | undefined, maximum: number): number {
  const result = value ?? maximum;
  if (!Number.isSafeInteger(result) || result < 1 || result > maximum) reject("LIMIT_EXCEEDED");
  return result;
}

function commandFor(target: LaunchTarget): ExportCommand {
  const destination = {
    s3DestinationConfig: {
      bucket: target.bucket,
      ...(target.optionalPrefix === null ? {} : { keyPrefix: target.optionalPrefix }),
    },
  };
  // accountIds, filters and recommendationPreferences are intentionally absent.
  switch (target.exportFamily) {
    case "AUTO_SCALING_GROUP":
      return new ExportAutoScalingGroupRecommendationsCommand({
        ...destination,
        fieldsToExport: [...COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MATERIALIZATION_PROJECTION.AUTO_SCALING_GROUP],
        fileFormat: "Csv",
        includeMemberAccounts: true,
      });
    case "EBS_VOLUME":
      return new ExportEBSVolumeRecommendationsCommand({
        ...destination,
        fieldsToExport: [...COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MATERIALIZATION_PROJECTION.EBS_VOLUME],
        fileFormat: "Csv",
        includeMemberAccounts: true,
      });
    case "EC2_INSTANCE":
      return new ExportEC2InstanceRecommendationsCommand({
        ...destination,
        fieldsToExport: [...COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MATERIALIZATION_PROJECTION.EC2_INSTANCE],
        fileFormat: "Csv",
        includeMemberAccounts: true,
      });
    case "ECS_SERVICE":
      return new ExportECSServiceRecommendationsCommand({
        ...destination,
        fieldsToExport: [...COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MATERIALIZATION_PROJECTION.ECS_SERVICE],
        fileFormat: "Csv",
        includeMemberAccounts: true,
      });
    case "IDLE_RESOURCE":
      return new ExportIdleRecommendationsCommand({
        ...destination,
        fieldsToExport: [...COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MATERIALIZATION_PROJECTION.IDLE_RESOURCE],
        fileFormat: "Csv",
        includeMemberAccounts: true,
      });
    case "LAMBDA_FUNCTION":
      return new ExportLambdaFunctionRecommendationsCommand({
        ...destination,
        fieldsToExport: [...COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MATERIALIZATION_PROJECTION.LAMBDA_FUNCTION],
        fileFormat: "Csv",
        includeMemberAccounts: true,
      });
    case "LICENSE":
      return new ExportLicenseRecommendationsCommand({
        ...destination,
        fieldsToExport: [...COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MATERIALIZATION_PROJECTION.LICENSE],
        fileFormat: "Csv",
        includeMemberAccounts: true,
      });
    case "RDS_DATABASE":
      return new ExportRDSDatabaseRecommendationsCommand({
        ...destination,
        fieldsToExport: [...COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MATERIALIZATION_PROJECTION.RDS_DATABASE],
        fileFormat: "Csv",
        includeMemberAccounts: true,
      });
  }
}

function failure(
  target: LaunchTarget,
  status: "FAILED" | "NOT_ATTEMPTED",
  errorCode: ComputeOptimizerExportLaunchPublicErrorCode,
): ComputeOptimizerExportLaunchOutcome {
  return {
    targetId: target.targetId,
    exportFamily: target.exportFamily,
    operation: target.operation,
    status,
    jobId: null,
    bucket: null,
    objectKey: null,
    metadataKey: null,
    errorCode,
  };
}

function providerErrorCode(error: unknown, signal: AbortSignal): ComputeOptimizerExportLaunchPublicErrorCode {
  if (signal.aborted) return "ABORTED";
  const name = isRecord(error) && typeof error.name === "string" ? error.name : "";
  switch (name) {
    case "AccessDeniedException": return "ACCESS_DENIED";
    case "InvalidParameterValueException": return "INVALID_REQUEST";
    case "LimitExceededException": return "CONCURRENT_EXPORT_LIMIT";
    case "OptInRequiredException": return "ENROLLMENT_REQUIRED";
    case "ThrottlingException": return "RATE_LIMITED";
    case "InternalServerException":
    case "ServiceUnavailableException": return "SERVICE_UNAVAILABLE";
    default: return "PROVIDER_REQUEST_FAILED";
  }
}

async function sendWithDeadline(
  client: ComputeOptimizerExportLaunchClient,
  command: ExportCommand,
  overallSignal: AbortSignal,
  commandDeadlineMs: number,
): Promise<unknown> {
  const commandAbort = new AbortController();
  const forwardAbort = (): void => commandAbort.abort(overallSignal.reason);
  return await new Promise<unknown>((resolve, rejectPromise) => {
    let settled = false;
    const settle = (action: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      overallSignal.removeEventListener("abort", onOverallAbort);
      action();
    };
    const onOverallAbort = (): void => {
      forwardAbort();
      settle(() => rejectPromise(Object.assign(new Error("overall abort"), {
        name: "SutraOverallAbort",
      })));
    };
    const timer = setTimeout(() => {
      commandAbort.abort(new Error("command deadline"));
      settle(() => rejectPromise(Object.assign(new Error("command deadline"), {
        name: "SutraCommandDeadline",
      })));
    }, commandDeadlineMs);
    if (overallSignal.aborted) {
      onOverallAbort();
      return;
    }
    overallSignal.addEventListener("abort", onOverallAbort, { once: true });
    // Both fulfillment and rejection remain observed after a deadline wins.
    Promise.resolve()
      .then(() => client.send(command, { abortSignal: commandAbort.signal }))
      .then(
        (value) => settle(() => resolve(value)),
        (error: unknown) => settle(() => rejectPromise(error)),
      );
  });
}

function normalizeSuccess(
  target: LaunchTarget,
  response: unknown,
): ComputeOptimizerExportLaunchOutcome | null {
  if (
    !isRecord(response)
    || typeof response.jobId !== "string"
    || !JOB_ID.test(response.jobId)
    || !isRecord(response.s3Destination)
    || response.s3Destination.bucket !== target.bucket
    || !validObjectKey(response.s3Destination.key)
    || !validObjectKey(response.s3Destination.metadataKey)
    || !response.s3Destination.key.startsWith(`${target.effectivePrefix}${target.region}-`)
    || !response.s3Destination.key.endsWith(`-${response.jobId}.csv`)
    || response.s3Destination.metadataKey
      !== `${response.s3Destination.key.slice(0, -4)}-metadata.json`
  ) return null;
  return {
    targetId: target.targetId,
    exportFamily: target.exportFamily,
    operation: target.operation,
    status: "SUCCEEDED",
    jobId: response.jobId,
    bucket: response.s3Destination.bucket,
    objectKey: response.s3Destination.key,
    metadataKey: response.s3Destination.metadataKey,
    errorCode: null,
  };
}

function executionBody(execution: Omit<ComputeOptimizerExportLaunchExecution, "executionId" | "contentSha256">): unknown {
  return execution;
}

/**
 * Launches the exact eight family exports sequentially. Sequential execution is
 * intentional: AWS permits only one in-progress export per family per Region,
 * and fail-stop behavior avoids widening an ambiguous timeout into more jobs.
 */
export async function runComputeOptimizerExportLaunch(
  options: RunComputeOptimizerExportLaunchOptions,
): Promise<ComputeOptimizerExportLaunchExecution> {
  const attempt = validateAttempt(options.attempt);
  const commandDeadlineMs = bounded(
    options.commandDeadlineMs,
    COMPUTE_OPTIMIZER_EXPORT_LAUNCHER_BOUNDS.maximumCommandDeadlineMs,
  );
  const overallDeadlineMs = bounded(
    options.overallDeadlineMs,
    COMPUTE_OPTIMIZER_EXPORT_LAUNCHER_BOUNDS.maximumOverallDeadlineMs,
  );
  const now = options.now ?? (() => new Date());
  const started = now();
  if (!Number.isFinite(started.getTime()) || started.getTime() < Date.parse(attempt.sealedAtIso)) {
    reject("INVALID_ATTEMPT");
  }
  const overall = new AbortController();
  let overallTimedOut = false;
  const forwardAbort = (): void => overall.abort(options.abortSignal?.reason);
  if (options.abortSignal?.aborted === true) forwardAbort();
  else options.abortSignal?.addEventListener("abort", forwardAbort, { once: true });
  const overallTimer = setTimeout(() => {
    overallTimedOut = true;
    overall.abort(new Error("overall deadline"));
  }, overallDeadlineMs);
  overallTimer.unref?.();

  const outcomes: ComputeOptimizerExportLaunchOutcome[] = [];
  let stoppedWith: ComputeOptimizerExportLaunchPublicErrorCode | null = null;
  try {
    for (const target of attempt.targets) {
      if (stoppedWith !== null || overall.signal.aborted) {
        outcomes.push(failure(
          target,
          "NOT_ATTEMPTED",
          stoppedWith ?? (overallTimedOut ? "DEADLINE_EXCEEDED" : "ABORTED"),
        ));
        continue;
      }
      try {
        const response = await sendWithDeadline(
          options.client,
          commandFor(target),
          overall.signal,
          commandDeadlineMs,
        );
        const outcome = normalizeSuccess(target, response);
        if (outcome === null) {
          stoppedWith = "INVALID_PROVIDER_RESPONSE";
          outcomes.push(failure(target, "FAILED", stoppedWith));
        } else {
          outcomes.push(outcome);
        }
      } catch (error) {
        stoppedWith = isRecord(error) && error.name === "SutraCommandDeadline"
          ? "DEADLINE_EXCEEDED"
          : overallTimedOut
            ? "DEADLINE_EXCEEDED"
            : providerErrorCode(error, overall.signal);
        outcomes.push(failure(target, "FAILED", stoppedWith));
      }
    }
  } finally {
    clearTimeout(overallTimer);
    options.abortSignal?.removeEventListener("abort", forwardAbort);
  }

  const finished = now();
  if (!Number.isFinite(finished.getTime()) || finished.getTime() < started.getTime()) {
    reject("INVALID_ATTEMPT");
  }
  const body = {
    schemaVersion: "sutra.compute-optimizer-export-launch-execution.v1" as const,
    requestBatchId: attempt.requestBatchId,
    launchAttemptId: attempt.launchAttemptId,
    status: outcomes.every(({ status }) => status === "SUCCEEDED")
      ? "COMPLETE" as const
      : "PARTIAL" as const,
    startedAtIso: started.toISOString(),
    finishedAtIso: finished.toISOString(),
    outcomes,
  };
  const contentSha256 = sha256(canonicalJson(executionBody(body)));
  const execution = {
    ...body,
    executionId: `coele_${contentSha256}`,
    contentSha256,
  };
  if (new TextEncoder().encode(canonicalJson(execution)).byteLength
    > COMPUTE_OPTIMIZER_EXPORT_LAUNCHER_BOUNDS.maximumEnvelopeBytes) {
    reject("LIMIT_EXCEEDED");
  }
  return deepFreeze(execution);
}
