import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../lib/canonical-json.ts";
import {
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_BOUNDS,
  COMPUTE_OPTIMIZER_PROVIDER_RESOURCE_TYPES_BY_EXPORT_FAMILY,
  ComputeOptimizerExportLaunchError,
  createComputeOptimizerExportLaunchAttempt,
  createComputeOptimizerExportPlanInputFromLaunchAttempt,
  verifyComputeOptimizerExportLaunchAttempt,
  verifyComputeOptimizerExportLaunchExecution,
  type ComputeOptimizerExportLaunchAttempt,
  type ComputeOptimizerExportLaunchExecution,
  type ComputeOptimizerExportLaunchOutcome,
  type ComputeOptimizerExportLaunchAttemptInput,
  type ComputeOptimizerExportLaunchCompletedJobObservation,
} from "../lib/finops-compute-optimizer-export-launch.ts";
import { createComputeOptimizerExportPlan } from "../lib/finops-compute-optimizer-export-plan.ts";
import { COMPUTE_OPTIMIZER_EXPORT_MATERIALIZATION_PROJECTION } from
  "../lib/finops-compute-optimizer-export-field-catalog.ts";
import {
  COMPUTE_OPTIMIZER_EXPORT_LAUNCH_MATERIALIZATION_PROJECTION as BROKER_MATERIALIZATION_PROJECTION,
  parseComputeOptimizerExportLaunchAttempt as parseBrokerLaunchAttempt,
} from "../services/aws-collector/src/compute-optimizer-export-launcher.ts";

const SEALED = "2026-08-02T12:00:00.000Z";
const SCHEDULED = "2026-08-02T00:00:00.000Z";
const CONNECTION_ID = `conn_${"a".repeat(32)}`;

function input(
  partition: ComputeOptimizerExportLaunchAttemptInput["partition"] = "aws",
): ComputeOptimizerExportLaunchAttemptInput {
  const region = partition === "aws-cn"
    ? "cn-north-1"
    : partition === "aws-us-gov"
      ? "us-gov-west-1"
      : "ap-south-1";
  return {
    scope: { orgId: "org_alpha", customerId: "customer_alpha", connectionId: CONNECTION_ID },
    requesterAccountId: "111122223333",
    partition,
    region,
    scheduledWindow: SCHEDULED,
    sealedAtIso: SEALED,
    attemptNumber: 1,
    bucket: `sutra-compute-optimizer-${region}`,
    optionalPrefix: "organization/history",
  };
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}

async function execution(
  attempt: ComputeOptimizerExportLaunchAttempt,
  failAt: number | null = null,
): Promise<ComputeOptimizerExportLaunchExecution> {
  const outcomes: ComputeOptimizerExportLaunchOutcome[] = attempt.targets.map((target, index) => {
    if (failAt !== null && index >= failAt) {
      return {
        targetId: target.targetId,
        exportFamily: target.exportFamily,
        operation: target.operation,
        status: index === failAt ? "FAILED" : "NOT_ATTEMPTED",
        jobId: null,
        bucket: null,
        objectKey: null,
        metadataKey: null,
        errorCode: index === failAt ? "RATE_LIMITED" : "RATE_LIMITED",
      };
    }
    const jobId = `job-${index + 1}`;
    const objectKey = `${target.effectivePrefix}${target.region}-2026-08-02T120000Z-${jobId}.csv`;
    return {
      targetId: target.targetId,
      exportFamily: target.exportFamily,
      operation: target.operation,
      status: "SUCCEEDED",
      jobId,
      bucket: target.bucket,
      objectKey,
      metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
      errorCode: null,
    };
  });
  const body = {
    schemaVersion: "sutra.compute-optimizer-export-launch-execution.v1" as const,
    requestBatchId: attempt.requestBatchId,
    launchAttemptId: attempt.launchAttemptId,
    status: failAt === null ? "COMPLETE" as const : "PARTIAL" as const,
    startedAtIso: "2026-08-02T12:00:01.000Z",
    finishedAtIso: "2026-08-02T12:00:02.000Z",
    outcomes,
  };
  const contentSha256 = await sha256(canonicalJson(body));
  return {
    ...body,
    executionId: `coele_${contentSha256}`,
    contentSha256,
  };
}

function observations(
  attempt: ComputeOptimizerExportLaunchAttempt,
  completed: ComputeOptimizerExportLaunchExecution,
): ComputeOptimizerExportLaunchCompletedJobObservation[] {
  return completed.outcomes.map((outcome, index) => {
    assert.equal(outcome.status, "SUCCEEDED");
    const target = attempt.targets[index]!;
    const resourceType = target.exportFamily === "RDS_DATABASE"
      ? "RdsDBInstance" as const
      : COMPUTE_OPTIMIZER_PROVIDER_RESOURCE_TYPES_BY_EXPORT_FAMILY[target.exportFamily][0]!;
    return {
      targetId: target.targetId,
      plannedJobId: outcome.jobId,
      jobId: outcome.jobId,
      exportFamily: target.exportFamily,
      providerResourceType: resourceType,
      requestSha256: target.requestSha256,
      status: "COMPLETE",
      bucket: outcome.bucket,
      objectKey: outcome.objectKey,
      metadataKey: outcome.metadataKey,
      destination: {
        bucket: outcome.bucket,
        objectKey: outcome.objectKey,
        metadataKey: outcome.metadataKey,
      },
      creationTimestampIso: "2026-08-02T12:00:00.000Z",
      lastUpdatedTimestampIso: "2026-08-02T12:01:00.000Z",
    };
  });
}

test("seals all eight exact organization exports before provider calls", async () => {
  const attempt = await createComputeOptimizerExportLaunchAttempt(input());
  assert.deepEqual(parseBrokerLaunchAttempt(attempt), attempt);
  assert.equal(attempt.targets.length, 8);
  assert.deepEqual(
    attempt.targets.map(({ exportFamily }) => exportFamily),
    [...attempt.targets.map(({ exportFamily }) => exportFamily)].sort(),
  );
  for (const target of attempt.targets) {
    assert.equal(target.request.fileFormat, "Csv");
    assert.equal(target.request.includeMemberAccounts, true);
    assert.deepEqual(target.request.filters, []);
    assert.ok(target.request.fieldsToExport.length > 0);
    assert.deepEqual(
      target.request.fieldsToExport,
      COMPUTE_OPTIMIZER_EXPORT_MATERIALIZATION_PROJECTION[target.exportFamily],
    );
    assert.deepEqual(
      target.request.fieldsToExport,
      BROKER_MATERIALIZATION_PROJECTION[target.exportFamily],
    );
    assert.equal(target.request.fieldsToExport.includes("LookbackPeriodInDays"), true);
    assert.equal(target.request.s3DestinationConfig.keyPrefix, "organization/history");
    assert.equal(target.effectivePrefix, "organization/history/compute-optimizer/111122223333/");
  }
  assert.equal(Object.isFrozen(attempt), true);
  assert.equal(Object.isFrozen(attempt.targets[0]?.request.fieldsToExport), true);
  assert.doesNotMatch(canonicalJson(attempt), /accessKey|secret|sessionToken|credentials/iu);
  assert.ok(new TextEncoder().encode(canonicalJson(attempt)).byteLength
    < COMPUTE_OPTIMIZER_EXPORT_LAUNCH_BOUNDS.maximumEnvelopeBytes);
});

test("is replay-idempotent while retries retain one logical batch and a new attempt identity", async () => {
  const first = await createComputeOptimizerExportLaunchAttempt(input());
  const replay = await createComputeOptimizerExportLaunchAttempt(structuredClone(input()));
  assert.deepEqual(replay, first);

  const retry = await createComputeOptimizerExportLaunchAttempt({
    ...input(),
    sealedAtIso: "2026-08-02T12:05:00.000Z",
    attemptNumber: 2,
  });
  assert.equal(retry.requestBatchId, first.requestBatchId);
  assert.notEqual(retry.launchAttemptId, first.launchAttemptId);
  assert.equal(retry.attemptNumber, 2);
});

test("binds regions to all supported AWS partitions", async () => {
  for (const partition of ["aws", "aws-cn", "aws-us-gov"] as const) {
    const attempt = await createComputeOptimizerExportLaunchAttempt(input(partition));
    assert.equal(attempt.partition, partition);
    assert.equal(attempt.targets.every(({ region }) => region === attempt.region), true);
  }
  await assert.rejects(
    createComputeOptimizerExportLaunchAttempt({ ...input("aws-cn"), region: "us-east-1" }),
    (error: unknown) => error instanceof ComputeOptimizerExportLaunchError
      && error.code === "INVALID_INPUT",
  );
});

test("rejects noncanonical windows, unsafe destinations, and retry bounds", async () => {
  for (const invalid of [
    { ...input(), scheduledWindow: "2026-08-02 11:00:00Z" },
    { ...input(), scheduledWindow: "2026-08-02T01:00:00.000Z" },
    { ...input(), scheduledWindow: "2026-08-02T13:00:00.000Z" },
    { ...input(), optionalPrefix: "../private" },
    { ...input(), attemptNumber: 0 },
    { ...input(), attemptNumber: 1_001 },
    { ...input(), bucket: "127.0.0.1" },
  ]) {
    await assert.rejects(createComputeOptimizerExportLaunchAttempt(invalid));
  }
});

test("verification detects content, request, target, and projection tampering", async () => {
  const attempt = await createComputeOptimizerExportLaunchAttempt(input());
  assert.deepEqual(await verifyComputeOptimizerExportLaunchAttempt(attempt), attempt);
  for (const mutate of [
    (value: Record<string, unknown>) => { value.requestBatchId = `coelb_${"0".repeat(64)}`; },
    (value: Record<string, unknown>) => {
      const targets = value.targets as Array<Record<string, unknown>>;
      targets[0]!.operation = "ExportIdleRecommendations";
    },
    (value: Record<string, unknown>) => {
      const targets = value.targets as Array<Record<string, unknown>>;
      const request = targets[0]!.request as Record<string, unknown>;
      request.fieldsToExport = Array.from({ length: 257 }, (_, index) => `Field${index}`);
    },
  ]) {
    const changed = structuredClone(attempt) as unknown as Record<string, unknown>;
    mutate(changed);
    await assert.rejects(verifyComputeOptimizerExportLaunchAttempt(changed));
  }
});

test("complete launch deterministically produces a valid existing plan input", async () => {
  const attempt = await createComputeOptimizerExportLaunchAttempt(input());
  const completed = await execution(attempt);
  const described = observations(attempt, completed);
  const first = await createComputeOptimizerExportPlanInputFromLaunchAttempt(
    attempt,
    completed,
    described,
  );
  const replay = await createComputeOptimizerExportPlanInputFromLaunchAttempt(
    attempt,
    completed,
    described,
  );
  assert.deepEqual(replay, first);
  assert.equal(first.targets.length, 8);
  assert.equal(first.regions.length, 1);
  assert.equal(first.targets.some(({ request }) => "resourceType" in request), false);
  const rds = first.targets.find(({ exportFamily }) => exportFamily === "RDS_DATABASE");
  assert.equal(rds?.expectedJob.providerResourceType, "RdsDBInstance");
  assert.deepEqual(
    COMPUTE_OPTIMIZER_PROVIDER_RESOURCE_TYPES_BY_EXPORT_FAMILY.RDS_DATABASE,
    ["AuroraDBClusterStorage", "RdsDBInstance"],
  );
  const plan = await createComputeOptimizerExportPlan(first);
  assert.equal(plan.targets.length, 8);
});

test("partial and fail-stop outcomes can never produce a post-launch plan", async () => {
  const attempt = await createComputeOptimizerExportLaunchAttempt(input());
  const partial = await execution(attempt, 3);
  assert.deepEqual(
    await verifyComputeOptimizerExportLaunchExecution(attempt, partial),
    partial,
  );
  await assert.rejects(
    createComputeOptimizerExportPlanInputFromLaunchAttempt(attempt, partial, []),
    (error: unknown) => error instanceof ComputeOptimizerExportLaunchError
      && error.code === "INCOMPLETE_ATTEMPT",
  );
  const tampered = structuredClone(partial);
  (tampered.outcomes[3] as { errorCode: string }).errorCode = "PRIVATE_PROVIDER_MESSAGE";
  await assert.rejects(verifyComputeOptimizerExportLaunchExecution(attempt, tampered));
});

test("rejects provider substitution, malformed keys, and execution tampering", async () => {
  const attempt = await createComputeOptimizerExportLaunchAttempt(input());
  const completed = await execution(attempt);
  for (const mutate of [
    (value: ComputeOptimizerExportLaunchExecution) => {
      (value.outcomes[0] as { bucket: string }).bucket = "attacker-bucket";
    },
    (value: ComputeOptimizerExportLaunchExecution) => {
      (value.outcomes[0] as { objectKey: string }).objectKey = "outside/job-1.csv";
    },
    (value: ComputeOptimizerExportLaunchExecution) => {
      (value.outcomes[1] as { targetId: string }).targetId = value.outcomes[0]!.targetId;
    },
    (value: ComputeOptimizerExportLaunchExecution) => {
      (value as unknown as { contentSha256: string }).contentSha256 = "0".repeat(64);
    },
  ]) {
    const changed = structuredClone(completed);
    mutate(changed);
    await assert.rejects(createComputeOptimizerExportPlanInputFromLaunchAttempt(
      attempt,
      changed,
      observations(attempt, completed),
    ));
  }
});

test("requires one exact completed Describe proof for every successful launch", async () => {
  const attempt = await createComputeOptimizerExportLaunchAttempt(input());
  const completed = await execution(attempt);
  const described = observations(attempt, completed);
  await assert.rejects(createComputeOptimizerExportPlanInputFromLaunchAttempt(
    attempt,
    completed,
    described.slice(1),
  ));
  await assert.rejects(createComputeOptimizerExportPlanInputFromLaunchAttempt(
    attempt,
    completed,
    [described[0]!, described[0]!, ...described.slice(2)],
  ));
  for (const mutate of [
    (jobs: ComputeOptimizerExportLaunchCompletedJobObservation[]) => {
      jobs[0] = { ...jobs[0]!, jobId: "substituted-job" };
    },
    (jobs: ComputeOptimizerExportLaunchCompletedJobObservation[]) => {
      jobs[0] = { ...jobs[0]!, plannedJobId: "substituted-job" };
    },
    (jobs: ComputeOptimizerExportLaunchCompletedJobObservation[]) => {
      jobs[0] = { ...jobs[0]!, requestSha256: "0".repeat(64) };
    },
    (jobs: ComputeOptimizerExportLaunchCompletedJobObservation[]) => {
      jobs[0] = { ...jobs[0]!, providerResourceType: "Idle" };
    },
    (jobs: ComputeOptimizerExportLaunchCompletedJobObservation[]) => {
      jobs[0] = { ...jobs[0]!, lastUpdatedTimestampIso: "2026-08-02T11:59:59.000Z" };
    },
  ]) {
    const changed = structuredClone(described);
    mutate(changed);
    await assert.rejects(createComputeOptimizerExportPlanInputFromLaunchAttempt(
      attempt,
      completed,
      changed,
    ));
  }
});

test("accepts observed Aurora resource type without inventing an RDS request field", async () => {
  const attempt = await createComputeOptimizerExportLaunchAttempt(input());
  const completed = await execution(attempt);
  const described = observations(attempt, completed);
  const rdsIndex = attempt.targets.findIndex(({ exportFamily }) => exportFamily === "RDS_DATABASE");
  described[rdsIndex] = {
    ...described[rdsIndex]!,
    providerResourceType: "AuroraDBClusterStorage",
  };
  const planInput = await createComputeOptimizerExportPlanInputFromLaunchAttempt(
    attempt,
    completed,
    described,
  );
  assert.equal(planInput.targets[rdsIndex]?.expectedJob.providerResourceType, "AuroraDBClusterStorage");
  assert.equal("resourceType" in planInput.targets[rdsIndex]!.request, false);
});
