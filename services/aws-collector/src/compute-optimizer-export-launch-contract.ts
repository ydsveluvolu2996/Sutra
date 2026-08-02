import type {
  AwsPartition,
  ComputeOptimizerExportLaunchContract,
} from "./types.js";
import {
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_CONTRACT_ID,
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const BUCKET =
  /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!xn--)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const PREFIX_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._=-]{0,62}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const PROVIDER_TIMESTAMP = /^[A-Za-z0-9][A-Za-z0-9:._+-]{0,127}$/u;
const KMS_KEY_ID = /^[A-Za-z0-9-]{1,128}$/u;

const CONTRACT_KEYS = [
  "tenantId", "connectionId", "accountId", "partition", "region", "contractId",
  "permissionPackVersion", "permissionContractId", "policyName", "bucket",
  "bucketArn", "basePrefix", "effectivePrefix", "objectArnPrefix",
  "encryptionMode", "kmsKeyArn", "bucketVersioningStatus", "servicePrincipal",
] as const;

export interface ComputeOptimizerExportLaunchContractOwner {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly expectedAccountId: string;
  readonly partition: AwsPartition;
}

export class ComputeOptimizerExportLaunchContractError extends Error {
  public constructor() {
    super("The persisted Compute Optimizer export launch contract is invalid");
    this.name = "ComputeOptimizerExportLaunchContractError";
  }
}

export function parseComputeOptimizerExportLaunchContracts(
  value: unknown,
  owner: ComputeOptimizerExportLaunchContractOwner,
): readonly ComputeOptimizerExportLaunchContract[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) fail();
  const contracts = value.map((candidate) => parseContract(candidate, owner));
  for (const projection of [
    contracts.map(({ contractId }) => contractId),
    contracts.map(({ region }) => region),
    contracts.map(({ policyName }) => policyName),
    contracts.map(({ bucket }) => bucket),
  ]) if (new Set(projection).size !== contracts.length) fail();
  return Object.freeze(contracts
    .sort((left, right) => left.region.localeCompare(right.region))
    .map((contract) => Object.freeze(contract)));
}

export function resolveComputeOptimizerExportLaunchContract(
  value: unknown,
  owner: ComputeOptimizerExportLaunchContractOwner,
  contractId: string,
  region: string,
): ComputeOptimizerExportLaunchContract {
  if (!IDENTIFIER.test(contractId) || !REGION.test(region)) fail();
  const match = parseComputeOptimizerExportLaunchContracts(value, owner)
    .find((contract) => contract.contractId === contractId && contract.region === region);
  if (match === undefined) fail();
  return match;
}

export function resolveComputeOptimizerExportLaunchContractForRegion(
  value: unknown,
  owner: ComputeOptimizerExportLaunchContractOwner,
  region: string,
): ComputeOptimizerExportLaunchContract {
  if (!REGION.test(region)) fail();
  const match = parseComputeOptimizerExportLaunchContracts(value, owner)
    .find((contract) => contract.region === region);
  if (match === undefined) fail();
  return match;
}

export function computeOptimizerExportLaunchPrefixArn(
  contract: ComputeOptimizerExportLaunchContract,
): string {
  return `arn:${contract.partition}:s3:::${contract.bucket}/${contract.effectivePrefix}*`;
}

/**
 * Validate one provider-created CSV/metadata address beneath the regional
 * launch contract. No wildcard or caller-selected sibling prefix survives.
 */
export function parseComputeOptimizerExportLaunchObjectAddress(
  contract: ComputeOptimizerExportLaunchContract,
  region: string,
  bucket: string,
  objectKey: string,
  plannedJobId: string,
): string {
  if (
    region !== contract.region || bucket !== contract.bucket ||
    !JOB_ID.test(plannedJobId) || Buffer.byteLength(objectKey, "utf8") > 1_024 ||
    !objectKey.startsWith(contract.effectivePrefix) || /[%\\*?\u0000]/u.test(objectKey)
  ) fail();
  const basename = objectKey.slice(contract.effectivePrefix.length);
  if (basename.length === 0 || basename.includes("/")) fail();
  const csvSuffix = `-${plannedJobId}.csv`;
  const metadataSuffix = `-${plannedJobId}-metadata.json`;
  const suffix = basename.endsWith(metadataSuffix)
    ? metadataSuffix
    : basename.endsWith(csvSuffix) ? csvSuffix : null;
  if (suffix === null || !basename.startsWith(`${region}-`)) fail();
  const providerTimestamp = basename.slice(region.length + 1, -suffix.length);
  if (!PROVIDER_TIMESTAMP.test(providerTimestamp)) fail();
  return `arn:${contract.partition}:s3:::${contract.bucket}/${objectKey}`;
}

function parseContract(
  value: unknown,
  owner: ComputeOptimizerExportLaunchContractOwner,
): ComputeOptimizerExportLaunchContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, CONTRACT_KEYS)) fail();
  if (
    record.tenantId !== owner.tenantId || record.connectionId !== owner.connectionId ||
    record.accountId !== owner.expectedAccountId || record.partition !== owner.partition ||
    typeof record.tenantId !== "string" || !IDENTIFIER.test(record.tenantId) ||
    typeof record.connectionId !== "string" || !CONNECTION_ID.test(record.connectionId) ||
    typeof record.accountId !== "string" || !ACCOUNT_ID.test(record.accountId) ||
    typeof record.region !== "string" || !REGION.test(record.region) ||
    !regionMatchesPartition(record.region, owner.partition) ||
    typeof record.contractId !== "string" || !IDENTIFIER.test(record.contractId) ||
    record.permissionPackVersion !== COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION ||
    record.permissionContractId !== COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_CONTRACT_ID ||
    record.policyName !== `SutraComputeOptimizerExportLaunchV1-${record.region}` ||
    typeof record.bucket !== "string" || !BUCKET.test(record.bucket) ||
    record.bucketArn !== `arn:${owner.partition}:s3:::${record.bucket}` ||
    typeof record.basePrefix !== "string" || !validBasePrefix(record.basePrefix) ||
    record.effectivePrefix !==
      `${record.basePrefix}compute-optimizer/${owner.expectedAccountId}/` ||
    record.objectArnPrefix !==
      `arn:${owner.partition}:s3:::${record.bucket}/${record.effectivePrefix}*` ||
    record.encryptionMode !== "SSE_KMS" ||
    record.kmsKeyArn !==
      `arn:${owner.partition}:kms:${record.region}:${owner.expectedAccountId}:key/${typeof record.kmsKeyArn === "string" ? record.kmsKeyArn.split("/").at(-1) ?? "" : ""}` ||
    typeof record.kmsKeyArn !== "string" ||
    !KMS_KEY_ID.test(record.kmsKeyArn.split("/").at(-1) ?? "") ||
    record.bucketVersioningStatus !== "Enabled" ||
    record.servicePrincipal !== "compute-optimizer.amazonaws.com"
  ) fail();
  return {
    tenantId: record.tenantId,
    connectionId: record.connectionId,
    accountId: record.accountId,
    partition: owner.partition,
    region: record.region,
    contractId: record.contractId,
    permissionPackVersion: COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
    permissionContractId: COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_CONTRACT_ID,
    policyName: record.policyName,
    bucket: record.bucket,
    bucketArn: record.bucketArn,
    basePrefix: record.basePrefix,
    effectivePrefix: record.effectivePrefix,
    objectArnPrefix: record.objectArnPrefix,
    encryptionMode: "SSE_KMS",
    kmsKeyArn: record.kmsKeyArn,
    bucketVersioningStatus: "Enabled",
    servicePrincipal: "compute-optimizer.amazonaws.com",
  };
}

function validBasePrefix(value: string): boolean {
  if (value === "") return true;
  if (Buffer.byteLength(value, "utf8") > 180 || !value.endsWith("/") ||
      value.startsWith("/") || /[%\\*?\u0000]/u.test(value)) return false;
  const segments = value.slice(0, -1).split("/");
  return segments.length >= 1 && segments.length <= 4 &&
    segments.every((segment) => segment !== "." && segment !== ".." && PREFIX_SEGMENT.test(segment));
}

function regionMatchesPartition(region: string, partition: AwsPartition): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function fail(): never {
  throw new ComputeOptimizerExportLaunchContractError();
}
