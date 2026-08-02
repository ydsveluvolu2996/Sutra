import assert from "node:assert/strict";
import test from "node:test";

import {
  ComputeOptimizerExportPlanError,
  createComputeOptimizerExportPlan,
  createComputeOptimizerExportPlanSet,
  verifyCompletedComputeOptimizerExportJobs,
  verifyComputeOptimizerExportPlan,
  verifyComputeOptimizerExportPlanSet,
  type ComputeOptimizerExportPlan,
  type ComputeOptimizerExportPlanInput,
  type ComputeOptimizerProviderExportJobResourceType,
  type ObservedCompletedComputeOptimizerExportJob,
} from "../lib/finops-compute-optimizer-export-plan.ts";
import { COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG } from "../lib/finops-compute-optimizer-export-field-catalog.ts";

const CONNECTION = `conn_${"a".repeat(32)}`;
const ACCOUNT = "111122223333";
const REGIONS = ["ap-south-1", "us-east-1"] as const;
const EXPORT_FAMILIES = ["EC2_INSTANCE", "IDLE_RESOURCE", "RDS_DATABASE"] as const;

const OPERATION = {
  EC2_INSTANCE: "ExportEC2InstanceRecommendations",
  IDLE_RESOURCE: "ExportIdleRecommendations",
  RDS_DATABASE: "ExportRDSDatabaseRecommendations",
} as const;

const FIELDS = {
  EC2_INSTANCE: COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.EC2_INSTANCE.minimumProjection,
  IDLE_RESOURCE: COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.IDLE_RESOURCE.minimumProjection,
  RDS_DATABASE: COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG.RDS_DATABASE.minimumProjection,
} as const;

const PROVIDER_RESOURCE_TYPE: Readonly<
  Record<(typeof EXPORT_FAMILIES)[number], ComputeOptimizerProviderExportJobResourceType>
> = {
  EC2_INSTANCE: "Ec2Instance",
  IDLE_RESOURCE: "Idle",
  RDS_DATABASE: "RdsDBInstance",
};

function target(region: string, exportFamily: (typeof EXPORT_FAMILIES)[number]) {
  const bucket = `sutra-co-${region}`;
  const optionalPrefix = region === "ap-south-1" ? "organization/history" : null;
  const effectivePrefix = optionalPrefix === null
    ? `compute-optimizer/${ACCOUNT}/`
    : `${optionalPrefix}/compute-optimizer/${ACCOUNT}/`;
  const token = `${region}-${exportFamily.toLowerCase().replaceAll("_", "-")}`;
  const jobId = `job-${token}`;
  const objectKey = `${effectivePrefix}${region}-2026-08-02T000000Z-${jobId}.csv`;
  return {
    region,
    exportFamily,
    bucket,
    optionalPrefix,
    effectivePrefix,
    request: {
      operation: OPERATION[exportFamily],
      region,
      fileFormat: "Csv" as const,
      includeMemberAccounts: true as const,
      filters: [] as const,
      fieldsToExport: FIELDS[exportFamily],
      s3DestinationConfig: { bucket, keyPrefix: optionalPrefix },
    },
    expectedJob: {
      jobId,
      providerResourceType: PROVIDER_RESOURCE_TYPE[exportFamily],
      bucket,
      objectKey,
      metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
    },
  };
}

function setInput(): ComputeOptimizerExportPlanInput {
  return {
    scope: { orgId: "org_alpha", customerId: "customer_alpha", connectionId: CONNECTION },
    requesterAccountId: ACCOUNT,
    partition: "aws",
    regions: REGIONS,
    exportFamilies: EXPORT_FAMILIES,
    targets: REGIONS.flatMap((region) => EXPORT_FAMILIES.map((family) => target(region, family))),
  };
}

function input(region = REGIONS[0]): ComputeOptimizerExportPlanInput {
  const matrix = setInput();
  return {
    ...matrix,
    regions: [region],
    targets: matrix.targets.filter((entry) => entry.region === region),
  };
}

type DeepMutable<T> = T extends readonly (infer U)[]
  ? DeepMutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: DeepMutable<T[K]> }
    : T;

function mutable<T>(value: T): DeepMutable<T> {
  return structuredClone(value) as DeepMutable<T>;
}

function unsafeInput(value: unknown): ComputeOptimizerExportPlanInput {
  return value as ComputeOptimizerExportPlanInput;
}

async function rejects(
  promise: Promise<unknown>,
  code: ComputeOptimizerExportPlanError["code"],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ComputeOptimizerExportPlanError && error.code === code,
  );
}

function observed(plan: ComputeOptimizerExportPlan): ObservedCompletedComputeOptimizerExportJob[] {
  return plan.targets.map((planned) => ({
    jobId: planned.expectedJob.jobId,
    region: planned.region,
    providerResourceType: planned.expectedJob.providerResourceType,
    status: "COMPLETE",
    bucket: planned.expectedJob.bucket,
    objectKey: planned.expectedJob.objectKey,
    metadataKey: planned.expectedJob.metadataKey,
  }));
}

test("seals the full matrix into deterministic content-addressed regional plans", async () => {
  const first = await createComputeOptimizerExportPlanSet(setInput());
  const second = await createComputeOptimizerExportPlanSet(setInput());
  assert.equal(first.planSetId, `copes_${first.contentSha256}`);
  assert.equal(first.contentSha256, second.contentSha256);
  assert.deepEqual(first, second);
  assert.deepEqual(first.regions, REGIONS);
  assert.deepEqual(first.planIds, first.plans.map((plan) => plan.planId));
  assert.equal(first.plans.length, REGIONS.length);
  assert.equal(first.plans.reduce((sum, plan) => sum + plan.targets.length, 0), REGIONS.length * EXPORT_FAMILIES.length);
  for (const [index, plan] of first.plans.entries()) {
    assert.deepEqual(plan.regions, [REGIONS[index]]);
    assert.equal(plan.targets.length, EXPORT_FAMILIES.length);
    assert.equal(new Set(plan.targets.map((entry) => entry.bucket)).size, 1);
    assert.equal(new Set(plan.targets.map((entry) => entry.requestSha256)).size, plan.targets.length);
  }
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.plans[0]?.targets[0]?.request), true);
  assert.deepEqual(await verifyComputeOptimizerExportPlanSet(structuredClone(first)), first);
});

test("verifies the plan-set identity and rejects regional plan reordering", async () => {
  const planSet = await createComputeOptimizerExportPlanSet(setInput());
  const changedHash = mutable(planSet) as unknown as { contentSha256: string };
  changedHash.contentSha256 = "f".repeat(64);
  await rejects(verifyComputeOptimizerExportPlanSet(changedHash), "CONTENT_HASH_MISMATCH");

  const reordered = mutable(planSet) as unknown as { plans: ComputeOptimizerExportPlan[] };
  reordered.plans.reverse();
  await rejects(verifyComputeOptimizerExportPlanSet(reordered), "SCOPE_MISMATCH");
});

test("rejects a multi-Region direct plan so callers queue the regional plans from a set", async () => {
  await rejects(createComputeOptimizerExportPlan(setInput()), "INVALID_INPUT");
});

test("accepts a sorted 50-Region set matrix and rejects Region 51", async () => {
  const regions = Array.from({ length: 51 }, (_, index) => {
    const first = String.fromCharCode(97 + Math.floor(index / 26));
    const second = String.fromCharCode(97 + (index % 26));
    return `${first}${second}-test-1`;
  });
  const matrix = (selectedRegions: readonly string[]): ComputeOptimizerExportPlanInput => ({
    scope: { orgId: "org_alpha", customerId: "customer_alpha", connectionId: CONNECTION },
    requesterAccountId: ACCOUNT,
    partition: "aws",
    regions: selectedRegions,
    exportFamilies: ["EC2_INSTANCE"],
    targets: selectedRegions.map((region) => target(region, "EC2_INSTANCE")),
  });

  const maximum = await createComputeOptimizerExportPlanSet(matrix(regions.slice(0, 50)));
  assert.equal(maximum.plans.length, 50);
  assert.equal(new Set(maximum.plans.map((plan) => plan.targets[0]!.bucket)).size, 50);
  await rejects(createComputeOptimizerExportPlanSet(matrix(regions)), "INVALID_INPUT");
});

test("accepts 256-character organization and customer identifiers and rejects 257", async () => {
  const maximum = mutable(input());
  maximum.scope.orgId = `o${"a".repeat(255)}`;
  maximum.scope.customerId = `c${"b".repeat(255)}`;
  const plan = await createComputeOptimizerExportPlan(unsafeInput(maximum));
  assert.equal(plan.scope.orgId.length, 256);
  assert.equal(plan.scope.customerId.length, 256);

  for (const scopeKey of ["orgId", "customerId"] as const) {
    const overLimit = mutable(input());
    overLimit.scope[scopeKey] = `a${"b".repeat(256)}`;
    await rejects(createComputeOptimizerExportPlan(unsafeInput(overLimit)), "INVALID_INPUT");
  }
});

test("plans one RDS database export in each regional plan without inventing request resourceType", async () => {
  const planSet = await createComputeOptimizerExportPlanSet(setInput());
  const rdsTargets = planSet.plans.flatMap((plan) =>
    plan.targets.filter((entry) => entry.exportFamily === "RDS_DATABASE"));
  assert.equal(rdsTargets.length, REGIONS.length);
  for (const planned of rdsTargets) {
    assert.equal(planned.request.operation, "ExportRDSDatabaseRecommendations");
    assert.equal(Object.hasOwn(planned.request, "resourceType"), false);
    assert.equal(planned.request.fieldsToExport.includes("InstanceFinding"), true);
    assert.equal(planned.request.fieldsToExport.includes("StorageFinding"), true);
    assert.equal(
      planned.request.fieldsToExport.includes("StorageRecommendationOptionsEstimatedMonthlySavingsValue"),
      true,
    );
  }

  const auroraResult = mutable(input());
  const rds = auroraResult.targets.find((entry) => entry.exportFamily === "RDS_DATABASE")!;
  rds.expectedJob.providerResourceType = "AuroraDBClusterStorage";
  const auroraPlan = await createComputeOptimizerExportPlan(unsafeInput(auroraResult));
  assert.equal(
    auroraPlan.targets.find((entry) => entry.exportFamily === "RDS_DATABASE")
      ?.expectedJob.providerResourceType,
    "AuroraDBClusterStorage",
  );
});

test("requires one bucket per regional plan and prevents set-wide reuse across Regions", async () => {
  const multipleForRegion = mutable(input());
  multipleForRegion.targets[0] = {
    ...multipleForRegion.targets[0]!,
    bucket: "different-ap-bucket",
    request: {
      ...multipleForRegion.targets[0]!.request,
      s3DestinationConfig: {
        ...multipleForRegion.targets[0]!.request.s3DestinationConfig,
        bucket: "different-ap-bucket",
      },
    },
    expectedJob: { ...multipleForRegion.targets[0]!.expectedJob, bucket: "different-ap-bucket" },
  };
  await rejects(createComputeOptimizerExportPlan(unsafeInput(multipleForRegion)), "REGION_BUCKET_CONFLICT");

  const reusedAcrossRegions = mutable(setInput());
  const usBucket = reusedAcrossRegions.targets.find((entry) => entry.region === "us-east-1")!.bucket;
  for (let index = 0; index < reusedAcrossRegions.targets.length; index += 1) {
    const current = reusedAcrossRegions.targets[index]!;
    if (current.region !== "ap-south-1") continue;
    reusedAcrossRegions.targets[index] = {
      ...current,
      bucket: usBucket,
      request: { ...current.request, s3DestinationConfig: { ...current.request.s3DestinationConfig, bucket: usBucket } },
      expectedJob: { ...current.expectedJob, bucket: usBucket },
    };
  }
  await rejects(createComputeOptimizerExportPlanSet(unsafeInput(reusedAcrossRegions)), "REGION_BUCKET_CONFLICT");
});

test("pins the optional prefix and exact AWS-created effective path", async () => {
  const planSet = await createComputeOptimizerExportPlanSet(setInput());
  assert.equal(
    planSet.plans.flatMap((plan) => plan.targets)
      .find((entry) => entry.region === "ap-south-1")?.effectivePrefix,
    `organization/history/compute-optimizer/${ACCOUNT}/`,
  );
  assert.equal(
    planSet.plans.flatMap((plan) => plan.targets)
      .find((entry) => entry.region === "us-east-1")?.effectivePrefix,
    `compute-optimizer/${ACCOUNT}/`,
  );

  const wrong = mutable(input());
  wrong.targets[0] = { ...wrong.targets[0]!, effectivePrefix: `organization/history/${ACCOUNT}/` };
  await rejects(createComputeOptimizerExportPlan(unsafeInput(wrong)), "INVALID_INPUT");
});

test("accepts the AWS-documented no-Z createdTimestamp export key", async () => {
  const jobId = "3e496c549301c8a4dfcsdX";
  const optionalPrefix = "ec2-instance-recommendations";
  const effectivePrefix = `${optionalPrefix}/compute-optimizer/${ACCOUNT}/`;
  const objectKey = `${effectivePrefix}us-west-2-2020-03-03T133027-${jobId}.csv`;
  const documented: ComputeOptimizerExportPlanInput = {
    scope: { orgId: "org_alpha", customerId: "customer_alpha", connectionId: CONNECTION },
    requesterAccountId: ACCOUNT,
    partition: "aws",
    regions: ["us-west-2"],
    exportFamilies: ["EC2_INSTANCE"],
    targets: [{
      region: "us-west-2",
      exportFamily: "EC2_INSTANCE",
      bucket: "compute-optimizer-exports",
      optionalPrefix,
      effectivePrefix,
      request: {
        operation: "ExportEC2InstanceRecommendations",
        region: "us-west-2",
        fileFormat: "Csv",
        includeMemberAccounts: true,
        filters: [],
        fieldsToExport: FIELDS.EC2_INSTANCE,
        s3DestinationConfig: {
          bucket: "compute-optimizer-exports",
          keyPrefix: optionalPrefix,
        },
      },
      expectedJob: {
        jobId,
        providerResourceType: "Ec2Instance",
        bucket: "compute-optimizer-exports",
        objectKey,
        metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
      },
    }],
  };

  const plan = await createComputeOptimizerExportPlan(documented);
  assert.equal(plan.targets[0]?.expectedJob.objectKey, objectKey);
});

test("requires Region/job identity and a non-empty opaque createdTimestamp segment", async () => {
  const missingTimestamp = mutable(input());
  const first = missingTimestamp.targets[0]!;
  const objectKey = `${first.effectivePrefix}${first.region}--${first.expectedJob.jobId}.csv`;
  first.expectedJob.objectKey = objectKey;
  first.expectedJob.metadataKey = `${objectKey.slice(0, -4)}-metadata.json`;
  await rejects(
    createComputeOptimizerExportPlan(unsafeInput(missingTimestamp)),
    "REQUEST_PROOF_INVALID",
  );

  const wrongJob = mutable(input());
  const next = wrongJob.targets[0]!;
  const substitutedKey = `${next.effectivePrefix}${next.region}-2026-08-02T000000Z-job-attacker.csv`;
  next.expectedJob.objectKey = substitutedKey;
  next.expectedJob.metadataKey = `${substitutedKey.slice(0, -4)}-metadata.json`;
  await rejects(
    createComputeOptimizerExportPlan(unsafeInput(wrongJob)),
    "REQUEST_PROOF_INVALID",
  );
});

test("requires exact full-organization request proof and rejects accountIds or filters", async () => {
  const membersFalse = mutable(input());
  const invalidMembersRequest = {
    ...membersFalse.targets[0]!.request,
    includeMemberAccounts: false,
  };
  membersFalse.targets[0]!.request = invalidMembersRequest as unknown as typeof membersFalse.targets[0]["request"];
  await rejects(
    createComputeOptimizerExportPlan(unsafeInput(membersFalse)),
    "REQUEST_PROOF_INVALID",
  );

  const accountIds = mutable(input()) as unknown as {
    targets: Array<{ request: Record<string, unknown> }>;
  };
  accountIds.targets[0]!.request.accountIds = ["222233334444"];
  await rejects(
    createComputeOptimizerExportPlan(unsafeInput(accountIds)),
    "REQUEST_PROOF_INVALID",
  );

  const filtered = mutable(input());
  filtered.targets[0]!.request = {
    ...filtered.targets[0]!.request,
    filters: [{ name: "Finding", values: ["Overprovisioned"] }],
  } as unknown as typeof filtered.targets[0]["request"];
  await rejects(
    createComputeOptimizerExportPlan(unsafeInput(filtered)),
    "REQUEST_PROOF_INVALID",
  );
});

test("pins operation, export family, Region and exact canonical fields", async () => {
  for (const mutate of [
    (value: DeepMutable<ComputeOptimizerExportPlanInput>) => {
      value.targets[0]!.request = { ...value.targets[0]!.request, operation: "ExportIdleRecommendations" } as typeof value.targets[0]["request"];
    },
    (value: DeepMutable<ComputeOptimizerExportPlanInput>) => {
      value.targets[0]!.request = { ...value.targets[0]!.request, region: "us-east-1" };
    },
    (value: DeepMutable<ComputeOptimizerExportPlanInput>) => {
      value.targets[0]!.request = { ...value.targets[0]!.request, fieldsToExport: ["Finding", "AccountId"] };
    },
    (value: DeepMutable<ComputeOptimizerExportPlanInput>) => {
      value.targets[0]!.request = {
        ...value.targets[0]!.request,
        fieldsToExport: [...value.targets[0]!.request.fieldsToExport, "FunctionArn"].sort(),
      };
    },
  ]) {
    const changed = mutable(input());
    mutate(changed);
    await rejects(
      createComputeOptimizerExportPlan(unsafeInput(changed)),
      "REQUEST_PROOF_INVALID",
    );
  }
});

test("fails closed on duplicate and missing planned pairs", async () => {
  const missing = mutable(input());
  missing.targets.pop();
  await rejects(
    createComputeOptimizerExportPlan(unsafeInput(missing)),
    "MISSING_TARGET",
  );

  const duplicate = mutable(input());
  duplicate.targets[duplicate.targets.length - 1] = structuredClone(duplicate.targets[0]!);
  await rejects(
    createComputeOptimizerExportPlan(unsafeInput(duplicate)),
    "DUPLICATE_TARGET",
  );
});

test("verifies immutable plan and per-request hashes", async () => {
  const plan = await createComputeOptimizerExportPlan(input());
  const changedRequestHash = mutable(plan) as unknown as {
    targets: Array<{ requestSha256: string }>;
  };
  changedRequestHash.targets[0]!.requestSha256 = "f".repeat(64);
  await rejects(verifyComputeOptimizerExportPlan(changedRequestHash), "CONTENT_HASH_MISMATCH");

  const changedPlanHash = mutable(plan) as unknown as { contentSha256: string };
  changedPlanHash.contentSha256 = "f".repeat(64);
  await rejects(verifyComputeOptimizerExportPlan(changedPlanHash), "CONTENT_HASH_MISMATCH");
});

test("binds completed jobs one-for-one and rejects any substitution", async () => {
  const plan = await createComputeOptimizerExportPlan(input());
  const jobs = observed(plan);
  const binding = verifyCompletedComputeOptimizerExportJobs(plan, jobs);
  assert.equal(binding.planId, plan.planId);
  assert.equal(binding.targets.length, plan.targets.length);

  for (const substitute of [
    { jobId: "job-attacker" },
    { bucket: "attacker-bucket" },
    { objectKey: `${plan.targets[0]!.effectivePrefix}other.csv` },
    { metadataKey: `${plan.targets[0]!.effectivePrefix}other-metadata.json` },
    { providerResourceType: "Idle" as ComputeOptimizerProviderExportJobResourceType },
  ]) {
    const changed = mutable(jobs);
    changed[0] = { ...changed[0]!, ...substitute };
    assert.throws(
      () => verifyCompletedComputeOptimizerExportJobs(plan, changed),
      (error: unknown) => error instanceof ComputeOptimizerExportPlanError && error.code === "JOB_SUBSTITUTION",
    );
  }
  assert.throws(
    () => verifyCompletedComputeOptimizerExportJobs(plan, jobs.slice(1)),
    (error: unknown) => error instanceof ComputeOptimizerExportPlanError && error.code === "JOB_SUBSTITUTION",
  );
});

test("rejects unsupported export families, partitions, unsorted dimensions and target limits", async () => {
  const unsupported = mutable(input()) as unknown as { exportFamilies: string[] };
  unsupported.exportFamilies = ["DYNAMODB_TABLE"];
  await rejects(
    createComputeOptimizerExportPlan(unsafeInput(unsupported)),
    "INVALID_INPUT",
  );

  const wrongPartition = mutable(input());
  wrongPartition.partition = "aws-cn";
  await rejects(
    createComputeOptimizerExportPlan(unsafeInput(wrongPartition)),
    "INVALID_INPUT",
  );

  const unsorted = mutable(setInput());
  unsorted.regions = [...unsorted.regions].reverse();
  await rejects(
    createComputeOptimizerExportPlanSet(unsafeInput(unsorted)),
    "INVALID_INPUT",
  );

  const tooMany = mutable(input()) as unknown as { targets: unknown[] };
  tooMany.targets = Array.from({ length: 451 }, () => structuredClone(input().targets[0]));
  await rejects(
    createComputeOptimizerExportPlan(unsafeInput(tooMany)),
    "INVALID_INPUT",
  );
});
