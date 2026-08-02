/**
 * Exact-object STS session policies for AWS Compute Optimizer export reads.
 *
 * One policy is created for one address. This is intentional: AWS limits the
 * plaintext inline session policy passed to AssumeRole to 2,048 characters,
 * while a Compute Optimizer regional plan can contain sixteen long S3 keys.
 * The caller must assume a fresh short-lived session for every object read.
 */

import type {
  ComputeOptimizerExportPlan,
  VerifiedComputeOptimizerExportJobBinding,
} from "./finops-compute-optimizer-export-plan.ts";
import { verifyComputeOptimizerExportPlan } from "./finops-compute-optimizer-export-plan.ts";

const SHA256 = /^[a-f0-9]{64}$/u;
const PLAN_ID = /^cope_[a-f0-9]{64}$/u;
const REGION = /^[a-z]{2}(?:-gov)?-[a-z]+-\d$/u;
const ACCOUNT_ID = /^\d{12}$/u;
const BUCKET =
  /^(?!\d{1,3}(?:\.\d{1,3}){3}$)(?!.*\.\.)(?!.*\.-)(?!.*-\.)(?!xn--)(?!.*-s3alias$)(?!.*--ol-s3$)(?!.*\.mrap$)(?!.*--x-s3$)[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/u;
const VERSION_ID = /^[^\u0000-\u0020\u007f<>]{1,1024}$/u;
const MAX_KEY_BYTES = 1_024;
const MAX_ASSUME_ROLE_POLICY_CHARACTERS = 2_048;

export const COMPUTE_OPTIMIZER_EXPORT_SESSION_POLICY_BOUNDS = Object.freeze({
  maximumPlaintextCharacters: MAX_ASSUME_ROLE_POLICY_CHARACTERS,
  addressesPerSession: 1,
} as const);

export type ComputeOptimizerExportObjectReadIdentity =
  | Readonly<{ mode: "CURRENT"; versionId: null }>
  | Readonly<{ mode: "VERSION"; versionId: string }>;

export type ComputeOptimizerExportBucketEncryption =
  | Readonly<{
    schemaVersion: "sutra.compute-optimizer-export-bucket-encryption.v1";
    planId: string;
    planContentSha256: string;
    region: string;
    bucket: string;
    mode: "SSE_S3";
    kmsKeyArn: null;
    provisioningLedgerVerified: true;
  }>
  | Readonly<{
    schemaVersion: "sutra.compute-optimizer-export-bucket-encryption.v1";
    planId: string;
    planContentSha256: string;
    region: string;
    bucket: string;
    mode: "SSE_KMS";
    kmsKeyArn: string;
    provisioningLedgerVerified: true;
  }>;

export interface ComputeOptimizerExactObjectSessionPolicyRequest {
  readonly plan: ComputeOptimizerExportPlan;
  readonly binding: VerifiedComputeOptimizerExportJobBinding;
  readonly region: string;
  readonly bucket: string;
  readonly key: string;
  readonly readIdentity: ComputeOptimizerExportObjectReadIdentity;
  readonly encryption: ComputeOptimizerExportBucketEncryption;
}

export interface ComputeOptimizerExactObjectSessionPolicy {
  readonly schemaVersion: "sutra.compute-optimizer-export-object-session-policy.v1";
  readonly planId: string;
  readonly planContentSha256: string;
  readonly region: string;
  readonly bucket: string;
  readonly key: string;
  readonly readIdentity: ComputeOptimizerExportObjectReadIdentity;
  readonly objectArn: string;
  readonly policyDocument: Readonly<{
    Version: "2012-10-17";
    Statement: readonly Readonly<Record<string, unknown>>[];
  }>;
  readonly policyJson: string;
  readonly policySha256: string;
  readonly plaintextCharacters: number;
}

export class ComputeOptimizerExportSessionPolicyError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_INPUT"
      | "ADDRESS_NOT_PLANNED"
      | "ENCRYPTION_BINDING_MISMATCH"
      | "POLICY_SIZE_EXCEEDED",
  ) {
    super("Compute Optimizer export session policy rejected");
    this.name = "ComputeOptimizerExportSessionPolicyError";
  }
}

function reject(code: ComputeOptimizerExportSessionPolicyError["code"]): never {
  throw new ComputeOptimizerExportSessionPolicyError(code);
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

function validKey(value: unknown): value is string {
  if (
    typeof value !== "string"
    || value.length < 1
    || new TextEncoder().encode(value).byteLength > MAX_KEY_BYTES
    || value.startsWith("/")
    || value.includes("\\")
    || value.includes("%")
    || value.includes("\0")
  ) return false;
  return !value.split("/").some((part) => part.length === 0 || part === "." || part === "..");
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return value;
}

async function sha256(value: string): Promise<string> {
  const bytes = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)]
    .map((item) => item.toString(16).padStart(2, "0"))
    .join("");
}

function validateBinding(value: unknown): asserts value is VerifiedComputeOptimizerExportJobBinding {
  if (
    !isRecord(value)
    || !exactKeys(value, ["planId", "contentSha256", "targets"])
    || typeof value.planId !== "string"
    || !PLAN_ID.test(value.planId)
    || typeof value.contentSha256 !== "string"
    || !SHA256.test(value.contentSha256)
    || !Array.isArray(value.targets)
    || value.targets.length < 1
    || value.targets.length > 8
  ) reject("INVALID_INPUT");
}

function validateIdentity(value: unknown): asserts value is ComputeOptimizerExportObjectReadIdentity {
  if (!isRecord(value) || !exactKeys(value, ["mode", "versionId"])) reject("INVALID_INPUT");
  if (value.mode === "CURRENT" && value.versionId === null) return;
  if (value.mode === "VERSION" && typeof value.versionId === "string" && VERSION_ID.test(value.versionId)) {
    return;
  }
  reject("INVALID_INPUT");
}

function kmsKeyArnPattern(partition: ComputeOptimizerExportPlan["partition"], region: string): RegExp {
  return new RegExp(
    `^arn:${partition}:kms:${region}:([0-9]{12}):key/[A-Fa-f0-9-]{36}$`,
    "u",
  );
}

function validateEncryption(
  value: unknown,
  request: Pick<ComputeOptimizerExactObjectSessionPolicyRequest, "binding" | "plan" | "region" | "bucket">,
): asserts value is ComputeOptimizerExportBucketEncryption {
  if (
    !isRecord(value)
    || !exactKeys(value, [
      "schemaVersion",
      "planId",
      "planContentSha256",
      "region",
      "bucket",
      "mode",
      "kmsKeyArn",
      "provisioningLedgerVerified",
    ])
    || value.schemaVersion !== "sutra.compute-optimizer-export-bucket-encryption.v1"
    || value.planId !== request.binding.planId
    || value.planContentSha256 !== request.binding.contentSha256
    || value.region !== request.region
    || value.bucket !== request.bucket
    || value.provisioningLedgerVerified !== true
  ) reject("ENCRYPTION_BINDING_MISMATCH");
  if (value.mode === "SSE_S3" && value.kmsKeyArn === null) return;
  if (
    value.mode === "SSE_KMS"
    && typeof value.kmsKeyArn === "string"
    && kmsKeyArnPattern(request.plan.partition, request.region).test(value.kmsKeyArn)
    && ACCOUNT_ID.test(value.kmsKeyArn.split(":")[4] ?? "")
  ) return;
  reject("ENCRYPTION_BINDING_MISMATCH");
}

function exactPlannedAddress(
  plan: ComputeOptimizerExportPlan,
  binding: VerifiedComputeOptimizerExportJobBinding,
  region: string,
  bucket: string,
  key: string,
): boolean {
  if (binding.planId !== plan.planId || binding.contentSha256 !== plan.contentSha256) return false;
  const plannedTargets = plan.targets.map((target) => ({
    region: target.region,
    exportFamily: target.exportFamily,
    providerResourceType: target.expectedJob.providerResourceType,
    requestSha256: target.requestSha256,
    jobId: target.expectedJob.jobId,
    bucket: target.expectedJob.bucket,
    objectKey: target.expectedJob.objectKey,
    metadataKey: target.expectedJob.metadataKey,
  }));
  if (JSON.stringify(binding.targets) !== JSON.stringify(plannedTargets)) return false;
  let matches = 0;
  for (const target of binding.targets) {
    if (!isRecord(target)) reject("INVALID_INPUT");
    if (
      target.region === region
      && target.bucket === bucket
      && (target.objectKey === key || target.metadataKey === key)
    ) matches += 1;
  }
  return matches === 1;
}

function kmsViaService(partition: ComputeOptimizerExportPlan["partition"], region: string): string {
  // AWS KMS ViaService names deliberately use `.amazonaws.com` in every
  // partition, including aws-cn; this is not the service's network endpoint.
  void partition;
  return `s3.${region}.amazonaws.com`;
}

export async function createComputeOptimizerExactObjectSessionPolicy(
  request: ComputeOptimizerExactObjectSessionPolicyRequest,
): Promise<ComputeOptimizerExactObjectSessionPolicy> {
  if (
    !isRecord(request)
    || !exactKeys(request, [
      "plan",
      "binding",
      "region",
      "bucket",
      "key",
      "readIdentity",
      "encryption",
    ])
    || typeof request.region !== "string"
    || !REGION.test(request.region)
    || typeof request.bucket !== "string"
    || !BUCKET.test(request.bucket)
    || !validKey(request.key)
  ) reject("INVALID_INPUT");
  let plan: ComputeOptimizerExportPlan;
  try {
    plan = await verifyComputeOptimizerExportPlan(request.plan);
  } catch {
    reject("INVALID_INPUT");
  }
  validateBinding(request.binding);
  validateIdentity(request.readIdentity);
  if (!exactPlannedAddress(plan, request.binding, request.region, request.bucket, request.key)) {
    reject("ADDRESS_NOT_PLANNED");
  }
  validateEncryption(request.encryption, { ...request, plan });

  const objectArn = `arn:${plan.partition}:s3:::${request.bucket}/${request.key}`;
  const statements: Record<string, unknown>[] = [{
    Sid: "ReadOneComputeOptimizerExportObject",
    Effect: "Allow",
    Action: request.readIdentity.mode === "VERSION" ? "s3:GetObjectVersion" : "s3:GetObject",
    Resource: objectArn,
  }];
  if (request.encryption.mode === "SSE_KMS") {
    statements.push({
      Sid: "DecryptOneComputeOptimizerExportKey",
      Effect: "Allow",
      Action: ["kms:Decrypt", "kms:GenerateDataKey"],
      Resource: request.encryption.kmsKeyArn,
      Condition: {
        StringEquals: {
          "kms:ViaService": kmsViaService(plan.partition, request.region),
        },
      },
    });
  }
  const policyDocument = {
    Version: "2012-10-17" as const,
    Statement: statements,
  };
  const policyJson = JSON.stringify(policyDocument);
  if (policyJson.length > MAX_ASSUME_ROLE_POLICY_CHARACTERS) reject("POLICY_SIZE_EXCEEDED");

  return deepFreeze({
    schemaVersion: "sutra.compute-optimizer-export-object-session-policy.v1" as const,
    planId: request.binding.planId,
    planContentSha256: request.binding.contentSha256,
    region: request.region,
    bucket: request.bucket,
    key: request.key,
    readIdentity: { ...request.readIdentity },
    objectArn,
    policyDocument,
    policyJson,
    policySha256: await sha256(policyJson),
    plaintextCharacters: policyJson.length,
  });
}
