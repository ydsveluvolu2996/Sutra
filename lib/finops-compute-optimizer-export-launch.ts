/**
 * Immutable, content-addressed pre-launch contract for one regional AWS
 * Compute Optimizer organization export attempt.
 *
 * The attempt is sealed before any provider call. It deliberately contains no
 * credentials and no provider status. Provider outcomes are a separate
 * content-addressed envelope so a partial attempt can never be mistaken for a
 * post-launch plan.
 */

import { canonicalJson } from "./canonical-json.ts";
import {
  COMPUTE_OPTIMIZER_EXPORT_FAMILIES,
  COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG,
  COMPUTE_OPTIMIZER_EXPORT_MATERIALIZATION_PROJECTION,
  validateComputeOptimizerFieldsToExport,
} from "./finops-compute-optimizer-export-field-catalog.ts";
import type {
  ComputeOptimizerExportFamily,
  ComputeOptimizerExportOperation,
  ComputeOptimizerExportPlanInput,
  ComputeOptimizerExportPlanPartition,
  ComputeOptimizerExportPlanScope,
  ComputeOptimizerProviderExportJobResourceType,
} from "./finops-compute-optimizer-export-plan.ts";

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
const EXECUTION_ID = /^coele_[a-f0-9]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const DAILY_WINDOW = /^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/u;
const MAX_KEY_BYTES = 1_024;

export const COMPUTE_OPTIMIZER_EXPORT_LAUNCH_BOUNDS = Object.freeze({
  maximumTargets: 8,
  maximumFieldsPerTarget: 256,
  maximumAttemptNumber: 1_000,
  maximumEnvelopeBytes: 512 * 1_024,
} as const);

const OPERATION_BY_FAMILY: Readonly<
  Record<ComputeOptimizerExportFamily, ComputeOptimizerExportOperation>
> = Object.freeze(Object.fromEntries(
  COMPUTE_OPTIMIZER_EXPORT_FAMILIES.map((family) => [
    family,
    COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[family].operation,
  ]),
) as Record<ComputeOptimizerExportFamily, ComputeOptimizerExportOperation>);

/** Exact DescribeRecommendationExportJobs resourceType allowlists per family. */
function providerResourceTypes(
  ...values: ComputeOptimizerProviderExportJobResourceType[]
): readonly ComputeOptimizerProviderExportJobResourceType[] {
  return Object.freeze(values);
}

export const COMPUTE_OPTIMIZER_PROVIDER_RESOURCE_TYPES_BY_EXPORT_FAMILY: Readonly<
  Record<ComputeOptimizerExportFamily, readonly ComputeOptimizerProviderExportJobResourceType[]>
> = Object.freeze({
  EC2_INSTANCE: providerResourceTypes("Ec2Instance"),
  AUTO_SCALING_GROUP: providerResourceTypes("AutoScalingGroup"),
  EBS_VOLUME: providerResourceTypes("EbsVolume"),
  LAMBDA_FUNCTION: providerResourceTypes("LambdaFunction"),
  ECS_SERVICE: providerResourceTypes("EcsService"),
  LICENSE: providerResourceTypes("License"),
  // The combined RDS API has no resourceType request property; Describe is authoritative.
  RDS_DATABASE: providerResourceTypes("AuroraDBClusterStorage", "RdsDBInstance"),
  IDLE_RESOURCE: providerResourceTypes("Idle"),
});

export interface ComputeOptimizerExportLaunchAttemptInput {
  readonly scope: ComputeOptimizerExportPlanScope;
  readonly requesterAccountId: string;
  readonly partition: ComputeOptimizerExportPlanPartition;
  readonly region: string;
  readonly scheduledWindow: string;
  readonly sealedAtIso: string;
  readonly attemptNumber: number;
  readonly bucket: string;
  readonly optionalPrefix: string | null;
}

export interface ComputeOptimizerExportLaunchTarget {
  readonly targetId: string;
  readonly exportFamily: ComputeOptimizerExportFamily;
  readonly operation: ComputeOptimizerExportOperation;
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

export interface ComputeOptimizerExportLaunchAttempt {
  readonly schemaVersion: "sutra.compute-optimizer-export-launch-attempt.v1";
  readonly requestBatchId: string;
  readonly launchAttemptId: string;
  readonly contentSha256: string;
  readonly scope: ComputeOptimizerExportPlanScope;
  readonly requesterAccountId: string;
  readonly partition: ComputeOptimizerExportPlanPartition;
  readonly region: string;
  readonly scheduledWindow: string;
  readonly sealedAtIso: string;
  readonly attemptNumber: number;
  readonly targets: readonly ComputeOptimizerExportLaunchTarget[];
}

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

const PUBLIC_ERROR_CODES = new Set<ComputeOptimizerExportLaunchPublicErrorCode>([
  "ABORTED",
  "ACCESS_DENIED",
  "CONCURRENT_EXPORT_LIMIT",
  "DEADLINE_EXCEEDED",
  "ENROLLMENT_REQUIRED",
  "INVALID_PROVIDER_RESPONSE",
  "INVALID_REQUEST",
  "PROVIDER_REQUEST_FAILED",
  "RATE_LIMITED",
  "SERVICE_UNAVAILABLE",
]);

export type ComputeOptimizerExportLaunchOutcome =
  | {
      readonly targetId: string;
      readonly exportFamily: ComputeOptimizerExportFamily;
      readonly operation: ComputeOptimizerExportOperation;
      readonly status: "SUCCEEDED";
      readonly jobId: string;
      readonly bucket: string;
      readonly objectKey: string;
      readonly metadataKey: string;
      readonly errorCode: null;
    }
  | {
      readonly targetId: string;
      readonly exportFamily: ComputeOptimizerExportFamily;
      readonly operation: ComputeOptimizerExportOperation;
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

/** Exact, fresh DescribeRecommendationExportJobs proof after launch. */
export interface ComputeOptimizerExportLaunchCompletedJobObservation {
  readonly targetId: string;
  readonly plannedJobId: string;
  readonly jobId: string;
  readonly exportFamily: ComputeOptimizerExportFamily;
  readonly providerResourceType: ComputeOptimizerProviderExportJobResourceType;
  readonly requestSha256: string;
  readonly status: "COMPLETE";
  readonly bucket: string;
  readonly objectKey: string;
  readonly metadataKey: string;
  readonly destination: {
    readonly bucket: string;
    readonly objectKey: string;
    readonly metadataKey: string;
  };
  readonly creationTimestampIso: string;
  readonly lastUpdatedTimestampIso: string;
}

export class ComputeOptimizerExportLaunchError extends Error {
  public readonly code:
    | "CONTENT_HASH_MISMATCH"
    | "INCOMPLETE_ATTEMPT"
    | "INVALID_INPUT"
    | "LIMIT_EXCEEDED"
    | "PROVIDER_SUBSTITUTION";

  public constructor(code: ComputeOptimizerExportLaunchError["code"]) {
    super("Compute Optimizer export launch evidence rejected");
    this.name = "ComputeOptimizerExportLaunchError";
    this.code = code;
  }
}

function reject(code: ComputeOptimizerExportLaunchError["code"]): never {
  throw new ComputeOptimizerExportLaunchError(code);
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

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP.test(value)) return false;
  const milliseconds = Date.parse(value);
  return Number.isSafeInteger(milliseconds) && new Date(milliseconds).toISOString() === value;
}

function validRegionForPartition(
  region: string,
  partition: ComputeOptimizerExportPlanPartition,
): boolean {
  if (!REGION.test(region)) return false;
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function validPrefix(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length === 0
    || new TextEncoder().encode(value).byteLength > MAX_KEY_BYTES
    || value.startsWith("/")
    || value.endsWith("/")
    || value.includes("\\")
    || value.includes("%")
    || value.includes("\0")
  ) return false;
  return !value.split("/").some((part) => part.length === 0 || part === "." || part === "..");
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

function validProviderObjectBasename(
  objectKey: string,
  effectivePrefixValue: string,
  region: string,
  jobId: string,
): boolean {
  const basename = objectKey.slice(effectivePrefixValue.length);
  const prefix = `${region}-`;
  const suffix = `-${jobId}.csv`;
  return basename.startsWith(prefix)
    && basename.endsWith(suffix)
    && basename.slice(prefix.length, -suffix.length).length > 0;
}

function effectivePrefix(optionalPrefix: string | null, accountId: string): string {
  return optionalPrefix === null
    ? `compute-optimizer/${accountId}/`
    : `${optionalPrefix}/compute-optimizer/${accountId}/`;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

function deepFreeze<T>(value: T): T {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function assertEnvelopeBound(value: unknown): void {
  if (new TextEncoder().encode(canonicalJson(value)).byteLength
    > COMPUTE_OPTIMIZER_EXPORT_LAUNCH_BOUNDS.maximumEnvelopeBytes) {
    reject("LIMIT_EXCEEDED");
  }
}

function validateScope(value: unknown): asserts value is ComputeOptimizerExportPlanScope {
  if (
    !isRecord(value)
    || !exactKeys(value, ["orgId", "customerId", "connectionId"])
    || typeof value.orgId !== "string"
    || !IDENTIFIER.test(value.orgId)
    || typeof value.customerId !== "string"
    || !IDENTIFIER.test(value.customerId)
    || typeof value.connectionId !== "string"
    || !CONNECTION_ID.test(value.connectionId)
  ) reject("INVALID_INPUT");
}

function validateAttemptInput(value: unknown): asserts value is ComputeOptimizerExportLaunchAttemptInput {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "scope", "requesterAccountId", "partition", "region", "scheduledWindow",
      "sealedAtIso", "attemptNumber", "bucket", "optionalPrefix",
    ])
  ) reject("INVALID_INPUT");
  validateScope(value.scope);
  if (
    typeof value.requesterAccountId !== "string"
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
    || (value.attemptNumber as number) > COMPUTE_OPTIMIZER_EXPORT_LAUNCH_BOUNDS.maximumAttemptNumber
    || typeof value.bucket !== "string"
    || !BUCKET.test(value.bucket)
    || (value.optionalPrefix !== null && !validPrefix(value.optionalPrefix))
  ) reject("INVALID_INPUT");
}

function batchIdentityBody(attempt: ComputeOptimizerExportLaunchAttempt): unknown {
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

function attemptContentBody(attempt: ComputeOptimizerExportLaunchAttempt): unknown {
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

export async function createComputeOptimizerExportLaunchAttempt(
  input: ComputeOptimizerExportLaunchAttemptInput,
): Promise<ComputeOptimizerExportLaunchAttempt> {
  validateAttemptInput(input);
  const prefix = effectivePrefix(input.optionalPrefix, input.requesterAccountId);
  const families = [...COMPUTE_OPTIMIZER_EXPORT_FAMILIES]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (families.length !== COMPUTE_OPTIMIZER_EXPORT_LAUNCH_BOUNDS.maximumTargets) {
    reject("INVALID_INPUT");
  }
  const targets: ComputeOptimizerExportLaunchTarget[] = [];
  for (const exportFamily of families) {
    const operation = OPERATION_BY_FAMILY[exportFamily];
    const fieldsToExport = validateComputeOptimizerFieldsToExport(
      exportFamily,
      operation,
      COMPUTE_OPTIMIZER_EXPORT_MATERIALIZATION_PROJECTION[exportFamily],
    );
    if (fieldsToExport.length > COMPUTE_OPTIMIZER_EXPORT_LAUNCH_BOUNDS.maximumFieldsPerTarget) {
      reject("LIMIT_EXCEEDED");
    }
    const request = {
      fileFormat: "Csv" as const,
      includeMemberAccounts: true as const,
      filters: Object.freeze([]) as readonly [],
      fieldsToExport: [...fieldsToExport],
      s3DestinationConfig: {
        bucket: input.bucket,
        keyPrefix: input.optionalPrefix,
      },
    };
    const requestSha256 = await sha256(canonicalJson({
      operation,
      region: input.region,
      ...request,
    }));
    const targetId = `coelt_${await sha256(canonicalJson({
      exportFamily,
      operation,
      region: input.region,
      requestSha256,
    }))}`;
    targets.push({
      targetId,
      exportFamily,
      operation,
      region: input.region,
      bucket: input.bucket,
      optionalPrefix: input.optionalPrefix,
      effectivePrefix: prefix,
      request,
      requestSha256,
    });
  }
  const provisional = {
    schemaVersion: "sutra.compute-optimizer-export-launch-attempt.v1" as const,
    requestBatchId: "",
    launchAttemptId: "",
    contentSha256: "",
    scope: { ...input.scope },
    requesterAccountId: input.requesterAccountId,
    partition: input.partition,
    region: input.region,
    scheduledWindow: input.scheduledWindow,
    sealedAtIso: input.sealedAtIso,
    attemptNumber: input.attemptNumber,
    targets,
  };
  const requestBatchId = `coelb_${await sha256(canonicalJson(batchIdentityBody(provisional)))}`;
  const body = { ...provisional, requestBatchId };
  const contentSha256 = await sha256(canonicalJson(attemptContentBody(body)));
  const result = {
    ...body,
    launchAttemptId: `coela_${contentSha256}`,
    contentSha256,
  };
  assertEnvelopeBound(result);
  return deepFreeze(result);
}

export async function verifyComputeOptimizerExportLaunchAttempt(
  value: unknown,
): Promise<ComputeOptimizerExportLaunchAttempt> {
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
    || !Array.isArray(value.targets)
  ) reject("INVALID_INPUT");
  const regenerated = await createComputeOptimizerExportLaunchAttempt({
    scope: value.scope as ComputeOptimizerExportPlanScope,
    requesterAccountId: value.requesterAccountId as string,
    partition: value.partition as ComputeOptimizerExportPlanPartition,
    region: value.region as string,
    scheduledWindow: value.scheduledWindow as string,
    sealedAtIso: value.sealedAtIso as string,
    attemptNumber: value.attemptNumber as number,
    bucket: (value.targets[0] as Record<string, unknown> | undefined)?.bucket as string,
    optionalPrefix: (value.targets[0] as Record<string, unknown> | undefined)?.optionalPrefix as string | null,
  });
  if (canonicalJson(value) !== canonicalJson(regenerated)) reject("CONTENT_HASH_MISMATCH");
  return regenerated;
}

function executionContentBody(execution: ComputeOptimizerExportLaunchExecution): unknown {
  return {
    schemaVersion: execution.schemaVersion,
    requestBatchId: execution.requestBatchId,
    launchAttemptId: execution.launchAttemptId,
    status: execution.status,
    startedAtIso: execution.startedAtIso,
    finishedAtIso: execution.finishedAtIso,
    outcomes: execution.outcomes,
  };
}

async function verifyExecutionAgainstAttempt(
  value: unknown,
  attempt: ComputeOptimizerExportLaunchAttempt,
): Promise<ComputeOptimizerExportLaunchExecution> {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "schemaVersion", "executionId", "contentSha256", "requestBatchId", "launchAttemptId",
      "status", "startedAtIso", "finishedAtIso", "outcomes",
    ])
    || value.schemaVersion !== "sutra.compute-optimizer-export-launch-execution.v1"
    || typeof value.executionId !== "string"
    || !EXECUTION_ID.test(value.executionId)
    || typeof value.contentSha256 !== "string"
    || !SHA256.test(value.contentSha256)
    || value.requestBatchId !== attempt.requestBatchId
    || value.launchAttemptId !== attempt.launchAttemptId
    || (value.status !== "COMPLETE" && value.status !== "PARTIAL")
    || !validTimestamp(value.startedAtIso)
    || !validTimestamp(value.finishedAtIso)
    || Date.parse(value.startedAtIso) < Date.parse(attempt.sealedAtIso)
    || Date.parse(value.finishedAtIso) < Date.parse(value.startedAtIso)
    || !Array.isArray(value.outcomes)
    || value.outcomes.length !== attempt.targets.length
  ) reject("INVALID_INPUT");
  const outcomes = value.outcomes as unknown[];
  let successes = 0;
  for (let index = 0; index < attempt.targets.length; index += 1) {
    const target = attempt.targets[index]!;
    const outcome = outcomes[index];
    if (
      !isRecord(outcome)
      || outcome.targetId !== target.targetId
      || outcome.exportFamily !== target.exportFamily
      || outcome.operation !== target.operation
      || !exactKeys(outcome, [
        "targetId", "exportFamily", "operation", "status", "jobId", "bucket",
        "objectKey", "metadataKey", "errorCode",
      ])
    ) reject("PROVIDER_SUBSTITUTION");
    if (outcome.status === "SUCCEEDED") {
      successes += 1;
      if (
        typeof outcome.jobId !== "string"
        || !JOB_ID.test(outcome.jobId)
        || outcome.bucket !== target.bucket
        || !validObjectKey(outcome.objectKey)
        || !validObjectKey(outcome.metadataKey)
        || !(outcome.objectKey as string).startsWith(target.effectivePrefix)
        || !(outcome.metadataKey as string).startsWith(target.effectivePrefix)
        || !validProviderObjectBasename(
          outcome.objectKey as string,
          target.effectivePrefix,
          target.region,
          outcome.jobId,
        )
        || outcome.metadataKey !== `${(outcome.objectKey as string).slice(0, -4)}-metadata.json`
        || outcome.errorCode !== null
      ) reject("PROVIDER_SUBSTITUTION");
    } else if (
      (outcome.status !== "FAILED" && outcome.status !== "NOT_ATTEMPTED")
      || outcome.jobId !== null
      || outcome.bucket !== null
      || outcome.objectKey !== null
      || outcome.metadataKey !== null
      || typeof outcome.errorCode !== "string"
      || !PUBLIC_ERROR_CODES.has(outcome.errorCode as ComputeOptimizerExportLaunchPublicErrorCode)
    ) reject("INVALID_INPUT");
  }
  if ((value.status === "COMPLETE") !== (successes === attempt.targets.length)) {
    reject("INVALID_INPUT");
  }
  const execution = value as unknown as ComputeOptimizerExportLaunchExecution;
  const contentSha256 = await sha256(canonicalJson(executionContentBody(execution)));
  if (value.contentSha256 !== contentSha256 || value.executionId !== `coele_${contentSha256}`) {
    reject("CONTENT_HASH_MISMATCH");
  }
  assertEnvelopeBound(value);
  return deepFreeze(structuredClone(execution));
}

/** Verifies complete or partial immutable launch evidence for persistence. */
export async function verifyComputeOptimizerExportLaunchExecution(
  unsafeAttempt: unknown,
  unsafeExecution: unknown,
): Promise<ComputeOptimizerExportLaunchExecution> {
  const attempt = await verifyComputeOptimizerExportLaunchAttempt(unsafeAttempt);
  return await verifyExecutionAgainstAttempt(unsafeExecution, attempt);
}

/** Converts only an all-successful launch into the existing regional plan input. */
export async function createComputeOptimizerExportPlanInputFromLaunchAttempt(
  unsafeAttempt: unknown,
  unsafeExecution: unknown,
  unsafeCompletedJobs: unknown,
): Promise<ComputeOptimizerExportPlanInput> {
  const attempt = await verifyComputeOptimizerExportLaunchAttempt(unsafeAttempt);
  const execution = await verifyExecutionAgainstAttempt(unsafeExecution, attempt);
  if (execution.status !== "COMPLETE") reject("INCOMPLETE_ATTEMPT");
  if (!Array.isArray(unsafeCompletedJobs) || unsafeCompletedJobs.length !== attempt.targets.length) {
    reject("INCOMPLETE_ATTEMPT");
  }
  const jobsByTarget = new Map<string, ComputeOptimizerExportLaunchCompletedJobObservation>();
  for (const raw of unsafeCompletedJobs) {
    if (
      !isRecord(raw)
      || !exactKeys(raw, [
        "targetId", "plannedJobId", "jobId", "exportFamily", "providerResourceType",
        "requestSha256", "status", "bucket", "objectKey", "metadataKey", "destination",
        "creationTimestampIso", "lastUpdatedTimestampIso",
      ])
      || typeof raw.targetId !== "string"
      || jobsByTarget.has(raw.targetId)
      || typeof raw.plannedJobId !== "string"
      || !JOB_ID.test(raw.plannedJobId)
      || typeof raw.jobId !== "string"
      || !JOB_ID.test(raw.jobId)
      || typeof raw.exportFamily !== "string"
      || typeof raw.providerResourceType !== "string"
      || typeof raw.requestSha256 !== "string"
      || !SHA256.test(raw.requestSha256)
      || raw.status !== "COMPLETE"
      || typeof raw.bucket !== "string"
      || !validObjectKey(raw.objectKey)
      || !validObjectKey(raw.metadataKey)
      || !isRecord(raw.destination)
      || !exactKeys(raw.destination, ["bucket", "objectKey", "metadataKey"])
      || raw.destination.bucket !== raw.bucket
      || raw.destination.objectKey !== raw.objectKey
      || raw.destination.metadataKey !== raw.metadataKey
      || !validTimestamp(raw.creationTimestampIso)
      || !validTimestamp(raw.lastUpdatedTimestampIso)
      || Date.parse(raw.lastUpdatedTimestampIso) < Date.parse(raw.creationTimestampIso)
    ) reject("PROVIDER_SUBSTITUTION");
    jobsByTarget.set(
      raw.targetId,
      raw as unknown as ComputeOptimizerExportLaunchCompletedJobObservation,
    );
  }
  const targets = attempt.targets.map((target, index) => {
    const outcome = execution.outcomes[index]!;
    if (outcome.status !== "SUCCEEDED") reject("INCOMPLETE_ATTEMPT");
    const observed = jobsByTarget.get(target.targetId);
    if (
      observed === undefined
      || observed.plannedJobId !== outcome.jobId
      || observed.jobId !== outcome.jobId
      || observed.exportFamily !== target.exportFamily
      || observed.requestSha256 !== target.requestSha256
      || !COMPUTE_OPTIMIZER_PROVIDER_RESOURCE_TYPES_BY_EXPORT_FAMILY[target.exportFamily]
        .includes(observed.providerResourceType)
      || observed.bucket !== outcome.bucket
      || observed.objectKey !== outcome.objectKey
      || observed.metadataKey !== outcome.metadataKey
    ) reject("PROVIDER_SUBSTITUTION");
    return {
      region: target.region,
      exportFamily: target.exportFamily,
      bucket: target.bucket,
      optionalPrefix: target.optionalPrefix,
      effectivePrefix: target.effectivePrefix,
      request: {
        operation: target.operation,
        region: target.region,
        fileFormat: target.request.fileFormat,
        includeMemberAccounts: target.request.includeMemberAccounts,
        filters: target.request.filters,
        fieldsToExport: target.request.fieldsToExport,
        s3DestinationConfig: target.request.s3DestinationConfig,
      },
      expectedJob: {
        jobId: outcome.jobId,
        providerResourceType: observed.providerResourceType,
        bucket: outcome.bucket,
        objectKey: outcome.objectKey,
        metadataKey: outcome.metadataKey,
      },
    };
  });
  return deepFreeze({
    scope: { ...attempt.scope },
    requesterAccountId: attempt.requesterAccountId,
    partition: attempt.partition,
    regions: [attempt.region],
    exportFamilies: attempt.targets.map(({ exportFamily }) => exportFamily),
    targets,
  });
}
