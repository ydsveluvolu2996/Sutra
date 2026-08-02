/**
 * Trusted control-plane provisioning for the regional Compute Optimizer .8.5
 * launch contract. The caller supplies identities only. CloudFormation outputs
 * are read by a collector-owned adapter, normalized with an exact allowlist,
 * and re-attested against the live IAM role before the encrypted registry may
 * stage the successor permission pack.
 */
import { createHash } from "node:crypto";

import {
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_CONTRACT_ID,
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
  COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_CONTRACT_ID,
  COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION,
  type AwsPartition,
  type ComputeOptimizerExportLaunchContract,
  type ComputeOptimizerExportObjectContract,
  type ComputeOptimizerExportLaunchProvisioningVerification,
  type ConnectionScope,
  type FinopsSourceContract,
  type PermissionPackVersion,
} from "./types.js";
import {
  AWS_ORGANIZATIONS_TAXONOMY_SOURCE_PERMISSION_CONTRACT_ID,
  AWS_ORGANIZATIONS_TAXONOMY_SOURCE_POLICY_NAME,
  COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID,
  COMPUTE_OPTIMIZER_EXPORT_SOURCE_POLICY_NAME,
  COST_ANOMALY_SOURCE_PERMISSION_CONTRACT_ID,
  COST_ANOMALY_SOURCE_POLICY_NAME,
  TRUSTED_ADVISOR_STANDARD_SOURCE_PERMISSION_CONTRACT_ID,
  TRUSTED_ADVISOR_STANDARD_SOURCE_POLICY_NAME,
  parseFinopsSourceContracts,
} from "./finops-source-contract.js";
import {
  parseComputeOptimizerExportLaunchContracts,
} from "./compute-optimizer-export-launch-contract.js";
import {
  parseComputeOptimizerExportObjectContracts,
} from "./compute-optimizer-export-object-contract.js";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@+-]{0,127}$/u;
const CONNECTION_ID = /^conn_[a-f0-9]{32}$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const SHA256 = /^[a-f0-9]{64}$/u;
const KMS_KEY_ID = /^[A-Za-z0-9-]{1,128}$/u;
const MAX_REGIONS = 50;
const REGIONAL_OUTPUT_READ_CONCURRENCY = 4;
export const MAX_COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PROVISIONING_DURATION_MS = 120_000;

export const COMPUTE_OPTIMIZER_BASE_ROLE_OUTPUT_KEYS = Object.freeze([
  "CustomerReadRoleArn",
  "PermissionPackVersion",
  "RequiredFoundationalFinopsAddOn",
  "RequiredComputeOptimizerExportReadAddOn",
  "RequiredComputeOptimizerExportLaunchAddOn",
] as const);

export const COMPUTE_OPTIMIZER_REGIONAL_OBJECT_READ_OUTPUT_KEYS = Object.freeze([
  "AttachedPolicyName",
  "CollectorRoleArn",
  "CollectorRoleName",
  "ContractVersion",
  "EffectivePrefix",
  "ExistingBucketName",
  "ExportBasePrefix",
  "ExportRegion",
  "KmsKeyArn",
  "KmsMode",
  "ObjectArnPrefix",
  "RequesterAccountId",
  "RequiredBasePermissionPackVersion",
  "StackPartition",
] as const);

export const COMPUTE_OPTIMIZER_REGIONAL_LAUNCH_OUTPUT_KEYS = Object.freeze([
  "AttachedPolicyName",
  "BucketPolicyLogicalId",
  "BucketVersioningStatus",
  "CollectorRoleArn",
  "CollectorRoleName",
  "ComputeOptimizerServicePrincipal",
  "ContractVersion",
  "EffectivePrefix",
  "EncryptionMode",
  "ExportBasePrefix",
  "ExportBucketArn",
  "ExportBucketName",
  "ExportRegion",
  "KmsKeyArn",
  "ObjectArnPrefix",
  "RequesterAccountId",
  "RequiredBasePermissionPackVersion",
  "StackPartition",
] as const);

export type ComputeOptimizerProvisioningOutputs = Readonly<Record<string, string>>;

export interface ComputeOptimizerExportLaunchProvisioningCandidate {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly expectedAccountId: string;
  readonly partition: AwsPartition;
  readonly roleArn: string;
  readonly status: string;
  readonly permissionPackVersion: PermissionPackVersion;
  readonly enabledRegions: readonly string[];
  readonly finopsSourceContracts?: readonly FinopsSourceContract[];
}

export interface ComputeOptimizerExportLaunchProvisioningOutputReader {
  readBaseRoleOutputs(input: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly accountId: string;
    readonly partition: AwsPartition;
    readonly roleArn: string;
    readonly signal: AbortSignal;
  }): Promise<ComputeOptimizerProvisioningOutputs>;
  readRegionalLaunchOutputs(input: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly accountId: string;
    readonly partition: AwsPartition;
    readonly roleArn: string;
    readonly region: string;
    readonly signal: AbortSignal;
  }): Promise<ComputeOptimizerProvisioningOutputs>;
  readRegionalObjectReadOutputs(input: {
    readonly tenantId: string;
    readonly connectionId: string;
    readonly accountId: string;
    readonly partition: AwsPartition;
    readonly roleArn: string;
    readonly region: string;
    readonly signal: AbortSignal;
  }): Promise<ComputeOptimizerProvisioningOutputs>;
}

export interface ComputeOptimizerExportLaunchProvisioningRoleAttestor {
  attest(input: {
    readonly scope: ConnectionScope;
    readonly connectionId: string;
    readonly operationId: string;
    readonly sourceContracts: readonly FinopsSourceContract[];
    readonly objectContracts: readonly ComputeOptimizerExportObjectContract[];
    readonly launchContracts: readonly ComputeOptimizerExportLaunchContract[];
    readonly signal: AbortSignal;
  }): Promise<{
    readonly identityAttested: true;
    readonly permissionPolicyAttested: true;
    readonly launchPoliciesAttested: true;
  }>;
}

export function createComputeOptimizerExportLaunchProvisioningRoleAttestor(
  broker: {
    attestComputeOptimizerExportLaunchProvisioning(
      scope: ConnectionScope,
      connectionId: string,
      operationId: string,
      input: {
        readonly sourceContracts: readonly FinopsSourceContract[];
        readonly objectContracts: readonly ComputeOptimizerExportObjectContract[];
        readonly launchContracts: readonly ComputeOptimizerExportLaunchContract[];
        readonly signal: AbortSignal;
      },
    ): Promise<{
      readonly identityAttested: true;
      readonly permissionPolicyAttested: true;
      readonly launchPoliciesAttested: true;
    }>;
  },
): ComputeOptimizerExportLaunchProvisioningRoleAttestor {
  return {
    attest: (input) => broker.attestComputeOptimizerExportLaunchProvisioning(
      input.scope,
      input.connectionId,
      input.operationId,
      {
        sourceContracts: input.sourceContracts,
        objectContracts: input.objectContracts,
        launchContracts: input.launchContracts,
        signal: input.signal,
      },
    ),
  };
}

export interface ComputeOptimizerExportLaunchProvisioningRegistry {
  getRegistered(
    scope: ConnectionScope,
    connectionId: string,
    signal?: AbortSignal,
  ): Promise<ComputeOptimizerExportLaunchProvisioningCandidate | null>;
  markComputeOptimizerExportLaunchProvisioningVerified(
    scope: ConnectionScope,
    connectionId: string,
    verification: ComputeOptimizerExportLaunchProvisioningVerification,
    signal?: AbortSignal,
  ): Promise<void>;
}

export class ComputeOptimizerExportLaunchProvisioningError extends Error {
  public constructor(public readonly code:
    | "INVALID_INPUT"
    | "CONNECTION_NOT_ELIGIBLE"
    | "OUTPUTS_INVALID"
    | "ATTESTATION_FAILED"
    | "ABORTED"
    | "DEADLINE_EXCEEDED") {
    super("Compute Optimizer export launch provisioning rejected");
    this.name = "ComputeOptimizerExportLaunchProvisioningError";
  }
}

function reject(code: ComputeOptimizerExportLaunchProvisioningError["code"]): never {
  throw new ComputeOptimizerExportLaunchProvisioningError(code);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ProvisioningBoundary {
  readonly signal: AbortSignal;
  wait<T>(operation: () => Promise<T>): Promise<T>;
  close(): void;
}

function createProvisioningBoundary(
  deadlineAtMs: number,
  parentSignal: AbortSignal | undefined,
): ProvisioningBoundary {
  const controller = new AbortController();
  let terminalCode: "ABORTED" | "DEADLINE_EXCEEDED" | null = null;
  let rejectTerminal!: (reason: ComputeOptimizerExportLaunchProvisioningError) => void;
  const terminal = new Promise<never>((_resolve, rejectPromise) => {
    rejectTerminal = rejectPromise;
  });
  // The deadline may fire while bounded synchronous contract derivation is in
  // progress, before the next race is attached. Mark this internal signal as
  // handled without changing what each explicit wait observes.
  void terminal.catch(() => {});
  const finish = (code: "ABORTED" | "DEADLINE_EXCEEDED") => {
    if (terminalCode !== null) return;
    terminalCode = code;
    controller.abort();
    rejectTerminal(new ComputeOptimizerExportLaunchProvisioningError(code));
  };
  const onParentAbort = () => finish("ABORTED");
  parentSignal?.addEventListener("abort", onParentAbort, { once: true });
  const timer = setTimeout(
    () => finish("DEADLINE_EXCEEDED"),
    Math.max(0, deadlineAtMs - Date.now()),
  );
  if (parentSignal?.aborted === true) finish("ABORTED");
  return {
    signal: controller.signal,
    wait: <T>(operation: () => Promise<T>) => {
      if (terminalCode !== null) {
        return Promise.reject(
          new ComputeOptimizerExportLaunchProvisioningError(terminalCode),
        );
      }
      let promise: Promise<T>;
      try {
        promise = operation();
      } catch (error) {
        return Promise.reject(error);
      }
      return Promise.race([promise, terminal]);
    },
    close: () => {
      clearTimeout(timer);
      parentSignal?.removeEventListener("abort", onParentAbort);
    },
  };
}

function exactOutputKeys(
  value: unknown,
  expected: readonly string[],
): ComputeOptimizerProvisioningOutputs {
  if (!isRecord(value)) reject("OUTPUTS_INVALID");
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length
    || actual.some((key, index) => key !== wanted[index])
    || Object.values(value).some((entry) => typeof entry !== "string")) {
    reject("OUTPUTS_INVALID");
  }
  return value as ComputeOptimizerProvisioningOutputs;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function sortedUniqueRegions(value: unknown, partition: AwsPartition): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_REGIONS
    || value.some((region) => typeof region !== "string" || !REGION.test(region))) {
    reject("INVALID_INPUT");
  }
  const regions = [...value].sort() as string[];
  if (new Set(regions).size !== regions.length) reject("INVALID_INPUT");
  for (const region of regions) {
    if ((partition === "aws-cn") !== region.startsWith("cn-")
      || (partition === "aws-us-gov") !== region.startsWith("us-gov-")
      || (partition === "aws"
        && (region.startsWith("cn-") || region.startsWith("us-gov-")))) {
      reject("INVALID_INPUT");
    }
  }
  return regions;
}

function canonicalOutputs(outputs: ComputeOptimizerProvisioningOutputs): string {
  return JSON.stringify(Object.fromEntries(
    Object.entries(outputs).sort(([left], [right]) => left.localeCompare(right)),
  ));
}

function contractId(
  kind: "source" | "object" | "launch",
  candidate: ComputeOptimizerExportLaunchProvisioningCandidate,
  region: string,
  outputs: ComputeOptimizerProvisioningOutputs,
): string {
  return `co-${kind}-${region}-${sha256(JSON.stringify({
    tenantId: candidate.tenantId,
    connectionId: candidate.connectionId,
    accountId: candidate.expectedAccountId,
    partition: candidate.partition,
    region,
    outputs: JSON.parse(canonicalOutputs(outputs)) as unknown,
  })).slice(0, 24)}`;
}

function singletonSourceContractId(
  sourceId: string,
  candidate: ComputeOptimizerExportLaunchProvisioningCandidate,
  outputs: ComputeOptimizerProvisioningOutputs,
): string {
  return `co-source-${sourceId}-${sha256(JSON.stringify({
    tenantId: candidate.tenantId,
    connectionId: candidate.connectionId,
    accountId: candidate.expectedAccountId,
    partition: candidate.partition,
    outputs: JSON.parse(canonicalOutputs(outputs)) as unknown,
  })).slice(0, 24)}`;
}

function parseBaseOutputs(
  value: unknown,
  candidate: ComputeOptimizerExportLaunchProvisioningCandidate,
): ComputeOptimizerProvisioningOutputs {
  const outputs = exactOutputKeys(value, COMPUTE_OPTIMIZER_BASE_ROLE_OUTPUT_KEYS);
  if (outputs.CustomerReadRoleArn !== candidate.roleArn
    || outputs.PermissionPackVersion
      !== COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION
    || outputs.RequiredFoundationalFinopsAddOn !== "foundational-cur2-export-v1"
    || outputs.RequiredComputeOptimizerExportReadAddOn
      !== COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_CONTRACT_ID
    || outputs.RequiredComputeOptimizerExportLaunchAddOn
      !== COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_CONTRACT_ID) {
    reject("OUTPUTS_INVALID");
  }
  return outputs;
}

function parseRegionalObjectReadOutputs(
  value: unknown,
  candidate: ComputeOptimizerExportLaunchProvisioningCandidate,
  region: string,
): ComputeOptimizerProvisioningOutputs {
  const outputs = exactOutputKeys(value, COMPUTE_OPTIMIZER_REGIONAL_OBJECT_READ_OUTPUT_KEYS);
  const expectedRoleName = candidate.roleArn.slice(candidate.roleArn.lastIndexOf("/") + 1);
  const expectedKeyPrefix =
    `arn:${candidate.partition}:kms:${region}:${candidate.expectedAccountId}:key/`;
  if (outputs.ContractVersion !== COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_CONTRACT_ID
    || outputs.RequiredBasePermissionPackVersion
      !== COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION
    || outputs.CollectorRoleArn !== candidate.roleArn
    || outputs.CollectorRoleName !== expectedRoleName
    || outputs.StackPartition !== candidate.partition
    || outputs.RequesterAccountId !== candidate.expectedAccountId
    || outputs.ExportRegion !== region
    || outputs.EffectivePrefix
      !== `${outputs.ExportBasePrefix}compute-optimizer/${candidate.expectedAccountId}/`
    || outputs.ObjectArnPrefix
      !== `arn:${candidate.partition}:s3:::${outputs.ExistingBucketName}/${outputs.EffectivePrefix}*`
    || outputs.KmsMode !== "SSE_KMS"
    || typeof outputs.KmsKeyArn !== "string"
    || !outputs.KmsKeyArn.startsWith(expectedKeyPrefix)
    || !KMS_KEY_ID.test(outputs.KmsKeyArn.slice(expectedKeyPrefix.length))
    || outputs.AttachedPolicyName
      !== `SutraComputeOptimizerExportReadV1-${region}-${outputs.ExistingBucketName}`) {
    reject("OUTPUTS_INVALID");
  }
  return outputs;
}

function parseRegionalOutputs(
  value: unknown,
  candidate: ComputeOptimizerExportLaunchProvisioningCandidate,
  region: string,
): ComputeOptimizerProvisioningOutputs {
  const outputs = exactOutputKeys(value, COMPUTE_OPTIMIZER_REGIONAL_LAUNCH_OUTPUT_KEYS);
  const expectedRoleName = candidate.roleArn.slice(candidate.roleArn.lastIndexOf("/") + 1);
  if (outputs.ContractVersion !== COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_CONTRACT_ID
    || outputs.RequiredBasePermissionPackVersion
      !== COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION
    || outputs.CollectorRoleArn !== candidate.roleArn
    || outputs.CollectorRoleName !== expectedRoleName
    || outputs.StackPartition !== candidate.partition
    || outputs.RequesterAccountId !== candidate.expectedAccountId
    || outputs.ExportRegion !== region
    || outputs.ExportBucketArn
      !== `arn:${candidate.partition}:s3:::${outputs.ExportBucketName}`
    || outputs.EffectivePrefix
      !== `${outputs.ExportBasePrefix}compute-optimizer/${candidate.expectedAccountId}/`
    || outputs.ObjectArnPrefix
      !== `${outputs.ExportBucketArn}/${outputs.EffectivePrefix}*`
    || outputs.EncryptionMode !== "SSE_KMS"
    || outputs.KmsKeyArn
      !== `arn:${candidate.partition}:kms:${region}:${candidate.expectedAccountId}:key/${outputs.KmsKeyArn?.split("/").at(-1) ?? ""}`
    || !KMS_KEY_ID.test(outputs.KmsKeyArn.split("/").at(-1) ?? "")
    || outputs.BucketVersioningStatus !== "Enabled"
    || outputs.ComputeOptimizerServicePrincipal !== "compute-optimizer.amazonaws.com"
    || outputs.AttachedPolicyName !== `SutraComputeOptimizerExportLaunchV1-${region}`
    || outputs.BucketPolicyLogicalId !== "ComputeOptimizerExportBucketPolicy") {
    reject("OUTPUTS_INVALID");
  }
  return outputs;
}

function candidateOwner(candidate: ComputeOptimizerExportLaunchProvisioningCandidate) {
  return {
    tenantId: candidate.tenantId,
    connectionId: candidate.connectionId,
    expectedAccountId: candidate.expectedAccountId,
    partition: candidate.partition,
  } as const;
}

function validCandidate(
  candidate: ComputeOptimizerExportLaunchProvisioningCandidate | null,
  scope: ConnectionScope,
  connectionId: string,
): asserts candidate is ComputeOptimizerExportLaunchProvisioningCandidate {
  if (candidate === null
    || candidate.tenantId !== scope.tenantId
    || candidate.connectionId !== connectionId
    || !ACCOUNT_ID.test(candidate.expectedAccountId)
    || !IDENTIFIER.test(candidate.tenantId)
    || !CONNECTION_ID.test(candidate.connectionId)
    || candidate.status !== "ACTIVE"
    || ![
      "standard-2026-07.4",
      "standard-2026-08.1",
      "standard-2026-08.2",
      "standard-2026-08.3",
      "standard-2026-08.4",
      "standard-2026-08.5",
    ].includes(candidate.permissionPackVersion)) {
    reject("CONNECTION_NOT_ELIGIBLE");
  }
}

/** Strict validation repeated by both encrypted registry implementations. */
export function validateComputeOptimizerExportLaunchProvisioningVerification(
  value: unknown,
  candidate: ComputeOptimizerExportLaunchProvisioningCandidate,
): ComputeOptimizerExportLaunchProvisioningVerification {
  if (!isRecord(value)) reject("INVALID_INPUT");
  const keys = Object.keys(value).sort();
  const expected = [
    "schemaVersion", "connectionId", "accountId", "partition", "roleArn",
    "permissionPackVersion", "enabledRegions", "sourceContracts", "objectContracts",
    "launchContracts",
    "baseRoleOutputsSha256", "regionalObjectReadOutputsSha256",
    "regionalLaunchOutputsSha256", "identityAttested",
    "permissionPolicyAttested", "launchPoliciesAttested", "stackOutputsAttested",
  ].sort();
  if (keys.length !== expected.length
    || keys.some((key, index) => key !== expected[index])
    || value.schemaVersion
      !== "sutra.compute-optimizer-export-launch-provisioning-verification.v1"
    || value.connectionId !== candidate.connectionId
    || value.accountId !== candidate.expectedAccountId
    || value.partition !== candidate.partition
    || value.roleArn !== candidate.roleArn
    || value.permissionPackVersion
      !== COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION
    || value.identityAttested !== true
    || value.permissionPolicyAttested !== true
    || value.launchPoliciesAttested !== true
    || value.stackOutputsAttested !== true
    || typeof value.baseRoleOutputsSha256 !== "string"
    || !SHA256.test(value.baseRoleOutputsSha256)
    || typeof value.regionalObjectReadOutputsSha256 !== "string"
    || !SHA256.test(value.regionalObjectReadOutputsSha256)
    || typeof value.regionalLaunchOutputsSha256 !== "string"
    || !SHA256.test(value.regionalLaunchOutputsSha256)) {
    reject("INVALID_INPUT");
  }
  const contractSet = validateComputeOptimizerExportLaunchProvisioningContractSet(
    candidate,
    value.enabledRegions,
    value.sourceContracts,
    value.objectContracts,
    value.launchContracts,
  );
  return structuredClone({
    ...value,
    enabledRegions: contractSet.enabledRegions,
    sourceContracts: contractSet.sourceContracts,
    objectContracts: contractSet.objectContracts,
    launchContracts: contractSet.launchContracts,
  }) as ComputeOptimizerExportLaunchProvisioningVerification;
}

/** Revalidate the stored regional set at the separate activation edge. */
export function validateComputeOptimizerExportLaunchProvisioningContractSet(
  candidate: ComputeOptimizerExportLaunchProvisioningCandidate,
  unsafeEnabledRegions: unknown,
  unsafeSourceContracts: unknown,
  unsafeObjectContracts: unknown,
  unsafeLaunchContracts: unknown,
): {
  readonly enabledRegions: readonly string[];
  readonly sourceContracts: readonly FinopsSourceContract[];
  readonly objectContracts: readonly ComputeOptimizerExportObjectContract[];
  readonly launchContracts: readonly ComputeOptimizerExportLaunchContract[];
} {
  const enabledRegions = sortedUniqueRegions(unsafeEnabledRegions, candidate.partition);
  const expectedRegions = sortedUniqueRegions(candidate.enabledRegions, candidate.partition);
  if (JSON.stringify(enabledRegions) !== JSON.stringify(expectedRegions)) reject("INVALID_INPUT");
  let sources: readonly FinopsSourceContract[];
  let objects: readonly ComputeOptimizerExportObjectContract[];
  let launches: readonly ComputeOptimizerExportLaunchContract[];
  try {
    sources = parseFinopsSourceContracts(unsafeSourceContracts, candidateOwner(candidate));
    objects = parseComputeOptimizerExportObjectContracts(
      unsafeObjectContracts,
      candidateOwner(candidate),
    );
    launches = parseComputeOptimizerExportLaunchContracts(
      unsafeLaunchContracts,
      candidateOwner(candidate),
    );
  } catch {
    return reject("INVALID_INPUT");
  }
  const computeOptimizerSources = sources.filter(({ sourceId }) =>
    sourceId === "compute_optimizer_organization_export");
  if (computeOptimizerSources.length !== enabledRegions.length
    || objects.length !== enabledRegions.length
    || launches.length !== enabledRegions.length
    || computeOptimizerSources.some((contract) =>
      contract.permissionContractId
        !== COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID
      || contract.policyName !== COMPUTE_OPTIMIZER_EXPORT_SOURCE_POLICY_NAME)
    || JSON.stringify(computeOptimizerSources.map(({ region }) => region).sort())
      !== JSON.stringify(enabledRegions)
    || JSON.stringify(objects.map(({ region }) => region).sort())
      !== JSON.stringify(enabledRegions)
    || JSON.stringify(launches.map(({ region }) => region).sort())
      !== JSON.stringify(enabledRegions)
    || objects.some((objectContract) => {
      const launchContract = launches.find(({ region }) => region === objectContract.region);
      return launchContract === undefined
        || objectContract.bucket !== launchContract.bucket
        || objectContract.effectivePrefix !== launchContract.effectivePrefix
        || objectContract.encryptionMode !== "SSE_KMS"
        || objectContract.kmsKeyArn !== launchContract.kmsKeyArn;
    })) {
    reject("INVALID_INPUT");
  }
  return {
    enabledRegions,
    sourceContracts: sources,
    objectContracts: objects,
    launchContracts: launches,
  };
}

/**
 * Reads, derives, live-attests and stages .8.5. Calling this function does not
 * activate the connection; activation is a separate exact-role registry call.
 */
export async function stageComputeOptimizerExportLaunchProvisioning(
  input: {
    readonly scope: ConnectionScope;
    readonly connectionId: string;
    readonly operationId: string;
    readonly deadlineAtMs: number;
    readonly signal?: AbortSignal;
  },
  dependencies: {
    readonly registry: ComputeOptimizerExportLaunchProvisioningRegistry;
    readonly outputs: ComputeOptimizerExportLaunchProvisioningOutputReader;
    readonly attestor: ComputeOptimizerExportLaunchProvisioningRoleAttestor;
  },
): Promise<ComputeOptimizerExportLaunchProvisioningVerification> {
  const nowMs = Date.now();
  const inputKeys = isRecord(input) ? Object.keys(input).sort() : [];
  const expectedInputKeys = ["connectionId", "deadlineAtMs", "operationId", "scope"];
  const expectedInputKeysWithSignal = [...expectedInputKeys, "signal"].sort();
  if (!isRecord(input)
    || (inputKeys.join("\0") !== expectedInputKeys.sort().join("\0")
      && inputKeys.join("\0") !== expectedInputKeysWithSignal.join("\0"))
    || !isRecord(input.scope) || Object.keys(input.scope).length !== 1
    || typeof input.scope.tenantId !== "string" || !IDENTIFIER.test(input.scope.tenantId)
    || typeof input.connectionId !== "string" || !CONNECTION_ID.test(input.connectionId)
    || typeof input.operationId !== "string" || !IDENTIFIER.test(input.operationId)
    || !Number.isSafeInteger(input.deadlineAtMs)
    || input.deadlineAtMs <= nowMs
    || input.deadlineAtMs > nowMs
      + MAX_COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PROVISIONING_DURATION_MS
    || (Object.hasOwn(input, "signal") && !(input.signal instanceof AbortSignal))) {
    reject("INVALID_INPUT");
  }
  const boundary = createProvisioningBoundary(input.deadlineAtMs, input.signal);
  try {
  const candidate = await boundary.wait(() => dependencies.registry.getRegistered(
    input.scope, input.connectionId, boundary.signal,
  ));
  validCandidate(candidate, input.scope, input.connectionId);
  const regions = sortedUniqueRegions(candidate.enabledRegions, candidate.partition);
  // The current compiled singleton-source contracts deliberately bind Cost
  // Explorer, Support and Organizations to commercial us-east-1. Refuse to
  // invent a GovCloud/China endpoint until those source adapters publish an
  // independently reviewed partition contract.
  if (candidate.partition !== "aws") reject("CONNECTION_NOT_ELIGIBLE");
  let baseOutputs: ComputeOptimizerProvisioningOutputs;
  const regionalObjectReadOutputs:
    Array<readonly [string, ComputeOptimizerProvisioningOutputs]> = [];
  const regionalLaunchOutputs:
    Array<readonly [string, ComputeOptimizerProvisioningOutputs]> = [];
  try {
    baseOutputs = parseBaseOutputs(await boundary.wait(() =>
      dependencies.outputs.readBaseRoleOutputs({
      tenantId: candidate.tenantId,
      connectionId: candidate.connectionId,
      accountId: candidate.expectedAccountId,
      partition: candidate.partition,
      roleArn: candidate.roleArn,
      signal: boundary.signal,
    })), candidate);
    for (let offset = 0; offset < regions.length;
      offset += REGIONAL_OUTPUT_READ_CONCURRENCY) {
      const batch = regions.slice(offset, offset + REGIONAL_OUTPUT_READ_CONCURRENCY);
      const settled = await boundary.wait(() => Promise.allSettled(batch.map(
        async (region) => {
          const common = {
            tenantId: candidate.tenantId,
            connectionId: candidate.connectionId,
            accountId: candidate.expectedAccountId,
            partition: candidate.partition,
            roleArn: candidate.roleArn,
            region,
            signal: boundary.signal,
          } as const;
          const launchOutputs = parseRegionalOutputs(
            await boundary.wait(() =>
              dependencies.outputs.readRegionalLaunchOutputs(common)),
            candidate,
            region,
          );
          const objectReadOutputs = parseRegionalObjectReadOutputs(
            await boundary.wait(() =>
              dependencies.outputs.readRegionalObjectReadOutputs(common)),
            candidate,
            region,
          );
          if (objectReadOutputs.ExistingBucketName !== launchOutputs.ExportBucketName
            || objectReadOutputs.ExportBasePrefix !== launchOutputs.ExportBasePrefix
            || objectReadOutputs.EffectivePrefix !== launchOutputs.EffectivePrefix
            || objectReadOutputs.ObjectArnPrefix !== launchOutputs.ObjectArnPrefix
            || objectReadOutputs.KmsMode !== launchOutputs.EncryptionMode
            || objectReadOutputs.KmsKeyArn !== launchOutputs.KmsKeyArn) {
            reject("OUTPUTS_INVALID");
          }
          return { region, launchOutputs, objectReadOutputs };
        },
      )));
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      for (const result of settled) {
        if (result.status !== "fulfilled") reject("OUTPUTS_INVALID");
        regionalObjectReadOutputs.push([result.value.region, result.value.objectReadOutputs]);
        regionalLaunchOutputs.push([result.value.region, result.value.launchOutputs]);
      }
    }
  } catch (error) {
    if (error instanceof ComputeOptimizerExportLaunchProvisioningError) throw error;
    return reject("OUTPUTS_INVALID");
  }
  let retainedSourceContracts: readonly FinopsSourceContract[] = [];
  try {
    retainedSourceContracts = candidate.finopsSourceContracts === undefined
      ? []
      : parseFinopsSourceContracts(
          candidate.finopsSourceContracts,
          candidateOwner(candidate),
        ).filter(({ sourceId }) =>
          sourceId !== "compute_optimizer_organization_export");
  } catch {
    return reject("CONNECTION_NOT_ELIGIBLE");
  }
  const sourceContracts: FinopsSourceContract[] = [...retainedSourceContracts];
  const singletonDefinitions = [
    {
      sourceId: "cost_anomaly_detection",
      permissionContractId: COST_ANOMALY_SOURCE_PERMISSION_CONTRACT_ID,
      policyName: COST_ANOMALY_SOURCE_POLICY_NAME,
    },
    {
      sourceId: "trusted_advisor_standard_checks",
      permissionContractId: TRUSTED_ADVISOR_STANDARD_SOURCE_PERMISSION_CONTRACT_ID,
      policyName: TRUSTED_ADVISOR_STANDARD_SOURCE_POLICY_NAME,
    },
    {
      sourceId: "aws_organizations_taxonomy",
      permissionContractId: AWS_ORGANIZATIONS_TAXONOMY_SOURCE_PERMISSION_CONTRACT_ID,
      policyName: AWS_ORGANIZATIONS_TAXONOMY_SOURCE_POLICY_NAME,
    },
  ] as const;
  for (const definition of singletonDefinitions) {
    if (sourceContracts.some(({ sourceId }) => sourceId === definition.sourceId)) continue;
    sourceContracts.push({
      tenantId: candidate.tenantId,
      connectionId: candidate.connectionId,
      contractId: singletonSourceContractId(
        definition.sourceId,
        candidate,
        baseOutputs,
      ),
      sourceId: definition.sourceId,
      accountId: candidate.expectedAccountId,
      partition: candidate.partition,
      region: "us-east-1",
      permissionContractId: definition.permissionContractId,
      policyName: definition.policyName,
    });
  }
  const objectContracts: ComputeOptimizerExportObjectContract[] = [];
  const launchContracts: ComputeOptimizerExportLaunchContract[] = [];
  for (const [index, [region, outputs]] of regionalLaunchOutputs.entries()) {
    const readOutputs = regionalObjectReadOutputs[index]?.[1];
    if (readOutputs === undefined) reject("OUTPUTS_INVALID");
    sourceContracts.push({
      tenantId: candidate.tenantId,
      connectionId: candidate.connectionId,
      contractId: contractId("source", candidate, region, outputs),
      sourceId: "compute_optimizer_organization_export",
      accountId: candidate.expectedAccountId,
      partition: candidate.partition,
      region,
      permissionContractId: COMPUTE_OPTIMIZER_EXPORT_SOURCE_PERMISSION_CONTRACT_ID,
      policyName: COMPUTE_OPTIMIZER_EXPORT_SOURCE_POLICY_NAME,
    });
    objectContracts.push({
      tenantId: candidate.tenantId,
      connectionId: candidate.connectionId,
      accountId: candidate.expectedAccountId,
      partition: candidate.partition,
      region,
      contractId: contractId("object", candidate, region, readOutputs),
      permissionPackVersion: COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_PACK_VERSION,
      permissionContractId: COMPUTE_OPTIMIZER_EXPORT_OBJECT_PERMISSION_CONTRACT_ID,
      policyName: readOutputs.AttachedPolicyName!,
      bucket: readOutputs.ExistingBucketName!,
      effectivePrefix: readOutputs.EffectivePrefix!,
      encryptionMode: "SSE_KMS",
      kmsKeyArn: readOutputs.KmsKeyArn!,
    });
    launchContracts.push({
      tenantId: candidate.tenantId,
      connectionId: candidate.connectionId,
      accountId: candidate.expectedAccountId,
      partition: candidate.partition,
      region,
      contractId: contractId("launch", candidate, region, outputs),
      permissionPackVersion: COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
      permissionContractId: COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_CONTRACT_ID,
      policyName: outputs.AttachedPolicyName!,
      bucket: outputs.ExportBucketName!,
      bucketArn: outputs.ExportBucketArn!,
      basePrefix: outputs.ExportBasePrefix!,
      effectivePrefix: outputs.EffectivePrefix!,
      objectArnPrefix: outputs.ObjectArnPrefix!,
      encryptionMode: "SSE_KMS",
      kmsKeyArn: outputs.KmsKeyArn!,
      bucketVersioningStatus: "Enabled",
      servicePrincipal: "compute-optimizer.amazonaws.com",
    });
  }
  let attestation: Awaited<ReturnType<
    ComputeOptimizerExportLaunchProvisioningRoleAttestor["attest"]
  >>;
  try {
    attestation = await boundary.wait(() => dependencies.attestor.attest({
      scope: input.scope,
      connectionId: input.connectionId,
      operationId: input.operationId,
      sourceContracts: parseFinopsSourceContracts(sourceContracts, candidateOwner(candidate)),
      objectContracts: parseComputeOptimizerExportObjectContracts(
        objectContracts,
        candidateOwner(candidate),
      ),
      launchContracts: parseComputeOptimizerExportLaunchContracts(
        launchContracts,
        candidateOwner(candidate),
      ),
      signal: boundary.signal,
    }));
  } catch (error) {
    if (error instanceof ComputeOptimizerExportLaunchProvisioningError) throw error;
    return reject("ATTESTATION_FAILED");
  }
  const verification = validateComputeOptimizerExportLaunchProvisioningVerification({
    schemaVersion:
      "sutra.compute-optimizer-export-launch-provisioning-verification.v1",
    connectionId: candidate.connectionId,
    accountId: candidate.expectedAccountId,
    partition: candidate.partition,
    roleArn: candidate.roleArn,
    permissionPackVersion: COMPUTE_OPTIMIZER_EXPORT_LAUNCH_PERMISSION_PACK_VERSION,
    enabledRegions: regions,
    sourceContracts,
    objectContracts,
    launchContracts,
    baseRoleOutputsSha256: sha256(canonicalOutputs(baseOutputs)),
    regionalObjectReadOutputsSha256: sha256(JSON.stringify(
      regionalObjectReadOutputs.map(([region, outputs]) => ({
        region,
        outputs: JSON.parse(canonicalOutputs(outputs)) as unknown,
      })),
    )),
    regionalLaunchOutputsSha256: sha256(JSON.stringify(
      regionalLaunchOutputs.map(([region, outputs]) => ({
        region,
        outputs: JSON.parse(canonicalOutputs(outputs)) as unknown,
      })),
    )),
    ...attestation,
    stackOutputsAttested: true,
  }, candidate);
  await boundary.wait(() =>
    dependencies.registry.markComputeOptimizerExportLaunchProvisioningVerified(
    input.scope,
    input.connectionId,
    verification,
    boundary.signal,
    ));
  return verification;
  } finally {
    boundary.close();
  }
}
