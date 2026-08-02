/**
 * Pure, server-owned plan contract for AWS Compute Optimizer organization
 * exports. This module seals configuration and provider job identities; it does
 * not create exports, access AWS, persist state, or materialize recommendations.
 */

import { validateComputeOptimizerFieldsToExport } from "./finops-compute-optimizer-export-field-catalog.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,255}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const BUCKET =
  /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!xn--)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const FIELD = /^[A-Za-z][A-Za-z0-9]{0,127}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const PLAN_ID = /^cope_[a-f0-9]{64}$/u;
const PLAN_SET_ID = /^copes_[a-f0-9]{64}$/u;
const MAX_KEY_BYTES = 1_024;

export const COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS = Object.freeze({
  maximumRegions: 50,
  maximumRegionsPerPlan: 1,
  maximumExportFamilies: 8,
  maximumTargets: 8,
  maximumPlanSetTargets: 400,
  maximumFieldsPerTarget: 256,
} as const);

export type ComputeOptimizerExportPlanPartition = "aws" | "aws-us-gov" | "aws-cn";

export type ComputeOptimizerExportFamily =
  | "EC2_INSTANCE"
  | "AUTO_SCALING_GROUP"
  | "EBS_VOLUME"
  | "LAMBDA_FUNCTION"
  | "ECS_SERVICE"
  | "LICENSE"
  | "RDS_DATABASE"
  | "IDLE_RESOURCE";

export type ComputeOptimizerProviderExportJobResourceType =
  | "Ec2Instance"
  | "AutoScalingGroup"
  | "EbsVolume"
  | "LambdaFunction"
  | "EcsService"
  | "License"
  | "RdsDBInstance"
  | "AuroraDBClusterStorage"
  | "Idle";

export type ComputeOptimizerExportOperation =
  | "ExportEC2InstanceRecommendations"
  | "ExportAutoScalingGroupRecommendations"
  | "ExportEBSVolumeRecommendations"
  | "ExportLambdaFunctionRecommendations"
  | "ExportECSServiceRecommendations"
  | "ExportLicenseRecommendations"
  | "ExportRDSDatabaseRecommendations"
  | "ExportIdleRecommendations";

const OPERATION_BY_EXPORT_FAMILY: Readonly<
  Record<ComputeOptimizerExportFamily, ComputeOptimizerExportOperation>
> = Object.freeze({
  EC2_INSTANCE: "ExportEC2InstanceRecommendations",
  AUTO_SCALING_GROUP: "ExportAutoScalingGroupRecommendations",
  EBS_VOLUME: "ExportEBSVolumeRecommendations",
  LAMBDA_FUNCTION: "ExportLambdaFunctionRecommendations",
  ECS_SERVICE: "ExportECSServiceRecommendations",
  LICENSE: "ExportLicenseRecommendations",
  RDS_DATABASE: "ExportRDSDatabaseRecommendations",
  IDLE_RESOURCE: "ExportIdleRecommendations",
});

const EXPORT_FAMILIES = new Set<ComputeOptimizerExportFamily>(
  Object.keys(OPERATION_BY_EXPORT_FAMILY) as ComputeOptimizerExportFamily[],
);

const PROVIDER_RESOURCE_TYPES_BY_FAMILY: Readonly<
  Record<ComputeOptimizerExportFamily, ReadonlySet<ComputeOptimizerProviderExportJobResourceType>>
> = Object.freeze({
  EC2_INSTANCE: new Set<ComputeOptimizerProviderExportJobResourceType>(["Ec2Instance"]),
  AUTO_SCALING_GROUP: new Set<ComputeOptimizerProviderExportJobResourceType>(["AutoScalingGroup"]),
  EBS_VOLUME: new Set<ComputeOptimizerProviderExportJobResourceType>(["EbsVolume"]),
  LAMBDA_FUNCTION: new Set<ComputeOptimizerProviderExportJobResourceType>(["LambdaFunction"]),
  ECS_SERVICE: new Set<ComputeOptimizerProviderExportJobResourceType>(["EcsService"]),
  LICENSE: new Set<ComputeOptimizerProviderExportJobResourceType>(["License"]),
  RDS_DATABASE: new Set<ComputeOptimizerProviderExportJobResourceType>([
    "RdsDBInstance",
    "AuroraDBClusterStorage",
  ]),
  IDLE_RESOURCE: new Set<ComputeOptimizerProviderExportJobResourceType>(["Idle"]),
});

export interface ComputeOptimizerExportPlanScope {
  readonly orgId: string;
  readonly customerId: string;
  readonly connectionId: string;
}

/** Canonical proof of the exact request sent through one regional AWS client. */
export interface ComputeOptimizerExportRequestProof {
  readonly operation: ComputeOptimizerExportOperation;
  readonly region: string;
  readonly fileFormat: "Csv";
  readonly includeMemberAccounts: true;
  /** Must remain empty. Any provider filter would narrow organization coverage. */
  readonly filters: readonly [];
  /** Explicit and canonical. The plan never relies on a provider default. */
  readonly fieldsToExport: readonly string[];
  readonly s3DestinationConfig: {
    readonly bucket: string;
    /** null means the optional keyPrefix property was absent from the AWS request. */
    readonly keyPrefix: string | null;
  };
}

export interface ComputeOptimizerExpectedExportJob {
  readonly jobId: string;
  /** Exact resourceType returned by DescribeRecommendationExportJobs. */
  readonly providerResourceType: ComputeOptimizerProviderExportJobResourceType;
  readonly bucket: string;
  readonly objectKey: string;
  readonly metadataKey: string;
}

export interface ComputeOptimizerExportPlanTargetInput {
  readonly region: string;
  readonly exportFamily: ComputeOptimizerExportFamily;
  readonly bucket: string;
  readonly optionalPrefix: string | null;
  readonly effectivePrefix: string;
  readonly request: ComputeOptimizerExportRequestProof;
  readonly expectedJob: ComputeOptimizerExpectedExportJob;
}

export interface ComputeOptimizerExportPlanInput {
  readonly scope: ComputeOptimizerExportPlanScope;
  readonly requesterAccountId: string;
  readonly partition: ComputeOptimizerExportPlanPartition;
  readonly regions: readonly string[];
  readonly exportFamilies: readonly ComputeOptimizerExportFamily[];
  readonly targets: readonly ComputeOptimizerExportPlanTargetInput[];
}

export interface ComputeOptimizerExportPlanTarget extends ComputeOptimizerExportPlanTargetInput {
  readonly requestSha256: string;
}

export interface ComputeOptimizerExportPlan {
  readonly schemaVersion: "sutra.compute-optimizer-export-plan.v1";
  readonly planId: string;
  readonly contentSha256: string;
  readonly scope: ComputeOptimizerExportPlanScope;
  readonly requesterAccountId: string;
  readonly partition: ComputeOptimizerExportPlanPartition;
  readonly regions: readonly string[];
  readonly exportFamilies: readonly ComputeOptimizerExportFamily[];
  readonly targets: readonly ComputeOptimizerExportPlanTarget[];
}

/** Full sorted organization matrix that is split into one plan per Region. */
export type ComputeOptimizerExportPlanSetInput = ComputeOptimizerExportPlanInput;

export interface ComputeOptimizerExportPlanSet {
  readonly schemaVersion: "sutra.compute-optimizer-export-plan-set.v1";
  readonly planSetId: string;
  readonly contentSha256: string;
  readonly scope: ComputeOptimizerExportPlanScope;
  readonly requesterAccountId: string;
  readonly partition: ComputeOptimizerExportPlanPartition;
  readonly regions: readonly string[];
  readonly exportFamilies: readonly ComputeOptimizerExportFamily[];
  /** Ordered one-for-one with Regions. Included directly in the set identity. */
  readonly planIds: readonly string[];
  /** Verified regional plans that callers queue independently. */
  readonly plans: readonly ComputeOptimizerExportPlan[];
}

export interface ObservedCompletedComputeOptimizerExportJob {
  readonly jobId: string;
  readonly region: string;
  readonly providerResourceType: ComputeOptimizerProviderExportJobResourceType;
  readonly status: "COMPLETE";
  readonly bucket: string;
  readonly objectKey: string;
  readonly metadataKey: string;
}

export interface VerifiedComputeOptimizerExportJobBinding {
  readonly planId: string;
  readonly contentSha256: string;
  readonly targets: readonly {
    readonly region: string;
    readonly exportFamily: ComputeOptimizerExportFamily;
    readonly providerResourceType: ComputeOptimizerProviderExportJobResourceType;
    readonly requestSha256: string;
    readonly jobId: string;
    readonly bucket: string;
    readonly objectKey: string;
    readonly metadataKey: string;
  }[];
}

export class ComputeOptimizerExportPlanError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "LIMIT_EXCEEDED"
      | "SCOPE_MISMATCH"
      | "REGION_BUCKET_CONFLICT"
      | "DUPLICATE_TARGET"
      | "MISSING_TARGET"
      | "REQUEST_PROOF_INVALID"
      | "JOB_SUBSTITUTION"
      | "CONTENT_HASH_MISMATCH",
  ) {
    super("Compute Optimizer export plan rejected");
    this.name = "ComputeOptimizerExportPlanError";
  }
}

function reject(code: ComputeOptimizerExportPlanError["code"]): never {
  throw new ComputeOptimizerExportPlanError(code);
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

function sortedUnique(values: readonly string[]): boolean {
  return new Set(values).size === values.length
    && values.every((value, index) => index === 0 || values[index - 1]!.localeCompare(value) < 0);
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

function effectivePrefix(optionalPrefix: string | null, accountId: string): string {
  return optionalPrefix === null
    ? `compute-optimizer/${accountId}/`
    : `${optionalPrefix}/compute-optimizer/${accountId}/`;
}

function pair(region: string, exportFamily: ComputeOptimizerExportFamily): string {
  return `${region}\u0000${exportFamily}`;
}

function canonicalRequest(request: ComputeOptimizerExportRequestProof): string {
  return JSON.stringify({
    operation: request.operation,
    region: request.region,
    fileFormat: request.fileFormat,
    includeMemberAccounts: request.includeMemberAccounts,
    filters: request.filters,
    fieldsToExport: request.fieldsToExport,
    s3DestinationConfig: {
      bucket: request.s3DestinationConfig.bucket,
      keyPrefix: request.s3DestinationConfig.keyPrefix,
    },
  });
}

function canonicalPlanBody(input: Omit<ComputeOptimizerExportPlan, "planId" | "contentSha256">): string {
  return JSON.stringify(input);
}

type ComputeOptimizerExportPlanSetIdentityBody = Omit<
  ComputeOptimizerExportPlanSet,
  "planSetId" | "contentSha256" | "plans"
>;

function canonicalPlanSetBody(input: ComputeOptimizerExportPlanSetIdentityBody): string {
  return JSON.stringify(input);
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

function validateRequest(
  value: unknown,
  target: Pick<ComputeOptimizerExportPlanTargetInput, "region" | "exportFamily" | "bucket" | "optionalPrefix">,
): asserts value is ComputeOptimizerExportRequestProof {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "operation",
      "region",
      "fileFormat",
      "includeMemberAccounts",
      "filters",
      "fieldsToExport",
      "s3DestinationConfig",
    ])
    || value.operation !== OPERATION_BY_EXPORT_FAMILY[target.exportFamily]
    || value.region !== target.region
    || value.fileFormat !== "Csv"
    || value.includeMemberAccounts !== true
    || !Array.isArray(value.filters)
    || value.filters.length !== 0
    || !Array.isArray(value.fieldsToExport)
    || value.fieldsToExport.length < 1
    || value.fieldsToExport.length > COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumFieldsPerTarget
    || value.fieldsToExport.some((field) => typeof field !== "string" || !FIELD.test(field))
    || !isRecord(value.s3DestinationConfig)
    || !exactKeys(value.s3DestinationConfig, ["bucket", "keyPrefix"])
    || value.s3DestinationConfig.bucket !== target.bucket
    || value.s3DestinationConfig.keyPrefix !== target.optionalPrefix
  ) reject("REQUEST_PROOF_INVALID");
  const fieldsToExport = value.fieldsToExport as string[];
  let canonicalFields: readonly string[];
  try {
    canonicalFields = validateComputeOptimizerFieldsToExport(
      target.exportFamily,
      value.operation,
      fieldsToExport,
    );
  } catch {
    reject("REQUEST_PROOF_INVALID");
  }
  if (
    canonicalFields.length !== fieldsToExport.length
    || canonicalFields.some((field, index) => field !== fieldsToExport[index])
  ) reject("REQUEST_PROOF_INVALID");
}

function validateExpectedJob(
  value: unknown,
  target: Pick<ComputeOptimizerExportPlanTargetInput, "region" | "exportFamily" | "bucket" | "effectivePrefix">,
): asserts value is ComputeOptimizerExpectedExportJob {
  if (
    !isRecord(value)
    || !exactKeys(value, ["jobId", "providerResourceType", "bucket", "objectKey", "metadataKey"])
    || typeof value.jobId !== "string"
    || !JOB_ID.test(value.jobId)
    || typeof value.providerResourceType !== "string"
    || !PROVIDER_RESOURCE_TYPES_BY_FAMILY[target.exportFamily].has(
      value.providerResourceType as ComputeOptimizerProviderExportJobResourceType,
    )
    || value.bucket !== target.bucket
    || !validObjectKey(value.objectKey)
    || !validObjectKey(value.metadataKey)
    || !value.objectKey.startsWith(target.effectivePrefix)
    || !value.metadataKey.startsWith(target.effectivePrefix)
    || !validProviderObjectBasename(
      value.objectKey.slice(target.effectivePrefix.length),
      target.region,
      value.jobId,
    )
    || value.metadataKey !== `${value.objectKey.slice(0, -4)}-metadata.json`
  ) reject("REQUEST_PROOF_INVALID");
}

function validProviderObjectBasename(
  basename: string,
  region: string,
  jobId: string,
): boolean {
  const prefix = `${region}-`;
  const suffix = `-${jobId}.csv`;
  if (!basename.startsWith(prefix) || !basename.endsWith(suffix)) return false;
  return basename.slice(prefix.length, -suffix.length).length > 0;
}

function validateInputShape(
  value: unknown,
  maximumRegions: number,
  maximumTargets: number,
): asserts value is ComputeOptimizerExportPlanInput {
  if (
    !isRecord(value)
    || !exactKeys(value, ["scope", "requesterAccountId", "partition", "regions", "exportFamilies", "targets"])
  ) reject("INVALID_INPUT");
  validateScope(value.scope);
  if (
    typeof value.requesterAccountId !== "string"
    || !ACCOUNT_ID.test(value.requesterAccountId)
    || (value.partition !== "aws" && value.partition !== "aws-us-gov" && value.partition !== "aws-cn")
    || !Array.isArray(value.regions)
    || value.regions.length < 1
    || value.regions.length > maximumRegions
    || value.regions.some((region) => typeof region !== "string" || !validRegionForPartition(region, value.partition as ComputeOptimizerExportPlanPartition))
    || !sortedUnique(value.regions as string[])
    || !Array.isArray(value.exportFamilies)
    || value.exportFamilies.length < 1
    || value.exportFamilies.length > COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumExportFamilies
    || value.exportFamilies.some((family) => !EXPORT_FAMILIES.has(family as ComputeOptimizerExportFamily))
    || !sortedUnique(value.exportFamilies as string[])
    || !Array.isArray(value.targets)
    || value.targets.length < 1
    || value.targets.length > maximumTargets
  ) reject("INVALID_INPUT");
}

async function normalizeInput(
  unsafe: unknown,
  maximumRegions: number = COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumRegionsPerPlan,
  maximumTargets: number = COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumTargets,
): Promise<Omit<ComputeOptimizerExportPlan, "planId" | "contentSha256">> {
  validateInputShape(unsafe, maximumRegions, maximumTargets);
  const input = unsafe;
  const expectedTargetCount = input.regions.length * input.exportFamilies.length;
  if (expectedTargetCount > maximumTargets) {
    reject("LIMIT_EXCEEDED");
  }
  if (input.targets.length < expectedTargetCount) reject("MISSING_TARGET");
  if (input.targets.length > expectedTargetCount) reject("DUPLICATE_TARGET");

  const regionBuckets = new Map<string, string>();
  const bucketRegions = new Map<string, string>();
  const seenPairs = new Set<string>();
  const seenJobs = new Set<string>();
  const targets: ComputeOptimizerExportPlanTarget[] = [];

  for (const raw of input.targets) {
    if (
      !isRecord(raw)
      || !exactKeys(raw, [
        "region",
        "exportFamily",
        "bucket",
        "optionalPrefix",
        "effectivePrefix",
        "request",
        "expectedJob",
      ])
      || typeof raw.region !== "string"
      || !input.regions.includes(raw.region)
      || !EXPORT_FAMILIES.has(raw.exportFamily as ComputeOptimizerExportFamily)
      || !input.exportFamilies.includes(raw.exportFamily as ComputeOptimizerExportFamily)
      || typeof raw.bucket !== "string"
      || !BUCKET.test(raw.bucket)
      || (raw.optionalPrefix !== null && !validPrefix(raw.optionalPrefix))
      || raw.effectivePrefix !== effectivePrefix(raw.optionalPrefix as string | null, input.requesterAccountId)
    ) reject("INVALID_INPUT");
    const target = raw as unknown as ComputeOptimizerExportPlanTargetInput;
    const targetPair = pair(target.region, target.exportFamily);
    if (seenPairs.has(targetPair)) reject("DUPLICATE_TARGET");
    seenPairs.add(targetPair);

    const knownBucket = regionBuckets.get(target.region);
    if (knownBucket !== undefined && knownBucket !== target.bucket) {
      reject("REGION_BUCKET_CONFLICT");
    }
    const knownRegion = bucketRegions.get(target.bucket);
    if (knownRegion !== undefined && knownRegion !== target.region) {
      reject("REGION_BUCKET_CONFLICT");
    }
    regionBuckets.set(target.region, target.bucket);
    bucketRegions.set(target.bucket, target.region);

    validateRequest(target.request, target);
    validateExpectedJob(target.expectedJob, target);
    if (seenJobs.has(target.expectedJob.jobId)) reject("JOB_SUBSTITUTION");
    seenJobs.add(target.expectedJob.jobId);
    targets.push({
      ...structuredClone(target),
      requestSha256: await sha256(canonicalRequest(target.request)),
    });
  }

  for (const region of input.regions) {
    for (const exportFamily of input.exportFamilies) {
      if (!seenPairs.has(pair(region, exportFamily))) reject("MISSING_TARGET");
    }
  }
  targets.sort((left, right) =>
    left.region.localeCompare(right.region) || left.exportFamily.localeCompare(right.exportFamily));
  return {
    schemaVersion: "sutra.compute-optimizer-export-plan.v1",
    scope: { ...input.scope },
    requesterAccountId: input.requesterAccountId,
    partition: input.partition,
    regions: [...input.regions],
    exportFamilies: [...input.exportFamilies],
    targets,
  };
}

export async function createComputeOptimizerExportPlan(
  input: ComputeOptimizerExportPlanInput,
): Promise<ComputeOptimizerExportPlan> {
  const body = await normalizeInput(input);
  const contentSha256 = await sha256(canonicalPlanBody(body));
  return deepFreeze({
    ...body,
    planId: `cope_${contentSha256}`,
    contentSha256,
  });
}

function planTargetInput(
  target: ComputeOptimizerExportPlanTarget,
): ComputeOptimizerExportPlanTargetInput {
  return {
    region: target.region,
    exportFamily: target.exportFamily,
    bucket: target.bucket,
    optionalPrefix: target.optionalPrefix,
    effectivePrefix: target.effectivePrefix,
    request: target.request,
    expectedJob: target.expectedJob,
  };
}

function sameScope(
  left: ComputeOptimizerExportPlanScope,
  right: ComputeOptimizerExportPlanScope,
): boolean {
  return left.orgId === right.orgId
    && left.customerId === right.customerId
    && left.connectionId === right.connectionId;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Seals the all-Region matrix and returns deterministic regional plans. Each
 * plan can be queued independently without weakening the set-wide coverage.
 */
export async function createComputeOptimizerExportPlanSet(
  input: ComputeOptimizerExportPlanSetInput,
): Promise<ComputeOptimizerExportPlanSet> {
  const matrix = await normalizeInput(
    input,
    COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumRegions,
    COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumPlanSetTargets,
  );
  const plans = await Promise.all(matrix.regions.map((region) =>
    createComputeOptimizerExportPlan({
      scope: matrix.scope,
      requesterAccountId: matrix.requesterAccountId,
      partition: matrix.partition,
      regions: [region],
      exportFamilies: matrix.exportFamilies,
      targets: matrix.targets
        .filter((target) => target.region === region)
        .map(planTargetInput),
    })));
  const identityBody: ComputeOptimizerExportPlanSetIdentityBody = {
    schemaVersion: "sutra.compute-optimizer-export-plan-set.v1",
    scope: { ...matrix.scope },
    requesterAccountId: matrix.requesterAccountId,
    partition: matrix.partition,
    regions: [...matrix.regions],
    exportFamilies: [...matrix.exportFamilies],
    planIds: plans.map((plan) => plan.planId),
  };
  const contentSha256 = await sha256(canonicalPlanSetBody(identityBody));
  return deepFreeze({
    ...identityBody,
    planSetId: `copes_${contentSha256}`,
    contentSha256,
    plans,
  });
}

export async function verifyComputeOptimizerExportPlan(
  value: unknown,
): Promise<ComputeOptimizerExportPlan> {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "schemaVersion",
      "planId",
      "contentSha256",
      "scope",
      "requesterAccountId",
      "partition",
      "regions",
      "exportFamilies",
      "targets",
    ])
    || value.schemaVersion !== "sutra.compute-optimizer-export-plan.v1"
    || typeof value.planId !== "string"
    || !PLAN_ID.test(value.planId)
    || typeof value.contentSha256 !== "string"
    || !SHA256.test(value.contentSha256)
    || !Array.isArray(value.targets)
  ) reject("INVALID_INPUT");
  const rawInput = {
    scope: value.scope,
    requesterAccountId: value.requesterAccountId,
    partition: value.partition,
    regions: value.regions,
    exportFamilies: value.exportFamilies,
    targets: value.targets.map((target) => {
      if (!isRecord(target) || !exactKeys(target, [
        "region", "exportFamily", "bucket", "optionalPrefix", "effectivePrefix",
        "request", "expectedJob", "requestSha256",
      ]) || typeof target.requestSha256 !== "string" || !SHA256.test(target.requestSha256)) {
        reject("INVALID_INPUT");
      }
      return {
        region: target.region,
        exportFamily: target.exportFamily,
        bucket: target.bucket,
        optionalPrefix: target.optionalPrefix,
        effectivePrefix: target.effectivePrefix,
        request: target.request,
        expectedJob: target.expectedJob,
      };
    }),
  };
  const normalized = await normalizeInput(rawInput);
  for (let index = 0; index < normalized.targets.length; index += 1) {
    const supplied = value.targets[index] as Record<string, unknown>;
    if (supplied.requestSha256 !== normalized.targets[index]!.requestSha256) {
      reject("CONTENT_HASH_MISMATCH");
    }
  }
  const contentSha256 = await sha256(canonicalPlanBody(normalized));
  if (value.contentSha256 !== contentSha256 || value.planId !== `cope_${contentSha256}`) {
    reject("CONTENT_HASH_MISMATCH");
  }
  return deepFreeze({ ...normalized, planId: value.planId, contentSha256 });
}

export async function verifyComputeOptimizerExportPlanSet(
  value: unknown,
): Promise<ComputeOptimizerExportPlanSet> {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "schemaVersion",
      "planSetId",
      "contentSha256",
      "scope",
      "requesterAccountId",
      "partition",
      "regions",
      "exportFamilies",
      "planIds",
      "plans",
    ])
    || value.schemaVersion !== "sutra.compute-optimizer-export-plan-set.v1"
    || typeof value.planSetId !== "string"
    || !PLAN_SET_ID.test(value.planSetId)
    || typeof value.contentSha256 !== "string"
    || !SHA256.test(value.contentSha256)
    || typeof value.requesterAccountId !== "string"
    || !ACCOUNT_ID.test(value.requesterAccountId)
    || (value.partition !== "aws" && value.partition !== "aws-us-gov" && value.partition !== "aws-cn")
    || !Array.isArray(value.regions)
    || value.regions.length < 1
    || value.regions.length > COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumRegions
    || value.regions.some((region) => typeof region !== "string"
      || !validRegionForPartition(region, value.partition as ComputeOptimizerExportPlanPartition))
    || !sortedUnique(value.regions as string[])
    || !Array.isArray(value.exportFamilies)
    || value.exportFamilies.length < 1
    || value.exportFamilies.length > COMPUTE_OPTIMIZER_EXPORT_PLAN_BOUNDS.maximumExportFamilies
    || value.exportFamilies.some((family) => !EXPORT_FAMILIES.has(family as ComputeOptimizerExportFamily))
    || !sortedUnique(value.exportFamilies as string[])
    || !Array.isArray(value.planIds)
    || value.planIds.length !== value.regions.length
    || value.planIds.some((planId) => typeof planId !== "string" || !PLAN_ID.test(planId))
    || !Array.isArray(value.plans)
    || value.plans.length !== value.regions.length
  ) reject("INVALID_INPUT");
  validateScope(value.scope);

  const scope = value.scope;
  const requesterAccountId = value.requesterAccountId;
  const partition = value.partition;
  const regions = value.regions as string[];
  const exportFamilies = value.exportFamilies as ComputeOptimizerExportFamily[];
  const planIds = value.planIds as string[];
  const plans: ComputeOptimizerExportPlan[] = [];
  const buckets = new Set<string>();
  const jobs = new Set<string>();
  for (let index = 0; index < regions.length; index += 1) {
    const plan = await verifyComputeOptimizerExportPlan(value.plans[index]);
    const regionalBuckets = new Set(plan.targets.map((target) => target.bucket));
    if (
      !sameScope(plan.scope, scope)
      || plan.requesterAccountId !== requesterAccountId
      || plan.partition !== partition
      || plan.regions.length !== 1
      || plan.regions[0] !== regions[index]
      || !sameStrings(plan.exportFamilies, exportFamilies)
      || plan.planId !== planIds[index]
      || regionalBuckets.size !== 1
    ) reject("SCOPE_MISMATCH");
    const bucket = regionalBuckets.values().next().value as string;
    if (buckets.has(bucket)) reject("REGION_BUCKET_CONFLICT");
    buckets.add(bucket);
    for (const target of plan.targets) {
      if (jobs.has(target.expectedJob.jobId)) reject("JOB_SUBSTITUTION");
      jobs.add(target.expectedJob.jobId);
    }
    plans.push(plan);
  }

  const identityBody: ComputeOptimizerExportPlanSetIdentityBody = {
    schemaVersion: "sutra.compute-optimizer-export-plan-set.v1",
    scope: { ...scope },
    requesterAccountId,
    partition,
    regions: [...regions],
    exportFamilies: [...exportFamilies],
    planIds: [...planIds],
  };
  const contentSha256 = await sha256(canonicalPlanSetBody(identityBody));
  if (value.contentSha256 !== contentSha256 || value.planSetId !== `copes_${contentSha256}`) {
    reject("CONTENT_HASH_MISMATCH");
  }
  return deepFreeze({
    ...identityBody,
    planSetId: value.planSetId,
    contentSha256,
    plans,
  });
}

export function verifyCompletedComputeOptimizerExportJobs(
  plan: ComputeOptimizerExportPlan,
  jobs: readonly ObservedCompletedComputeOptimizerExportJob[],
): VerifiedComputeOptimizerExportJobBinding {
  if (
    !isRecord(plan)
    || !PLAN_ID.test(plan.planId)
    || !SHA256.test(plan.contentSha256)
    || !Array.isArray(jobs)
    || jobs.length !== plan.targets.length
  ) reject("JOB_SUBSTITUTION");
  const expectedByPair = new Map(
    plan.targets.map((target) => [pair(target.region, target.exportFamily), target]),
  );
  const seenPairs = new Set<string>();
  const seenJobs = new Set<string>();
  for (const job of jobs) {
    if (
      !isRecord(job)
      || !exactKeys(job, ["jobId", "region", "providerResourceType", "status", "bucket", "objectKey", "metadataKey"])
      || typeof job.jobId !== "string"
      || typeof job.region !== "string"
      || typeof job.providerResourceType !== "string"
      || typeof job.bucket !== "string"
      || typeof job.objectKey !== "string"
      || typeof job.metadataKey !== "string"
    ) reject("JOB_SUBSTITUTION");
    const candidates = plan.targets.filter((target) =>
      target.region === job.region
      && target.expectedJob.providerResourceType === job.providerResourceType);
    if (candidates.length !== 1) reject("JOB_SUBSTITUTION");
    const key = pair(candidates[0]!.region, candidates[0]!.exportFamily);
    const target = expectedByPair.get(key);
    if (
      target === undefined
      || seenPairs.has(key)
      || seenJobs.has(job.jobId)
      || job.status !== "COMPLETE"
      || job.jobId !== target.expectedJob.jobId
      || job.providerResourceType !== target.expectedJob.providerResourceType
      || job.bucket !== target.expectedJob.bucket
      || job.objectKey !== target.expectedJob.objectKey
      || job.metadataKey !== target.expectedJob.metadataKey
    ) reject("JOB_SUBSTITUTION");
    seenPairs.add(key);
    seenJobs.add(job.jobId);
  }
  if (seenPairs.size !== plan.targets.length) reject("JOB_SUBSTITUTION");
  return deepFreeze({
    planId: plan.planId,
    contentSha256: plan.contentSha256,
    targets: plan.targets.map((target) => ({
      region: target.region,
      exportFamily: target.exportFamily,
      providerResourceType: target.expectedJob.providerResourceType,
      requestSha256: target.requestSha256,
      jobId: target.expectedJob.jobId,
      bucket: target.expectedJob.bucket,
      objectKey: target.expectedJob.objectKey,
      metadataKey: target.expectedJob.metadataKey,
    })),
  });
}
