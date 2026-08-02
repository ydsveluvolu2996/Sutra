import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../lib/canonical-json.ts";
import {
  COMPUTE_OPTIMIZER_MATERIALIZATION_COORDINATOR_BOUNDS,
  ComputeOptimizerMaterializationCoordinatorError,
  coordinateComputeOptimizerMaterializationPlans,
  createComputeOptimizerMaterializationActivation,
  runComputeOptimizerMaterialization,
  verifyComputeOptimizerMaterializationActivation,
  verifyComputeOptimizerMaterializationPlanCheckpoint,
  verifyComputeOptimizerMaterializationRuntimeCheckpoint,
  type ComputeOptimizerExactGenerationPersistence,
  type ComputeOptimizerMaterializationRegionRuntime,
} from "../lib/finops-compute-optimizer-export-coordinator.ts";
import type { StoredComputeOptimizerFinalizedExportEvidence } from
  "../db/finops-compute-optimizer-discovery-repository.ts";
import {
  COMPUTE_OPTIMIZER_PROVIDER_RESOURCE_TYPES_BY_EXPORT_FAMILY,
  createComputeOptimizerExportLaunchAttempt,
  type ComputeOptimizerExportLaunchAttempt,
  type ComputeOptimizerExportLaunchCompletedJobObservation,
  type ComputeOptimizerExportLaunchExecution,
  type ComputeOptimizerExportLaunchOutcome,
} from "../lib/finops-compute-optimizer-export-launch.ts";
import type { ComputeOptimizerExportFamily, ComputeOptimizerExportPlan } from
  "../lib/finops-compute-optimizer-export-plan.ts";
import type { ComputeOptimizerExportDescribeReader } from
  "../lib/finops-compute-optimizer-export-fresh-resolver.ts";
import type { ComputeOptimizerExportObjectReader } from
  "../lib/finops-compute-optimizer-export-object-set.ts";
import type {
  ComputeOptimizerExportGeneration,
  ComputeOptimizerExportGenerationAttempt,
} from "../lib/finops-compute-optimizer-export-generation.ts";

const CONNECTION = `conn_${"a".repeat(32)}`;
const SCHEDULED = "2026-08-02T00:00:00.000Z";
const RUNTIME_NOW = Date.parse("2026-08-02T12:20:00.000Z");
const MATERIALIZED_AT = Date.parse("2026-08-02T12:21:00.000Z");
const DEADLINE_AT = Date.parse("2026-08-02T12:30:00.000Z");
const encoder = new TextEncoder();

async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((part) => part.toString(16).padStart(2, "0")).join("");
}

async function attempt(region: string, index: number): Promise<ComputeOptimizerExportLaunchAttempt> {
  return createComputeOptimizerExportLaunchAttempt({
    scope: { orgId: "org_coordinator", customerId: "customer_coordinator", connectionId: CONNECTION },
    requesterAccountId: "111122223333",
    partition: "aws",
    region,
    scheduledWindow: SCHEDULED,
    sealedAtIso: `2026-08-02T12:0${index}:00.000Z`,
    attemptNumber: 1,
    bucket: `sutra-coordinator-${region}`,
    optionalPrefix: "organization/exports",
  });
}

async function execution(
  value: ComputeOptimizerExportLaunchAttempt,
  failAt: number | null = null,
): Promise<ComputeOptimizerExportLaunchExecution> {
  const outcomes: ComputeOptimizerExportLaunchOutcome[] = value.targets.map((target, index) => {
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
        errorCode: "RATE_LIMITED",
      };
    }
    const jobId = `job-${value.region}-${index + 1}`;
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
    requestBatchId: value.requestBatchId,
    launchAttemptId: value.launchAttemptId,
    status: failAt === null ? "COMPLETE" as const : "PARTIAL" as const,
    startedAtIso: "2026-08-02T12:10:00.000Z",
    finishedAtIso: "2026-08-02T12:11:00.000Z",
    outcomes,
  };
  const contentSha256 = await digest(canonicalJson(body));
  return { ...body, executionId: `coele_${contentSha256}`, contentSha256 };
}

function observations(
  value: ComputeOptimizerExportLaunchAttempt,
  completed: ComputeOptimizerExportLaunchExecution,
): ComputeOptimizerExportLaunchCompletedJobObservation[] {
  return completed.outcomes.map((outcome, index) => {
    assert.equal(outcome.status, "SUCCEEDED");
    const target = value.targets[index]!;
    return {
      targetId: target.targetId,
      plannedJobId: outcome.jobId,
      jobId: outcome.jobId,
      exportFamily: target.exportFamily,
      providerResourceType: target.exportFamily === "RDS_DATABASE"
        ? "RdsDBInstance"
        : COMPUTE_OPTIMIZER_PROVIDER_RESOURCE_TYPES_BY_EXPORT_FAMILY[target.exportFamily][0]!,
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
      lastUpdatedTimestampIso: "2026-08-02T12:15:00.000Z",
    };
  });
}

async function completeEvidence(value: ComputeOptimizerExportLaunchAttempt) {
  const terminal = await execution(value);
  return {
    launchAttemptId: value.launchAttemptId,
    execution: terminal,
    completedJobs: observations(value, terminal),
  };
}

async function fixture() {
  const attempts = await Promise.all([
    attempt("ap-south-1", 0),
    attempt("us-east-1", 1),
  ]);
  const activation = await createComputeOptimizerMaterializationActivation(attempts);
  const evidence = await Promise.all(attempts.map(completeEvidence));
  return { attempts, activation, evidence };
}

function code(expected: ComputeOptimizerMaterializationCoordinatorError["code"]) {
  return (error: unknown) => error instanceof ComputeOptimizerMaterializationCoordinatorError
    && error.code === expected;
}

const GUIDE_COLUMN: Readonly<
Partial<Record<ComputeOptimizerExportFamily, Readonly<Record<string, string>>>>
> = {
  EC2_INSTANCE: {
    AccountId: "accountId",
    CurrentInstanceType: "currentInstanceType",
    Finding: "finding",
    InstanceArn: "instanceArn",
    LastRefreshTimestamp: "lastRefreshTimestamp_UTC",
    LookbackPeriodInDays: "lookBackPeriodInDays",
  },
  AUTO_SCALING_GROUP: {
    AccountId: "accountId",
    AutoScalingGroupArn: "autoScalingGroupArn",
    AutoScalingGroupName: "autoScalingGroupName",
    CurrentConfigurationDesiredCapacity: "currentConfiguration_desiredCapacity",
    CurrentConfigurationInstanceType: "currentConfiguration_instanceType",
    Finding: "finding",
    LastRefreshTimestamp: "lastRefreshTimestamp",
    LookbackPeriodInDays: "lookBackPeriodInDays",
  },
  EBS_VOLUME: {
    AccountId: "accountId",
    Finding: "finding",
    LastRefreshTimestamp: "lastRefreshTimestamp",
    LookbackPeriodInDays: "lookBackPeriodInDays",
  },
  LAMBDA_FUNCTION: {
    AccountId: "accountId",
    Finding: "finding",
    LastRefreshTimestamp: "lastRefreshTimestamp",
    LookbackPeriodInDays: "lookBackPeriodInDays",
  },
  ECS_SERVICE: {
    AccountId: "accountId",
    CurrentServiceConfigurationCpu: "currentServiceConfiguration_cpu",
    CurrentServiceConfigurationMemory: "currentServiceConfiguration_memory",
    CurrentServiceConfigurationTaskDefinitionArn: "currentServiceConfiguration_taskDefinitionArn",
    Finding: "findings",
    LastRefreshTimestamp: "lastRefreshTimestamp_UTC",
    LaunchType: "launchType",
    LookbackPeriodInDays: "lookBackPeriodInDays",
    ServiceArn: "serviceArn",
  },
};

function rankedColumn(
  family: ComputeOptimizerExportFamily,
  field: string,
): string | null {
  const map: Partial<Record<ComputeOptimizerExportFamily, Record<string, string>>> = {
    EC2_INSTANCE: {
      RecommendationOptionsInstanceType: "recommendationOptions_1_instanceType",
      RecommendationOptionsPerformanceRisk: "recommendationOptions_1_performanceRisk",
    },
    AUTO_SCALING_GROUP: {
      RecommendationOptionsConfigurationDesiredCapacity:
        "recommendationOptions_1_configuration_desiredCapacity",
      RecommendationOptionsConfigurationInstanceType:
        "recommendationOptions_1_configuration_instanceType",
      RecommendationOptionsPerformanceRisk: "recommendationOptions_1_performanceRisk",
    },
    EBS_VOLUME: {
      RecommendationOptionsConfigurationVolumeBaselineIOPS:
        "RecommendationOptions_1_ConfigurationVolumeBaselineIOPS",
      RecommendationOptionsConfigurationVolumeBaselineThroughput:
        "RecommendationOptions_1_ConfigurationVolumeBaselineThroughput",
      RecommendationOptionsConfigurationVolumeSize:
        "RecommendationOptions_1_ConfigurationVolumeSize",
      RecommendationOptionsConfigurationVolumeType:
        "RecommendationOptions_1_ConfigurationVolumeType",
      RecommendationOptionsPerformanceRisk: "recommendationOptions_1_performanceRisk",
    },
    LAMBDA_FUNCTION: {
      RecommendationOptionsConfigurationMemorySize:
        "RecommendationOptions_1_ConfigurationMemorySize",
    },
    ECS_SERVICE: {
      RecommendationOptionsCpu: "recommendationOptions_1_cpu",
      RecommendationOptionsMemory: "recommendationOptions_1_memory",
    },
  };
  return map[family]?.[field] ?? null;
}

const INTEGER_FIELDS = new Set([
  "CurrentConfigurationDesiredCapacity",
  "RecommendationOptionsConfigurationDesiredCapacity",
  "CurrentConfigurationVolumeBaselineIOPS",
  "CurrentConfigurationVolumeBaselineThroughput",
  "CurrentConfigurationVolumeSize",
  "RecommendationOptionsConfigurationVolumeBaselineIOPS",
  "RecommendationOptionsConfigurationVolumeBaselineThroughput",
  "RecommendationOptionsConfigurationVolumeSize",
  "CurrentConfigurationMemorySize",
  "CurrentConfigurationTimeout",
  "RecommendationOptionsConfigurationMemorySize",
  "CurrentServiceConfigurationCpu",
  "CurrentServiceConfigurationMemory",
  "RecommendationOptionsCpu",
  "RecommendationOptionsMemory",
  "CurrentLicenseConfigurationNumberOfCores",
  "CurrentStorageConfigurationAllocatedStorage",
  "CurrentStorageConfigurationIOPS",
  "CurrentStorageConfigurationMaxAllocatedStorage",
  "CurrentStorageConfigurationStorageThroughput",
  "StorageRecommendationOptionsAllocatedStorage",
  "StorageRecommendationOptionsIOPS",
  "StorageRecommendationOptionsMaxAllocatedStorage",
  "StorageRecommendationOptionsStorageThroughput",
  "InstanceRecommendationOptionsRank",
  "StorageRecommendationOptionsRank",
  "PromotionTier",
]);

function fieldDatatype(field: string): "string" | "integer" | "double" | "datetime" {
  if (field === "LastRefreshTimestamp") return "datetime";
  if (field === "LookbackPeriodInDays"
    || field.includes("EstimatedMonthlySavingsValue")
    || /SavingsOpportunity.*Percentage$/u.test(field)
    || (field.includes("PerformanceRisk") && !field.startsWith("Current"))) return "double";
  if (INTEGER_FIELDS.has(field)) return "integer";
  return "string";
}

function objectFixture(target: ComputeOptimizerExportPlan["targets"][number]): {
  readonly csvBytes: Uint8Array;
  readonly metadataBytes: Uint8Array;
} {
  const descriptors = target.request.fieldsToExport.flatMap((field) => {
    if (field === "Tags") return [];
    const ranked = rankedColumn(target.exportFamily, field);
    const reason = (target.exportFamily === "EC2_INSTANCE"
      || target.exportFamily === "ECS_SERVICE") && field === "FindingReasonCodes"
      ? "findingReasonCodes_CPU"
      : null;
    return [{
      field,
      name: ranked ?? reason ?? GUIDE_COLUMN[target.exportFamily]?.[field] ?? field,
      datatype: fieldDatatype(field),
    }];
  });
  const tagsSupported = target.request.fieldsToExport.includes("Tags");
  const columns = [
    { name: "recommendations_count", titles: "Count", datatype: "integer", required: true },
    ...descriptors.map(({ field, name, datatype }) => ({
      name,
      titles: field,
      datatype,
      null: "",
      required: false,
      ...(datatype === "datetime" ? { format: "yyyy-MM-dd HH:mm:ss" } : {}),
    })),
    ...(tagsSupported ? [{
      name: "tags_environment",
      titles: "Tag: environment",
      datatype: "string",
      null: "",
      required: false,
    }] : []),
    { name: "errorCode", titles: "Error code", datatype: "string", required: true },
    { name: "errorMessage", titles: "Error message", datatype: "string", required: true },
  ];
  const basename = target.expectedJob.objectKey.split("/").at(-1)!;
  const metadata = {
    "@context": ["http://www.w3.org/ns/csvw"],
    url: basename,
    "dc:title": `${target.exportFamily} Recommendations`,
    "dc:modified": { "@value": "2026-08-02", "@type": "xsd:date" },
    dialect: {
      encoding: "utf-8",
      lineTerminators: ["\n"],
      doubleQuote: true,
      skipRows: 0,
      header: true,
      headerRowCount: 1,
      delimiter: ",",
      skipColumns: 0,
      skipBlankRows: false,
      trim: false,
    },
    tableSchema: { columns },
  };
  const row = [
    "0",
    ...descriptors.map(() => ""),
    ...(tagsSupported ? [""] : []),
    "AccessDenied",
    "Provider could not inspect resource",
  ];
  return {
    csvBytes: encoder.encode([
      columns.map(({ name }) => name).join(","),
      row.join(","),
    ].join("\n")),
    metadataBytes: encoder.encode(JSON.stringify(metadata)),
  };
}

async function discoveryEvidence(
  plan: ComputeOptimizerExportPlan,
): Promise<StoredComputeOptimizerFinalizedExportEvidence> {
  const exportJobs = await Promise.all(plan.targets.map(async (target) => ({
    jobId: target.expectedJob.jobId,
    resourceType: target.expectedJob.providerResourceType,
    status: "COMPLETE" as const,
    createdAt: "2026-08-02T12:00:00.000Z",
    lastUpdatedAt: "2026-08-02T12:15:00.000Z",
    failureCode: null,
    destination: {
      bucketSha256: await digest(target.expectedJob.bucket),
      objectKeySha256: await digest(target.expectedJob.objectKey),
      metadataKeySha256: await digest(target.expectedJob.metadataKey),
    },
  })));
  const runHash = await digest(`discovery-${plan.regions[0]}`);
  return {
    run: {
      scope: {
        organizationId: plan.scope.orgId,
        customerId: plan.scope.customerId,
        connectionId: plan.scope.connectionId,
      },
      runId: `cor_${runHash}`,
      jobId: `discovery-${plan.regions[0]}`,
      status: "partial",
      contentSha256: runHash,
      collectedAt: "2026-08-02T12:16:00.000Z",
      dataThroughAt: "2026-08-02T12:15:00.000Z",
      accountId: plan.requesterAccountId,
      partition: plan.partition,
      region: plan.regions[0]!,
      memberCount: 0,
      exportJobCount: exportJobs.length,
      coverageCount: 1,
      errorCode: null,
      limitations: [],
      createdAtIso: "2026-08-02T12:00:00.000Z",
      startedAtIso: "2026-08-02T12:00:00.000Z",
      finalizedAtIso: "2026-08-02T12:16:00.000Z",
    },
    exportJobs,
  };
}

function describeReader(
  plan: ComputeOptimizerExportPlan,
  mutate?: (jobs: Array<Record<string, unknown>>) => void,
): ComputeOptimizerExportDescribeReader {
  return async () => {
    const jobs: Array<Record<string, unknown>> = plan.targets.map((target) => ({
      jobId: target.expectedJob.jobId,
      resourceType: target.expectedJob.providerResourceType,
      status: "Complete",
      creationTimestamp: "2026-08-02T12:00:00.000Z",
      lastUpdatedTimestamp: "2026-08-02T12:15:00.000Z",
      destination: { s3: {
        bucket: target.expectedJob.bucket,
        key: target.expectedJob.objectKey,
        metadataKey: target.expectedJob.metadataKey,
      } },
      failureReason: null,
    }));
    mutate?.(jobs);
    return { recommendationExportJobs: jobs };
  };
}

function persistenceRecorder(fail = false): {
  readonly persistence: ComputeOptimizerExactGenerationPersistence;
  readonly attempts: ComputeOptimizerExportGenerationAttempt[];
  readonly generations: ComputeOptimizerExportGeneration[];
} {
  const attempts: ComputeOptimizerExportGenerationAttempt[] = [];
  const generations: ComputeOptimizerExportGeneration[] = [];
  const persistence: ComputeOptimizerExactGenerationPersistence = {
    async recordAttempt(_scope, _planSet, value) {
      if (fail) throw new Error("private persistence failure");
      attempts.push(value);
    },
    async recordAcceptedGeneration(_scope, _planSet, value) {
      if (fail) throw new Error("private persistence failure");
      generations.push(value);
    },
  };
  return { persistence, attempts, generations };
}

async function runtimeFixture() {
  const base = await fixture();
  const ready = await coordinateComputeOptimizerMaterializationPlans(base.activation, base.evidence);
  assert.notEqual(ready.planSet, null);
  const objectBytes = new Map<string, Uint8Array>();
  const runtimes: ComputeOptimizerMaterializationRegionRuntime[] = [];
  for (const plan of ready.planSet!.plans) {
    for (const target of plan.targets) {
      const bundle = objectFixture(target);
      objectBytes.set(
        `${target.region}\0${target.expectedJob.bucket}\0${target.expectedJob.objectKey}`,
        bundle.csvBytes,
      );
      objectBytes.set(
        `${target.region}\0${target.expectedJob.bucket}\0${target.expectedJob.metadataKey}`,
        bundle.metadataBytes,
      );
    }
    const objectReader: ComputeOptimizerExportObjectReader = async (region, bucket, key) => {
      const bytes = objectBytes.get(`${region}\0${bucket}\0${key}`);
      if (bytes === undefined) throw new Error("address absent");
      return {
        bytes: new Uint8Array(bytes),
        eTag: `etag-${await digest(`${region}-${key}`)}`,
        versionId: `version-${await digest(key)}`,
      };
    };
    runtimes.push({
      region: plan.regions[0]!,
      discoveryEvidence: await discoveryEvidence(plan),
      describeReader: describeReader(plan),
      objectReader,
    });
  }
  return { ...base, ready, runtimes, objectBytes };
}

function runtimeOptions(persistence: ComputeOptimizerExactGenerationPersistence) {
  return {
    materializedAtMs: MATERIALIZED_AT,
    deadlineAtMs: DEADLINE_AT,
    persistence,
    now: () => RUNTIME_NOW,
  };
}

test("activation is order-independent, content-addressed and server-sealed to all eight families", async () => {
  const { attempts } = await fixture();
  const first = await createComputeOptimizerMaterializationActivation(attempts);
  const reversed = await createComputeOptimizerMaterializationActivation([...attempts].reverse());
  assert.deepEqual(reversed, first);
  assert.deepEqual(first.regions, ["ap-south-1", "us-east-1"]);
  assert.equal(first.launchAttempts.every(({ targets }) => targets.length === 8), true);
  assert.equal(first.activationId, `comra_${first.contentSha256}`);
  assert.equal(Object.isFrozen(first.launchAttempts[0]?.targets), true);
  assert.doesNotMatch(canonicalJson(first), /secret|sessionToken|credentials|accessKey/iu);
  assert.ok(new TextEncoder().encode(canonicalJson(first)).byteLength
    < COMPUTE_OPTIMIZER_MATERIALIZATION_COORDINATOR_BOUNDS.maximumSerializedBytes);
  assert.deepEqual(await verifyComputeOptimizerMaterializationActivation(first), first);
});

test("complete exact Describe evidence deterministically releases one sorted immutable plan set", async () => {
  const { activation, evidence } = await fixture();
  const first = await coordinateComputeOptimizerMaterializationPlans(activation, evidence);
  const replay = await coordinateComputeOptimizerMaterializationPlans(
    activation,
    [...evidence].reverse(),
  );
  assert.deepEqual(replay, first);
  assert.equal(first.status, "PLAN_SET_READY");
  assert.deepEqual(first.regions.map(({ region }) => region), activation.regions);
  assert.equal(first.regions.every(({ state }) => state === "PLAN_READY"), true);
  assert.equal(first.regions.every(({ completedJobCount }) => completedJobCount === 8), true);
  assert.deepEqual(first.planSet?.regions, activation.regions);
  assert.deepEqual(first.planSet?.planIds, first.regions.map(({ planId }) => planId));
  assert.deepEqual(
    await verifyComputeOptimizerMaterializationPlanCheckpoint(activation, first),
    first,
  );
});

test("one missing Region preserves typed evidence and can never release a plan set", async () => {
  const { activation, evidence } = await fixture();
  const blocked = await coordinateComputeOptimizerMaterializationPlans(activation, evidence.slice(0, 1));
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.planSet, null);
  assert.equal(blocked.regions[0]?.state, "PLAN_READY");
  assert.deepEqual(blocked.regions[1]?.errorCodes, ["REGION_EVIDENCE_MISSING"]);
  assert.equal(blocked.regions[1]?.launchExecutionId, null);
});

test("partial launch retains only public typed errors and never consumes Describe payload", async () => {
  const { attempts, activation, evidence } = await fixture();
  const partial = await execution(attempts[1]!, 3);
  const poisoned = {
    launchAttemptId: attempts[1]!.launchAttemptId,
    execution: partial,
    completedJobs: { credentials: "must-not-be-read", rawProviderMessage: "private" },
  };
  const blocked = await coordinateComputeOptimizerMaterializationPlans(
    activation,
    [evidence[0]!, poisoned],
  );
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.planSet, null);
  assert.equal(blocked.regions[1]?.state, "LAUNCH_BLOCKED");
  assert.deepEqual(blocked.regions[1]?.errorCodes, ["LAUNCH_PARTIAL", "RATE_LIMITED"]);
  assert.doesNotMatch(canonicalJson(blocked), /credentials|private|rawProviderMessage/u);
});

test("job, destination, resource-type, and request substitutions block the Region", async () => {
  const { activation, evidence } = await fixture();
  const changed = structuredClone(evidence);
  (changed[1]!.completedJobs[0] as { requestSha256: string }).requestSha256 = "f".repeat(64);
  const blocked = await coordinateComputeOptimizerMaterializationPlans(activation, changed);
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.planSet, null);
  assert.equal(blocked.regions[1]?.state, "DESCRIBE_BLOCKED");
  assert.deepEqual(blocked.regions[1]?.errorCodes, ["DESCRIBE_INVALID"]);
});

test("duplicate and unsealed regional evidence cannot expand or ambiguously replace activation", async () => {
  const { activation, evidence } = await fixture();
  await assert.rejects(
    coordinateComputeOptimizerMaterializationPlans(activation, [evidence[0]!, evidence[0]!]),
    code("DUPLICATE_REGION"),
  );
  await assert.rejects(
    coordinateComputeOptimizerMaterializationPlans(activation, [{
      ...evidence[0]!,
      launchAttemptId: `coela_${"f".repeat(64)}`,
    }]),
    code("REGION_EXPANSION"),
  );
});

test("invalid or out-of-order execution is sanitized as blocked evidence", async () => {
  const { activation, evidence } = await fixture();
  const changed = structuredClone(evidence);
  (changed[0]!.execution.outcomes as ComputeOptimizerExportLaunchOutcome[]).reverse();
  const blocked = await coordinateComputeOptimizerMaterializationPlans(activation, changed);
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(blocked.regions[0]?.state, "LAUNCH_BLOCKED");
  assert.deepEqual(blocked.regions[0]?.errorCodes, ["EXECUTION_INVALID"]);
  assert.equal(blocked.regions[0]?.launchExecutionId, null);
});

test("activation and checkpoint replay verification reject any mutation", async () => {
  const { activation, evidence } = await fixture();
  const ready = await coordinateComputeOptimizerMaterializationPlans(activation, evidence);
  const changedActivation = structuredClone(activation);
  (changedActivation as { contentSha256: string }).contentSha256 = "f".repeat(64);
  await assert.rejects(
    verifyComputeOptimizerMaterializationActivation(changedActivation),
    code("CONTENT_HASH_MISMATCH"),
  );
  const changedCheckpoint = structuredClone(ready);
  (changedCheckpoint.regions[0] as { completedJobCount: number }).completedJobCount = 7;
  await assert.rejects(
    verifyComputeOptimizerMaterializationPlanCheckpoint(activation, changedCheckpoint),
    code("CHECKPOINT_INVALID"),
  );
  const forged = structuredClone(ready) as unknown as Record<string, unknown>;
  const forgedRegions = forged.regions as Array<Record<string, unknown>>;
  forgedRegions[0]!.completedJobCount = 7;
  const forgedBody = Object.fromEntries(Object.entries(forged).filter(([key]) =>
    key !== "checkpointId" && key !== "contentSha256"));
  const forgedHash = await digest(canonicalJson(forgedBody));
  forged.contentSha256 = forgedHash;
  forged.checkpointId = `comrp_${forgedHash}`;
  await assert.rejects(
    verifyComputeOptimizerMaterializationPlanCheckpoint(activation, forged),
    code("CHECKPOINT_INVALID"),
  );
});

test("scope, schedule, partition, Region and bucket mismatches cannot form an activation", async () => {
  const first = await attempt("ap-south-1", 0);
  const wrongScope = await createComputeOptimizerExportLaunchAttempt({
    scope: { ...first.scope, customerId: "other_customer" },
    requesterAccountId: first.requesterAccountId,
    partition: first.partition,
    region: "us-east-1",
    scheduledWindow: first.scheduledWindow,
    sealedAtIso: "2026-08-02T12:01:00.000Z",
    attemptNumber: 1,
    bucket: "sutra-coordinator-us-east-1",
    optionalPrefix: "organization/exports",
  });
  await assert.rejects(
    createComputeOptimizerMaterializationActivation([first, wrongScope]),
    code("ACTIVATION_MISMATCH"),
  );
  await assert.rejects(
    createComputeOptimizerMaterializationActivation([first, first]),
    code("DUPLICATE_REGION"),
  );
});

test("all fresh exact objects deterministically persist an attempt then one accepted generation", async () => {
  const source = await runtimeFixture();
  const firstStore = persistenceRecorder();
  const first = await runComputeOptimizerMaterialization(
    source.activation,
    source.ready,
    [...source.runtimes].reverse(),
    runtimeOptions(firstStore.persistence),
  );
  assert.equal(first.status, "GENERATION_ACCEPTED");
  assert.equal(first.regions.every(({ state }) => state === "MAPPED"), true);
  assert.equal(first.regions.every(({ mappedTargetCount }) => mappedTargetCount === 8), true);
  assert.equal(firstStore.attempts.length, 1);
  assert.equal(firstStore.attempts[0]?.state, "ALL_REGION_COMPLETE");
  assert.equal(firstStore.attempts[0]?.targets.length, 16);
  assert.equal(firstStore.generations.length, 1);
  assert.equal(firstStore.generations[0]?.targets.length, 16);
  assert.equal(firstStore.generations[0]?.coverage.rejectedRowCount, 16);
  assert.equal(first.attempt?.attemptId, firstStore.attempts[0]?.attemptId);
  assert.equal(first.generation?.generationId, firstStore.generations[0]?.generationId);
  assert.deepEqual(
    await verifyComputeOptimizerMaterializationRuntimeCheckpoint(
      source.activation,
      source.ready,
      first,
    ),
    first,
  );

  const replayStore = persistenceRecorder();
  const replay = await runComputeOptimizerMaterialization(
    source.activation,
    source.ready,
    source.runtimes,
    runtimeOptions(replayStore.persistence),
  );
  assert.deepEqual(replay, first);
  assert.equal(replayStore.attempts[0]?.attemptId, firstStore.attempts[0]?.attemptId);
  assert.equal(replayStore.generations[0]?.generationId, firstStore.generations[0]?.generationId);
});

test("stale fresh evidence blocks every object read and creates no generation attempt", async () => {
  const source = await runtimeFixture();
  let objectReads = 0;
  const runtimes = source.runtimes.map((runtime, index) => ({
    ...runtime,
    describeReader: index === 0
      ? describeReader(source.ready.planSet!.plans[index]!, (jobs) => {
        for (const job of jobs) {
          job.creationTimestamp = "2026-07-20T12:00:00.000Z";
          job.lastUpdatedTimestamp = "2026-07-20T12:15:00.000Z";
        }
      })
      : runtime.describeReader,
    objectReader: (async (...args: Parameters<ComputeOptimizerExportObjectReader>) => {
      objectReads += 1;
      return runtime.objectReader(...args);
    }) satisfies ComputeOptimizerExportObjectReader,
  }));
  const store = persistenceRecorder();
  const result = await runComputeOptimizerMaterialization(
    source.activation,
    source.ready,
    runtimes,
    runtimeOptions(store.persistence),
  );
  assert.equal(result.status, "FRESH_BLOCKED");
  assert.equal(result.regions[0]?.state, "FRESH_BLOCKED");
  assert.equal(result.regions[1]?.state, "FRESH_READY");
  assert.equal(objectReads, 0);
  assert.equal(store.attempts.length, 0);
  assert.equal(store.generations.length, 0);
});

test("fresh job or destination substitution is fail-closed before object loading", async () => {
  const source = await runtimeFixture();
  let objectReads = 0;
  const runtimes = source.runtimes.map((runtime, index) => ({
    ...runtime,
    describeReader: index === 1
      ? describeReader(source.ready.planSet!.plans[index]!, (jobs) => {
        const destination = jobs[0]?.destination as { s3: { key: string } };
        destination.s3.key = `${destination.s3.key}.substituted`;
      })
      : runtime.describeReader,
    objectReader: (async (...args: Parameters<ComputeOptimizerExportObjectReader>) => {
      objectReads += 1;
      return runtime.objectReader(...args);
    }) satisfies ComputeOptimizerExportObjectReader,
  }));
  const store = persistenceRecorder();
  const result = await runComputeOptimizerMaterialization(
    source.activation,
    source.ready,
    runtimes,
    runtimeOptions(store.persistence),
  );
  assert.equal(result.status, "FRESH_BLOCKED");
  assert.equal(result.regions[1]?.errorCode, "FRESH_RESOLUTION_FAILED");
  assert.equal(objectReads, 0);
  assert.equal(store.attempts.length, 0);
});

test("a missing sealed Region yields a resumable typed checkpoint without persistence", async () => {
  const source = await runtimeFixture();
  const store = persistenceRecorder();
  const result = await runComputeOptimizerMaterialization(
    source.activation,
    source.ready,
    source.runtimes.slice(0, 1),
    runtimeOptions(store.persistence),
  );
  assert.equal(result.status, "FRESH_BLOCKED");
  assert.equal(result.regions[0]?.state, "FRESH_READY");
  assert.equal(result.regions[1]?.state, "FRESH_BLOCKED");
  assert.equal(result.regions[1]?.errorCode, "RUNTIME_MISSING");
  assert.equal(store.attempts.length, 0);
  assert.deepEqual(
    await verifyComputeOptimizerMaterializationRuntimeCheckpoint(
      source.activation,
      source.ready,
      result,
    ),
    result,
  );
});

test("one Region object-integrity failure records only an immutable partial attempt", async () => {
  const source = await runtimeFixture();
  const failedRegion = source.runtimes[0]!;
  const originalReader = failedRegion.objectReader;
  const corruptReader: ComputeOptimizerExportObjectReader = async (...args) => {
    const result = await originalReader(...args);
    if (!args[2].endsWith("-metadata.json")) return result;
    const metadata = JSON.parse(new TextDecoder().decode(result.bytes)) as Record<string, unknown>;
    metadata.url = "substituted.csv";
    return { ...result, bytes: encoder.encode(JSON.stringify(metadata)) };
  };
  const runtimes = source.runtimes.map((runtime, index) => index === 0
    ? { ...runtime, objectReader: corruptReader }
    : runtime);
  const store = persistenceRecorder();
  const result = await runComputeOptimizerMaterialization(
    source.activation,
    source.ready,
    runtimes,
    runtimeOptions(store.persistence),
  );
  assert.equal(result.status, "PARTIAL_ATTEMPT_RECORDED");
  assert.equal(result.regions[0]?.state, "OBJECT_BLOCKED");
  assert.equal(result.regions[1]?.state, "MAPPED");
  assert.equal(store.attempts.length, 1);
  assert.equal(store.attempts[0]?.state, "PARTIAL");
  assert.equal(store.attempts[0]?.targets.length, 8);
  assert.equal(store.generations.length, 0);
});

test("valid CSVW with a substituted projection records a typed mapping-blocked attempt", async () => {
  const source = await runtimeFixture();
  const plan = source.ready.planSet!.plans[0]!;
  const target = plan.targets[0]!;
  const csvAddress = `${target.region}\0${target.expectedJob.bucket}\0${target.expectedJob.objectKey}`;
  const metadataAddress =
    `${target.region}\0${target.expectedJob.bucket}\0${target.expectedJob.metadataKey}`;
  const metadata = JSON.parse(new TextDecoder().decode(source.objectBytes.get(metadataAddress)!)) as {
    tableSchema: { columns: Array<{ name: string }> };
  };
  const oldName = metadata.tableSchema.columns[1]!.name;
  const newName = `${oldName}_substituted`;
  metadata.tableSchema.columns[1]!.name = newName;
  source.objectBytes.set(metadataAddress, encoder.encode(JSON.stringify(metadata)));
  const csv = new TextDecoder().decode(source.objectBytes.get(csvAddress)!);
  source.objectBytes.set(csvAddress, encoder.encode(csv.replace(oldName, newName)));

  const store = persistenceRecorder();
  const result = await runComputeOptimizerMaterialization(
    source.activation,
    source.ready,
    source.runtimes,
    runtimeOptions(store.persistence),
  );
  assert.equal(result.status, "PARTIAL_ATTEMPT_RECORDED");
  assert.equal(result.regions[0]?.state, "MAPPING_BLOCKED");
  assert.equal(result.regions[0]?.errorCode, "MAPPING_FAILED");
  assert.equal(result.regions[1]?.state, "MAPPED");
  assert.equal(store.attempts[0]?.state, "PARTIAL");
  assert.equal(store.generations.length, 0);
});

test("abort, deadline, persistence failure and Region expansion remain typed boundaries", async () => {
  const source = await runtimeFixture();
  const store = persistenceRecorder();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    runComputeOptimizerMaterialization(source.activation, source.ready, source.runtimes, {
      ...runtimeOptions(store.persistence),
      signal: controller.signal,
    }),
    code("ABORTED"),
  );
  await assert.rejects(
    runComputeOptimizerMaterialization(source.activation, source.ready, source.runtimes, {
      ...runtimeOptions(store.persistence),
      deadlineAtMs: RUNTIME_NOW,
    }),
    code("DEADLINE_EXCEEDED"),
  );
  await assert.rejects(
    runComputeOptimizerMaterialization(source.activation, source.ready, [
      ...source.runtimes,
      source.runtimes[0]!,
    ], runtimeOptions(store.persistence)),
    code("REGION_EXPANSION"),
  );
  await assert.rejects(
    runComputeOptimizerMaterialization(
      source.activation,
      source.ready,
      source.runtimes,
      runtimeOptions(persistenceRecorder(true).persistence),
    ),
    code("PERSISTENCE_FAILED"),
  );
});

test("runtime verifier rejects an impossible state even with a recomputed semantic hash", async () => {
  const source = await runtimeFixture();
  const store = persistenceRecorder();
  const accepted = await runComputeOptimizerMaterialization(
    source.activation,
    source.ready,
    source.runtimes,
    runtimeOptions(store.persistence),
  );
  const forged = structuredClone(accepted) as unknown as Record<string, unknown>;
  const regions = forged.regions as Array<Record<string, unknown>>;
  regions[0]!.state = "FRESH_READY";
  regions[0]!.mappedTargetCount = 0;
  const body = Object.fromEntries(Object.entries(forged).filter(([key]) =>
    key !== "checkpointId" && key !== "contentSha256"));
  const contentSha256 = await digest(canonicalJson(body));
  forged.contentSha256 = contentSha256;
  forged.checkpointId = `comrm_${contentSha256}`;
  await assert.rejects(
    verifyComputeOptimizerMaterializationRuntimeCheckpoint(
      source.activation,
      source.ready,
      forged,
    ),
    code("CHECKPOINT_INVALID"),
  );
});
