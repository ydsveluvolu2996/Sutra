/**
 * Collector-owned projection for the exact regional contracts required to
 * start one Compute Optimizer materialization activation. The projection is a
 * capability manifest only: credentials, role identities and IAM documents
 * are deliberately outside its exact schema.
 */
import {
  parseComputeOptimizerExportLaunchContracts,
} from "./compute-optimizer-export-launch-contract.js";
import {
  parseComputeOptimizerExportObjectContracts,
} from "./compute-optimizer-export-object-contract.js";
import {
  COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID,
  parseFinopsSourceContracts,
} from "./finops-source-contract.js";
import {
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
  type AwsPartition,
} from "./types.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const BUCKET =
  /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!xn--)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const PREFIX_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._=-]{0,62}$/u;
const MAX_REGIONS = 50;
const MAX_MANIFEST_BYTES = 64 * 1_024;

export const COMPUTE_OPTIMIZER_ACTIVATION_MANIFEST_BOUNDS = Object.freeze({
  maximumRegions: MAX_REGIONS,
  maximumSerializedBytes: MAX_MANIFEST_BYTES,
} as const);

export interface ComputeOptimizerMaterializationActivationManifestOwner {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly expectedAccountId: string;
  readonly partition: AwsPartition;
  readonly permissionPackVersion: string;
  readonly enabledRegions: readonly string[];
}

export interface ComputeOptimizerMaterializationActivationManifestRequest {
  readonly schema:
    "sutra.compute-optimizer-materialization-activation-manifest-request.v1";
  readonly requestId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly requiredPermissionPackVersion: "standard-2026-08.5";
}

export interface ComputeOptimizerMaterializationActivationManifestRegion {
  readonly region: string;
  readonly describeContractId: string;
  readonly launchContractId: string;
  readonly objectReadContractId: string;
  readonly bucket: string;
  readonly basePrefix: string;
  readonly effectivePrefix: string;
}

export interface ComputeOptimizerMaterializationActivationManifest {
  readonly schema:
    "sutra.compute-optimizer-materialization-activation-manifest-response.v1";
  readonly requestId: string;
  readonly tenantId: string;
  readonly connectionId: string;
  readonly accountId: string;
  readonly partition: AwsPartition;
  readonly permissionPackVersion: "standard-2026-08.5";
  readonly regions: readonly ComputeOptimizerMaterializationActivationManifestRegion[];
}

export class ComputeOptimizerMaterializationActivationManifestError extends Error {
  // Declared and assigned rather than a constructor parameter property: Node's default strip-only TypeScript mode
  // cannot transform parameter properties, so any test importing this module without the transform loader fails to
  // load it.
  public readonly code:
    | "INVALID_OWNER"
    | "INVALID_REQUEST"
    | "CONTRACT_MATRIX_INVALID"
    | "MANIFEST_INVALID"
    | "LIMIT_EXCEEDED";
  public constructor(code: ComputeOptimizerMaterializationActivationManifestError["code"]) {
    super("Compute Optimizer materialization activation manifest rejected");
    this.name = "ComputeOptimizerMaterializationActivationManifestError";
    this.code = code;
  }
}

function reject(
  code: ComputeOptimizerMaterializationActivationManifestError["code"],
): never {
  throw new ComputeOptimizerMaterializationActivationManifestError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length
    && actual.every((key, index) => key === wanted[index]);
}

function regionMatchesPartition(region: string, partition: AwsPartition): boolean {
  if (partition === "aws-cn") return region.startsWith("cn-");
  if (partition === "aws-us-gov") return region.startsWith("us-gov-");
  return !region.startsWith("cn-") && !region.startsWith("us-gov-");
}

function sortedRegions(value: unknown, partition: AwsPartition): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REGIONS
    || value.some((region) => typeof region !== "string" || !REGION.test(region)
      || !regionMatchesPartition(region, partition))) reject("INVALID_OWNER");
  const regions = [...value].sort() as string[];
  if (new Set(regions).size !== regions.length) reject("INVALID_OWNER");
  return Object.freeze(regions);
}

function validatedOwner(owner: ComputeOptimizerMaterializationActivationManifestOwner) {
  if (!isRecord(owner) || !exactKeys(owner, [
    "tenantId", "connectionId", "expectedAccountId", "partition",
    "permissionPackVersion", "enabledRegions",
  ]) || typeof owner.tenantId !== "string" || !IDENTIFIER.test(owner.tenantId)
    || typeof owner.connectionId !== "string" || !CONNECTION_ID.test(owner.connectionId)
    || typeof owner.expectedAccountId !== "string" || !ACCOUNT_ID.test(owner.expectedAccountId)
    || (owner.partition !== "aws" && owner.partition !== "aws-us-gov"
      && owner.partition !== "aws-cn")
    || owner.permissionPackVersion
      !== COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION) {
    reject("INVALID_OWNER");
  }
  return Object.freeze({ ...owner, enabledRegions: sortedRegions(
    owner.enabledRegions,
    owner.partition,
  ) });
}

export function parseComputeOptimizerMaterializationActivationManifestRequest(
  value: unknown,
  owner: ComputeOptimizerMaterializationActivationManifestOwner,
): ComputeOptimizerMaterializationActivationManifestRequest {
  const trusted = validatedOwner(owner);
  if (!isRecord(value) || !exactKeys(value, [
    "schema", "requestId", "tenantId", "connectionId", "accountId", "partition",
    "requiredPermissionPackVersion",
  ])
    || value.schema
      !== "sutra.compute-optimizer-materialization-activation-manifest-request.v1"
    || typeof value.requestId !== "string" || !IDENTIFIER.test(value.requestId)
    || value.tenantId !== trusted.tenantId
    || value.connectionId !== trusted.connectionId
    || value.accountId !== trusted.expectedAccountId
    || value.partition !== trusted.partition
    || value.requiredPermissionPackVersion
      !== COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION) {
    reject("INVALID_REQUEST");
  }
  return Object.freeze({
    schema: "sutra.compute-optimizer-materialization-activation-manifest-request.v1",
    requestId: value.requestId,
    tenantId: trusted.tenantId,
    connectionId: trusted.connectionId,
    accountId: trusted.expectedAccountId,
    partition: trusted.partition,
    requiredPermissionPackVersion:
      COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
  });
}

function validPrefix(basePrefix: unknown, effectivePrefix: unknown, accountId: string): boolean {
  if (typeof basePrefix !== "string" || typeof effectivePrefix !== "string"
    || Buffer.byteLength(basePrefix, "utf8") > 180 || basePrefix.startsWith("/")
    || /[%\\*?\u0000]/u.test(basePrefix)
    || effectivePrefix !== `${basePrefix}compute-optimizer/${accountId}/`) return false;
  if (basePrefix === "") return true;
  if (!basePrefix.endsWith("/")) return false;
  const segments = basePrefix.slice(0, -1).split("/");
  return segments.length >= 1 && segments.length <= 4
    && segments.every((segment) => segment !== "." && segment !== ".."
      && PREFIX_SEGMENT.test(segment));
}

function validRegionRow(
  value: unknown,
  expectedRegion: string,
  owner: ReturnType<typeof validatedOwner>,
): value is ComputeOptimizerMaterializationActivationManifestRegion {
  return isRecord(value) && exactKeys(value, [
    "region", "describeContractId", "launchContractId", "objectReadContractId",
    "bucket", "basePrefix", "effectivePrefix",
  ]) && value.region === expectedRegion
    && typeof value.describeContractId === "string" && IDENTIFIER.test(value.describeContractId)
    && typeof value.launchContractId === "string" && IDENTIFIER.test(value.launchContractId)
    && typeof value.objectReadContractId === "string" && IDENTIFIER.test(value.objectReadContractId)
    && typeof value.bucket === "string" && BUCKET.test(value.bucket)
    && validPrefix(value.basePrefix, value.effectivePrefix, owner.expectedAccountId);
}

export function parseComputeOptimizerMaterializationActivationManifest(
  value: unknown,
  owner: ComputeOptimizerMaterializationActivationManifestOwner,
  expectedRequestId: string,
): ComputeOptimizerMaterializationActivationManifest {
  const trusted = validatedOwner(owner);
  if (!IDENTIFIER.test(expectedRequestId) || !isRecord(value) || !exactKeys(value, [
    "schema", "requestId", "tenantId", "connectionId", "accountId", "partition",
    "permissionPackVersion", "regions",
  ]) || value.schema
      !== "sutra.compute-optimizer-materialization-activation-manifest-response.v1"
    || value.requestId !== expectedRequestId || value.tenantId !== trusted.tenantId
    || value.connectionId !== trusted.connectionId
    || value.accountId !== trusted.expectedAccountId || value.partition !== trusted.partition
    || value.permissionPackVersion
      !== COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION
    || !Array.isArray(value.regions)
    || value.regions.length !== trusted.enabledRegions.length
    || value.regions.some((row, index) =>
      !validRegionRow(row, trusted.enabledRegions[index]!, trusted))) {
    reject("MANIFEST_INVALID");
  }
  const rows = value.regions as unknown as ComputeOptimizerMaterializationActivationManifestRegion[];
  const identities = rows.flatMap((row) => [
    row.describeContractId, row.launchContractId, row.objectReadContractId,
  ]);
  if (new Set(identities).size !== identities.length) reject("MANIFEST_INVALID");
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return reject("MANIFEST_INVALID"); }
  if (Buffer.byteLength(serialized, "utf8") > MAX_MANIFEST_BYTES) reject("LIMIT_EXCEEDED");
  return Object.freeze({
    schema: "sutra.compute-optimizer-materialization-activation-manifest-response.v1",
    requestId: expectedRequestId,
    tenantId: trusted.tenantId,
    connectionId: trusted.connectionId,
    accountId: trusted.expectedAccountId,
    partition: trusted.partition,
    permissionPackVersion: COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
    regions: Object.freeze(rows.map((row) => Object.freeze({ ...row }))),
  });
}

export function projectComputeOptimizerMaterializationActivationManifest(input: {
  readonly owner: ComputeOptimizerMaterializationActivationManifestOwner;
  readonly request: unknown;
  readonly sourceContracts: unknown;
  readonly launchContracts: unknown;
  readonly objectReadContracts: unknown;
}): ComputeOptimizerMaterializationActivationManifest {
  const owner = validatedOwner(input.owner);
  const request = parseComputeOptimizerMaterializationActivationManifestRequest(
    input.request,
    owner,
  );
  const contractOwner = {
    tenantId: owner.tenantId,
    connectionId: owner.connectionId,
    expectedAccountId: owner.expectedAccountId,
    partition: owner.partition,
  } as const;
  let sources;
  let launches;
  let objectReads;
  try {
    sources = parseFinopsSourceContracts(input.sourceContracts, contractOwner)
      .filter(({ sourceId }) => sourceId === "compute_optimizer_organization_export");
    launches = parseComputeOptimizerExportLaunchContracts(
      input.launchContracts,
      contractOwner,
    );
    objectReads = parseComputeOptimizerExportObjectContracts(
      input.objectReadContracts,
      contractOwner,
    );
  } catch { return reject("CONTRACT_MATRIX_INVALID"); }
  if (sources.length !== owner.enabledRegions.length
    || launches.length !== owner.enabledRegions.length
    || objectReads.length !== owner.enabledRegions.length) reject("CONTRACT_MATRIX_INVALID");
  const rows = owner.enabledRegions.map((region) => {
    const source = sources.filter((contract) => contract.region === region
      && contract.permissionContractId
        === COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID);
    const launch = launches.filter((contract) => contract.region === region);
    const objectRead = objectReads.filter((contract) => contract.region === region);
    if (source.length !== 1 || launch.length !== 1 || objectRead.length !== 1) {
      return reject("CONTRACT_MATRIX_INVALID");
    }
    const exactLaunch = launch[0]!;
    const exactObjectRead = objectRead[0]!;
    if (exactObjectRead.bucket !== exactLaunch.bucket
      || exactObjectRead.effectivePrefix !== exactLaunch.effectivePrefix
      || exactObjectRead.encryptionMode !== exactLaunch.encryptionMode
      || exactObjectRead.kmsKeyArn !== exactLaunch.kmsKeyArn) {
      reject("CONTRACT_MATRIX_INVALID");
    }
    return {
      region,
      describeContractId: source[0]!.contractId,
      launchContractId: exactLaunch.contractId,
      objectReadContractId: exactObjectRead.contractId,
      bucket: exactLaunch.bucket,
      basePrefix: exactLaunch.basePrefix,
      effectivePrefix: exactLaunch.effectivePrefix,
    };
  });
  return parseComputeOptimizerMaterializationActivationManifest({
    schema: "sutra.compute-optimizer-materialization-activation-manifest-response.v1",
    requestId: request.requestId,
    tenantId: owner.tenantId,
    connectionId: owner.connectionId,
    accountId: owner.expectedAccountId,
    partition: owner.partition,
    permissionPackVersion: COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
    regions: rows,
  }, owner, request.requestId);
}
