import type {
  AwsPartition,
  ComputeOptimizerExportObjectContract,
  ComputeOptimizerExportObjectEncryptionMode,
} from "./types.js";
import {
  COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_CONTRACT_ID,
  COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const BUCKET =
  /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!xn--)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const PREFIX_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._=-]{0,62}$/u;
const POLICY_NAME = /^[\w+=,.@-]{1,128}$/u;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const PROVIDER_TIMESTAMP = /^[A-Za-z0-9][A-Za-z0-9:._+-]{0,127}$/u;
const VERSION_ID = /^[\u0021-\u007e]{1,1024}$/u;
// The reviewed add-on accepts at most 180 characters of ExportBasePrefix and
// appends the fixed provider/account suffix. Keep registry state within that
// exact provisionable envelope rather than accepting an unattestable prefix.
const MAX_PREFIX_BYTES = 211;

const CONTRACT_KEYS = [
  "tenantId",
  "connectionId",
  "accountId",
  "partition",
  "region",
  "contractId",
  "permissionPackVersion",
  "permissionContractId",
  "policyName",
  "bucket",
  "effectivePrefix",
  "encryptionMode",
  "kmsKeyArn",
] as const;

export interface ComputeOptimizerExportObjectContractOwner {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly expectedAccountId: string;
  readonly partition: AwsPartition;
}

export type ComputeOptimizerExportObjectKind = "CSV" | "METADATA";

export type ComputeOptimizerExportObjectVersionIdentity =
  | { readonly kind: "CURRENT"; readonly versionId: null }
  | { readonly kind: "VERSION"; readonly versionId: string };

export interface ParsedComputeOptimizerExportObjectAddress {
  readonly kind: ComputeOptimizerExportObjectKind;
  readonly objectArn: string;
  readonly providerTimestamp: string;
}

export class ComputeOptimizerExportObjectContractError extends Error {
  public constructor() {
    super("The persisted Compute Optimizer export object contract is invalid");
    this.name = "ComputeOptimizerExportObjectContractError";
  }
}

export function parseComputeOptimizerExportObjectContracts(
  value: unknown,
  owner: ComputeOptimizerExportObjectContractOwner,
): readonly ComputeOptimizerExportObjectContract[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) fail();
  const contracts = value.map((candidate) => parseContract(candidate, owner));
  if (
    new Set(contracts.map(({ contractId }) => contractId)).size !== contracts.length ||
    new Set(contracts.map(({ policyName }) => policyName)).size !== contracts.length ||
    new Set(contracts.map(({ region, bucket, effectivePrefix }) =>
      `${region}\u0000${bucket}\u0000${effectivePrefix}`
    )).size !== contracts.length
  ) fail();
  return Object.freeze(
    contracts
      .sort((left, right) => left.contractId.localeCompare(right.contractId))
      .map((contract) => Object.freeze(contract)),
  );
}

export function resolveComputeOptimizerExportObjectContract(
  value: unknown,
  owner: ComputeOptimizerExportObjectContractOwner,
  contractId: string,
): ComputeOptimizerExportObjectContract {
  if (!IDENTIFIER.test(contractId)) fail();
  const match = parseComputeOptimizerExportObjectContracts(value, owner)
    .find((contract) => contract.contractId === contractId);
  if (match === undefined) fail();
  return match;
}

export function parseComputeOptimizerExportObjectVersionIdentity(
  value: unknown,
): ComputeOptimizerExportObjectVersionIdentity {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["kind", "versionId"])) fail();
  if (record.kind === "CURRENT" && record.versionId === null) {
    return Object.freeze({ kind: "CURRENT", versionId: null });
  }
  if (
    record.kind === "VERSION" &&
    typeof record.versionId === "string" &&
    VERSION_ID.test(record.versionId) &&
    !/[\s%\\*?]/u.test(record.versionId)
  ) {
    return Object.freeze({ kind: "VERSION", versionId: record.versionId });
  }
  fail();
}

export function parseComputeOptimizerExportObjectAddress(
  contract: ComputeOptimizerExportObjectContract,
  partition: AwsPartition,
  region: string,
  bucket: string,
  objectKey: string,
  plannedJobId: string,
): ParsedComputeOptimizerExportObjectAddress {
  if (
    partition !== contract.partition ||
    region !== contract.region ||
    bucket !== contract.bucket ||
    !JOB_ID.test(plannedJobId) ||
    Buffer.byteLength(objectKey, "utf8") > 1_024 ||
    !objectKey.startsWith(contract.effectivePrefix) ||
    /[%\\*?\u0000]/u.test(objectKey)
  ) fail();
  const basename = objectKey.slice(contract.effectivePrefix.length);
  if (basename.length === 0 || basename.includes("/")) fail();
  const csvSuffix = `-${plannedJobId}.csv`;
  const metadataSuffix = `-${plannedJobId}-metadata.json`;
  const suffix = basename.endsWith(metadataSuffix)
    ? metadataSuffix
    : basename.endsWith(csvSuffix)
      ? csvSuffix
      : null;
  if (suffix === null || !basename.startsWith(`${region}-`)) fail();
  const providerTimestamp = basename.slice(region.length + 1, -suffix.length);
  if (!PROVIDER_TIMESTAMP.test(providerTimestamp)) fail();
  return Object.freeze({
    kind: suffix === csvSuffix ? "CSV" : "METADATA",
    objectArn: `arn:${partition}:s3:::${bucket}/${objectKey}`,
    providerTimestamp,
  });
}

export function computeOptimizerExportObjectPrefixArn(
  contract: ComputeOptimizerExportObjectContract,
): string {
  return `arn:${contract.partition}:s3:::${contract.bucket}/${contract.effectivePrefix}*`;
}

export function computeOptimizerKmsViaService(
  contract: Pick<ComputeOptimizerExportObjectContract, "partition" | "region">,
): string {
  // KMS ViaService uses this DNS form in every supported AWS partition,
  // including China. It is an IAM condition value, not the public S3 endpoint.
  return `s3.${contract.region}.amazonaws.com`;
}

function parseContract(
  value: unknown,
  owner: ComputeOptimizerExportObjectContractOwner,
): ComputeOptimizerExportObjectContract {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail();
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, CONTRACT_KEYS)) fail();
  if (
    record.tenantId !== owner.tenantId ||
    record.connectionId !== owner.connectionId ||
    record.accountId !== owner.expectedAccountId ||
    record.partition !== owner.partition ||
    typeof record.tenantId !== "string" || !IDENTIFIER.test(record.tenantId) ||
    typeof record.connectionId !== "string" || !CONNECTION_ID.test(record.connectionId) ||
    typeof record.accountId !== "string" || !ACCOUNT_ID.test(record.accountId) ||
    typeof record.region !== "string" || !REGION.test(record.region) ||
    !regionMatchesPartition(record.region, owner.partition) ||
    typeof record.contractId !== "string" || !IDENTIFIER.test(record.contractId) ||
    record.permissionPackVersion !== COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION ||
    record.permissionContractId !== COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_CONTRACT_ID ||
    typeof record.policyName !== "string" || !POLICY_NAME.test(record.policyName) ||
    record.policyName !== `SutraComputeOptimizerExportReadV1-${record.region}-${record.bucket}` ||
    typeof record.bucket !== "string" || !BUCKET.test(record.bucket) ||
    typeof record.effectivePrefix !== "string" ||
    !validEffectivePrefix(record.effectivePrefix, owner.expectedAccountId) ||
    !validEncryption(record.encryptionMode, record.kmsKeyArn, owner, record.region)
  ) fail();
  return {
    tenantId: record.tenantId,
    connectionId: record.connectionId,
    accountId: record.accountId,
    partition: owner.partition,
    region: record.region,
    contractId: record.contractId,
    permissionPackVersion: COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION,
    permissionContractId: COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_CONTRACT_ID,
    policyName: record.policyName,
    bucket: record.bucket,
    effectivePrefix: record.effectivePrefix,
    encryptionMode: record.encryptionMode as ComputeOptimizerExportObjectEncryptionMode,
    kmsKeyArn: record.kmsKeyArn as string | null,
  };
}

function validEffectivePrefix(value: string, accountId: string): boolean {
  if (
    Buffer.byteLength(value, "utf8") > MAX_PREFIX_BYTES ||
    value.startsWith("/") ||
    /[%\\*?\u0000]/u.test(value) ||
    !value.endsWith(`/compute-optimizer/${accountId}/`)
  ) return false;
  const segments = value.slice(0, -1).split("/");
  return segments.length >= 2 && segments.length <= 6 &&
    segments.every((segment) =>
      segment !== "." && segment !== ".." && PREFIX_SEGMENT.test(segment)
    );
}

function validEncryption(
  mode: unknown,
  kmsKeyArn: unknown,
  owner: ComputeOptimizerExportObjectContractOwner,
  region: string,
): boolean {
  if (mode === "SSE_S3") return kmsKeyArn === null;
  if (mode !== "SSE_KMS" || typeof kmsKeyArn !== "string") return false;
  const prefix = `arn:${owner.partition}:kms:${region}:${owner.expectedAccountId}:key/`;
  return kmsKeyArn.startsWith(prefix) &&
    /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u.test(kmsKeyArn.slice(prefix.length));
}

function regionMatchesPartition(region: string, partition: AwsPartition): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function fail(): never {
  throw new ComputeOptimizerExportObjectContractError();
}
