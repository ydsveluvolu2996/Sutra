import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPUTE_OPTIMIZER_EXPORT_SESSION_POLICY_BOUNDS,
  ComputeOptimizerExportSessionPolicyError,
  createComputeOptimizerExactObjectSessionPolicy,
  type ComputeOptimizerExportBucketEncryption,
} from "../lib/finops-compute-optimizer-export-iam.ts";
import { COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG } from "../lib/finops-compute-optimizer-export-field-catalog.ts";
import {
  createComputeOptimizerExportPlan,
  verifyCompletedComputeOptimizerExportJobs,
  type ComputeOptimizerExportPlan,
  type VerifiedComputeOptimizerExportJobBinding,
} from "../lib/finops-compute-optimizer-export-plan.ts";

const KEY = "exports/compute-optimizer/111122223333/us-east-1-2026-08-02T000000-job-a.csv";
const METADATA = KEY.slice(0, -4) + "-metadata.json";
async function fixture(
  partition: ComputeOptimizerExportPlan["partition"] = "aws",
  region = "us-east-1",
): Promise<{ plan: ComputeOptimizerExportPlan; binding: VerifiedComputeOptimizerExportJobBinding }> {
  const objectKey = KEY.replace("us-east-1-", `${region}-`);
  const metadataKey = objectKey.slice(0, -4) + "-metadata.json";
  const plan = await createComputeOptimizerExportPlan({
    scope: {
      orgId: "org_alpha",
      customerId: "customer_alpha",
      connectionId: `conn_${"a".repeat(32)}`,
    },
    requesterAccountId: "111122223333",
    partition,
    regions: [region],
    exportFamilies: ["EC2_INSTANCE"],
    targets: [{
      region,
      exportFamily: "EC2_INSTANCE",
      bucket: "sutra-co-us-east-1",
      optionalPrefix: "exports",
      effectivePrefix: "exports/compute-optimizer/111122223333/",
      request: {
        operation: "ExportEC2InstanceRecommendations",
        region,
        fileFormat: "Csv",
        includeMemberAccounts: true,
        filters: [],
        fieldsToExport: COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.EC2_INSTANCE.minimumProjection,
        s3DestinationConfig: { bucket: "sutra-co-us-east-1", keyPrefix: "exports" },
      },
      expectedJob: {
        jobId: "job-a",
        providerResourceType: "Ec2Instance",
        bucket: "sutra-co-us-east-1",
        objectKey,
        metadataKey,
      },
    }],
  });
  return {
    plan,
    binding: verifyCompletedComputeOptimizerExportJobs(plan, [{
      jobId: "job-a",
      region,
      providerResourceType: "Ec2Instance",
      status: "COMPLETE",
      bucket: "sutra-co-us-east-1",
      objectKey,
      metadataKey,
    }]),
  };
}

function encryption(
  binding: VerifiedComputeOptimizerExportJobBinding,
  region = "us-east-1",
  overrides: Partial<ComputeOptimizerExportBucketEncryption> = {},
): ComputeOptimizerExportBucketEncryption {
  return {
    schemaVersion: "sutra.compute-optimizer-export-bucket-encryption.v1",
    planId: binding.planId,
    planContentSha256: binding.contentSha256,
    region,
    bucket: "sutra-co-us-east-1",
    mode: "SSE_S3",
    kmsKeyArn: null,
    provisioningLedgerVerified: true,
    ...overrides,
  } as ComputeOptimizerExportBucketEncryption;
}

async function rejects(
  request: Parameters<typeof createComputeOptimizerExactObjectSessionPolicy>[0],
  code: ComputeOptimizerExportSessionPolicyError["code"],
): Promise<void> {
  await assert.rejects(createComputeOptimizerExactObjectSessionPolicy(request), (error: unknown) => {
    assert.equal(error instanceof ComputeOptimizerExportSessionPolicyError, true);
    assert.equal((error as ComputeOptimizerExportSessionPolicyError).code, code);
    assert.equal((error as Error).message, "Compute Optimizer export session policy rejected");
    return true;
  });
}

test("creates one exact current-object policy with no listing or neighboring access", async () => {
  const { plan, binding } = await fixture();
  const policy = await createComputeOptimizerExactObjectSessionPolicy({
    plan,
    binding,
    region: "us-east-1",
    bucket: "sutra-co-us-east-1",
    key: KEY,
    readIdentity: { mode: "CURRENT", versionId: null },
    encryption: encryption(binding),
  });

  assert.deepEqual(policy.policyDocument.Statement, [{
    Sid: "ReadOneComputeOptimizerExportObject",
    Effect: "Allow",
    Action: "s3:GetObject",
    Resource: `arn:aws:s3:::sutra-co-us-east-1/${KEY}`,
  }]);
  assert.doesNotMatch(policy.policyJson, /ListBucket|GetObjectAttributes|GetObjectVersion|kms:/u);
  assert.equal(policy.plaintextCharacters, policy.policyJson.length);
  assert.ok(policy.plaintextCharacters <= COMPUTE_OPTIMIZER_EXPORT_SESSION_POLICY_BOUNDS.maximumPlaintextCharacters);
  assert.match(policy.policySha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.isFrozen(policy), true);
  assert.equal(Object.isFrozen(policy.policyDocument.Statement), true);
});

test("uses GetObjectVersion only for a pinned version", async () => {
  const { plan, binding } = await fixture();
  const policy = await createComputeOptimizerExactObjectSessionPolicy({
    plan,
    binding,
    region: "us-east-1",
    bucket: "sutra-co-us-east-1",
    key: METADATA,
    readIdentity: { mode: "VERSION", versionId: "v1.EXACT" },
    encryption: encryption(binding),
  });
  assert.match(policy.policyJson, /s3:GetObjectVersion/u);
  assert.doesNotMatch(policy.policyJson, /"s3:GetObject"/u);
  assert.equal(policy.readIdentity.versionId, "v1.EXACT");
});

test("adds only exact KMS-key operations through regional S3", async () => {
  const { plan, binding } = await fixture();
  const kmsKeyArn = "arn:aws:kms:us-east-1:111122223333:key/12345678-1234-1234-1234-1234567890ab";
  const policy = await createComputeOptimizerExactObjectSessionPolicy({
    plan,
    binding,
    region: "us-east-1",
    bucket: "sutra-co-us-east-1",
    key: KEY,
    readIdentity: { mode: "CURRENT", versionId: null },
    encryption: encryption(binding, "us-east-1", { mode: "SSE_KMS", kmsKeyArn }),
  });
  assert.deepEqual(policy.policyDocument.Statement[1], {
    Sid: "DecryptOneComputeOptimizerExportKey",
    Effect: "Allow",
    Action: ["kms:Decrypt", "kms:GenerateDataKey"],
    Resource: kmsKeyArn,
    Condition: { StringEquals: { "kms:ViaService": "s3.us-east-1.amazonaws.com" } },
  });
});

test("renders China ARNs while retaining the all-partition KMS ViaService suffix", async () => {
  const { plan, binding: cnBinding } = await fixture("aws-cn", "cn-north-1");
  const cnKey = KEY.replace("us-east-1-", "cn-north-1-");
  const policy = await createComputeOptimizerExactObjectSessionPolicy({
    plan,
    binding: cnBinding,
    region: "cn-north-1",
    bucket: "sutra-co-us-east-1",
    key: cnKey,
    readIdentity: { mode: "CURRENT", versionId: null },
    encryption: {
      ...encryption(cnBinding, "cn-north-1"),
      mode: "SSE_KMS",
      kmsKeyArn: "arn:aws-cn:kms:cn-north-1:111122223333:key/12345678-1234-1234-1234-1234567890ab",
    },
  });
  assert.match(policy.policyJson, /arn:aws-cn:s3:::/u);
  assert.match(policy.policyJson, /s3\.cn-north-1\.amazonaws\.com/u);
  assert.doesNotMatch(policy.policyJson, /amazonaws\.com\.cn/u);
});

test("rejects any unplanned address, duplicate binding address, or forged encryption ledger", async () => {
  const { plan, binding } = await fixture();
  const base = {
    plan,
    binding,
    region: "us-east-1",
    bucket: "sutra-co-us-east-1",
    key: KEY,
    readIdentity: { mode: "CURRENT" as const, versionId: null },
    encryption: encryption(binding),
  };
  await rejects({ ...base, key: `${KEY}.neighbor` }, "ADDRESS_NOT_PLANNED");
  await rejects({ ...base, bucket: "different-bucket" }, "ADDRESS_NOT_PLANNED");
  await rejects({ ...base, encryption: encryption(binding, "us-east-1", { planId: `cope_${"f".repeat(64)}` }) }, "ENCRYPTION_BINDING_MISMATCH");
  await rejects({ ...base, encryption: encryption(binding, "us-east-1", { mode: "SSE_KMS", kmsKeyArn: "arn:aws:kms:eu-west-1:111122223333:key/12345678-1234-1234-1234-1234567890ab" }) }, "ENCRYPTION_BINDING_MISMATCH");

  const duplicate = structuredClone(binding) as unknown as VerifiedComputeOptimizerExportJobBinding;
  (duplicate.targets as unknown as unknown[]).push(structuredClone(duplicate.targets[0]));
  await rejects({ ...base, binding: duplicate }, "ADDRESS_NOT_PLANNED");
});

test("strictly rejects malformed read identity and request shapes", async () => {
  const { plan, binding } = await fixture();
  const base = {
    plan,
    binding,
    region: "us-east-1",
    bucket: "sutra-co-us-east-1",
    key: KEY,
    readIdentity: { mode: "CURRENT" as const, versionId: null },
    encryption: encryption(binding),
  };
  await rejects({ ...base, readIdentity: { mode: "VERSION", versionId: "" } }, "INVALID_INPUT");
  await rejects({ ...base, readIdentity: { mode: "CURRENT", versionId: "v1" } } as never, "INVALID_INPUT");
  await rejects({ ...base, extra: true } as never, "INVALID_INPUT");
});
