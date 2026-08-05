import assert from "node:assert/strict";
import test from "node:test";

import { COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG } from "../lib/finops-compute-optimizer-export-field-catalog.ts";
import type {
  MappedComputeOptimizerExportTarget,
  ComputeOptimizerMappedRecommendation,
} from "../lib/finops-compute-optimizer-export-mapper.ts";
import {
  ComputeOptimizerExportGenerationError,
  createComputeOptimizerExportGenerationAttempt as createAttemptRaw,
  finalizeComputeOptimizerExportGeneration as finalizeRaw,
  verifyComputeOptimizerExportGeneration as verifyRaw,
  type ComputeOptimizerExportGenerationLimits,
  type ComputeOptimizerExportGenerationOptions,
} from "../lib/finops-compute-optimizer-export-generation.ts";
import type {
  FreshComputeOptimizerExportBinding,
} from "../lib/finops-compute-optimizer-export-fresh-resolver.ts";
import {
  createComputeOptimizerExportPlanSet,
  type ComputeOptimizerExportPlanInput,
  type ComputeOptimizerExportPlanSet,
  type ComputeOptimizerExportPlanTarget,
  type ComputeOptimizerProviderExportJobResourceType,
} from "../lib/finops-compute-optimizer-export-plan.ts";

const CONNECTION = `conn_${"a".repeat(32)}`;
const ACCOUNT = "111122223333";
const REGIONS = ["ap-south-1", "us-east-1"] as const;
const FAMILIES = ["EC2_INSTANCE", "IDLE_RESOURCE"] as const;
const MATERIALIZED_AT_MS = Date.parse("2026-08-02T12:00:00.000Z");
const SCHEDULED_WINDOW = "2026-08-02T00:00:00.000Z";
const OPTIONS: ComputeOptimizerExportGenerationOptions = {
  scheduledWindow: SCHEDULED_WINDOW,
  materializedAtMs: MATERIALIZED_AT_MS,
};

const OPERATION = {
  EC2_INSTANCE: "ExportEC2InstanceRecommendations",
  IDLE_RESOURCE: "ExportIdleRecommendations",
} as const;

const PROVIDER: Readonly<Record<(typeof FAMILIES)[number], ComputeOptimizerProviderExportJobResourceType>> = {
  EC2_INSTANCE: "Ec2Instance",
  IDLE_RESOURCE: "Idle",
};

function planTarget(region: string, exportFamily: (typeof FAMILIES)[number]) {
  const bucket = `sutra-generation-${region}`;
  const effectivePrefix = `compute-optimizer/${ACCOUNT}/`;
  const token = `${region}-${exportFamily.toLowerCase().replaceAll("_", "-")}`;
  const jobId = `job-${token}`;
  const objectKey = `${effectivePrefix}${region}-2026-08-02T000000Z-${jobId}.csv`;
  return {
    region,
    exportFamily,
    bucket,
    optionalPrefix: null,
    effectivePrefix,
    request: {
      operation: OPERATION[exportFamily],
      region,
      fileFormat: "Csv" as const,
      includeMemberAccounts: true as const,
      filters: [] as const,
      fieldsToExport: COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[exportFamily].minimumProjection,
      s3DestinationConfig: { bucket, keyPrefix: null },
    },
    expectedJob: {
      jobId,
      providerResourceType: PROVIDER[exportFamily],
      bucket,
      objectKey,
      metadataKey: `${objectKey.slice(0, -4)}-metadata.json`,
    },
  };
}

function planInput(): ComputeOptimizerExportPlanInput {
  return {
    scope: { orgId: "org_alpha", customerId: "customer_alpha", connectionId: CONNECTION },
    requesterAccountId: ACCOUNT,
    partition: "aws",
    regions: REGIONS,
    exportFamilies: FAMILIES,
    targets: REGIONS.flatMap((region) => FAMILIES.map((family) => planTarget(region, family))),
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

function hexFor(value: string, suffix: string): string {
  let accumulator = 0;
  for (const character of `${value}:${suffix}`) accumulator = (accumulator * 33 + character.charCodeAt(0)) % 16;
  return accumulator.toString(16).repeat(64);
}

function recommendation(
  target: ComputeOptimizerExportPlanTarget,
  amountMicros = "9223372036854775807",
  percentageBasisPoints = 1_234,
): ComputeOptimizerMappedRecommendation {
  const token = `${target.region}-${target.exportFamily.toLowerCase()}`;
  return {
    rowNumber: 1,
    accountId: ACCOUNT,
    resourceArn: `arn:aws:ec2:${target.region}:${ACCOUNT}:instance/${token}`,
    resourceId: token,
    resourceIdSource: "ARN",
    region: target.region,
    exportFamily: target.exportFamily,
    findings: [],
    lastRefreshTimestamp: "2026-08-02 00:00:00",
    lookbackPeriodLexeme: "14",
    currentConfiguration: [],
    recommendedConfiguration: [],
    currentRisk: [],
    rankedOptions: [],
    savings: target.exportFamily === "IDLE_RESOURCE"
      ? [{
          scope: "RESOURCE",
          includesExistingDiscounts: false,
          normalizationState: "UNRESOLVED_PROVIDER_CSV_LABEL",
          apiField: "SavingsOpportunity",
          raw: "{\"estimatedMonthlySavings\":\"12.34\"}",
          evidence: {
            apiField: "SavingsOpportunity",
            column: "SavingsOpportunity",
            datatype: "string",
            raw: "{\"estimatedMonthlySavings\":\"12.34\"}",
            assurance: "API_FIELD_NAME_ONLY",
          },
        }]
      : [{
          scope: "RESOURCE",
          includesExistingDiscounts: false,
          normalizationState: "EXACT_DOCUMENTED_CSV_LABEL",
          currency: "USD",
          amountMicros,
          percentageBasisPoints,
          evidence: [],
        }],
    tags: [],
    rds: null,
  };
}

function mappedTarget(
  target: ComputeOptimizerExportPlanTarget,
  mode: "recommendation" | "error" = "recommendation",
): MappedComputeOptimizerExportTarget {
  const csvSha256 = hexFor(`${target.region}:${target.exportFamily}`, "csv");
  const metadataSha256 = hexFor(`${target.region}:${target.exportFamily}`, "metadata");
  const mappedRecommendation = recommendation(target);
  return {
    schemaVersion: "sutra.compute-optimizer-export-mapped-target.v1",
    source: {
      region: target.region,
      exportFamily: target.exportFamily,
      providerResourceType: target.expectedJob.providerResourceType,
      requestSha256: target.requestSha256,
      jobId: target.expectedJob.jobId,
      bucket: target.expectedJob.bucket,
      csvObject: {
        key: target.expectedJob.objectKey,
        eTag: `etag-${target.expectedJob.jobId}`,
        versionId: `version-${target.expectedJob.jobId}`,
        bytes: 100,
        sha256: csvSha256,
      },
      metadataObject: {
        key: target.expectedJob.metadataKey,
        eTag: `etag-metadata-${target.expectedJob.jobId}`,
        versionId: null,
        bytes: 20,
        sha256: metadataSha256,
      },
      csvBasename: target.expectedJob.objectKey.slice(target.expectedJob.objectKey.lastIndexOf("/") + 1),
      csvSha256,
      metadataSha256,
      modifiedDate: "2026-08-02",
    },
    schemaAssurance: target.exportFamily === "IDLE_RESOURCE"
      ? "API_FIELD_NAME_ONLY_UNVERIFIED"
      : "OFFICIAL_USER_GUIDE_CSV_LABELS",
    rowCount: 1,
    recommendationCount: mode === "recommendation" ? 1 : 0,
    rejectedRowCount: mode === "error" ? 1 : 0,
    recommendations: mode === "recommendation" ? [mappedRecommendation] : [],
    rejectedRows: mode === "error"
      ? [{
          rowNumber: 1,
          errorCode: "OptInRequired",
          errorMessage: "Member account is not enrolled",
          accountId: ACCOUNT,
          resourceArn: null,
        }]
      : [],
  };
}

async function fixture(mode: "recommendation" | "error" = "recommendation"): Promise<{
  planSet: ComputeOptimizerExportPlanSet;
  targets: MappedComputeOptimizerExportTarget[];
}> {
  const planSet = await createComputeOptimizerExportPlanSet(planInput());
  return {
    planSet,
    targets: planSet.plans.flatMap((plan) => plan.targets.map((target) => mappedTarget(target, mode))),
  };
}

function freshBindingsFor(planSet: ComputeOptimizerExportPlanSet): FreshComputeOptimizerExportBinding[] {
  return planSet.plans.map((plan, planIndex) => {
    const resolvedAtMs = Date.parse(planIndex === 0
      ? "2026-08-02T11:57:00.000Z"
      : "2026-08-02T11:58:00.000Z");
    return {
      schemaVersion: "sutra.compute-optimizer-export-fresh-binding.v1",
      discoveryRunId: `cor_${hexFor(plan.regions[0]!, "run")}`,
      resolvedAtIso: new Date(resolvedAtMs).toISOString(),
      expiresAtIso: new Date(resolvedAtMs + 5 * 60 * 1_000).toISOString(),
      binding: {
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
      },
      jobChronology: plan.targets.map((target, targetIndex) => ({
        jobId: target.expectedJob.jobId,
        creationTimestampIso: `2026-08-01T0${planIndex}:0${targetIndex}:00.000Z`,
        lastUpdatedTimestampIso: planIndex === 0
          ? `2026-08-02T10:${targetIndex === 0 ? "30" : "45"}:00.000Z`
          : `2026-08-02T10:${targetIndex === 0 ? "50" : "55"}:00.000Z`,
      })),
    };
  });
}

function withOptions(
  overrides: Partial<ComputeOptimizerExportGenerationOptions> = {},
): ComputeOptimizerExportGenerationOptions {
  return { ...OPTIONS, ...overrides };
}

function finalizeComputeOptimizerExportGeneration(
  planSet: ComputeOptimizerExportPlanSet,
  targets: readonly MappedComputeOptimizerExportTarget[],
  options: Partial<ComputeOptimizerExportGenerationOptions> = {},
) {
  return finalizeRaw(planSet, targets, freshBindingsFor(planSet), withOptions(options));
}

function createComputeOptimizerExportGenerationAttempt(
  planSet: ComputeOptimizerExportPlanSet,
  targets: readonly MappedComputeOptimizerExportTarget[],
  options: Partial<ComputeOptimizerExportGenerationOptions> = {},
) {
  return createAttemptRaw(planSet, targets, freshBindingsFor(planSet), withOptions(options));
}

function verifyComputeOptimizerExportGeneration(
  planSet: ComputeOptimizerExportPlanSet,
  value: unknown,
  options: Partial<ComputeOptimizerExportGenerationOptions> = {},
) {
  return verifyRaw(planSet, value, withOptions(options));
}

async function rejects(
  promise: Promise<unknown>,
  code: ComputeOptimizerExportGenerationError["code"],
): Promise<void> {
  await assert.rejects(
    promise,
    (error: unknown) => error instanceof ComputeOptimizerExportGenerationError && error.code === code,
  );
}

test("finalizes exact all-Region coverage deterministically and retains complete evidence", async () => {
  const { planSet, targets } = await fixture();
  const first = await finalizeComputeOptimizerExportGeneration(planSet, [...targets].reverse());
  const second = await finalizeComputeOptimizerExportGeneration(planSet, targets);
  assert.deepEqual(first, second);
  assert.equal(first.generationId, `cog_${first.contentSha256}`);
  assert.equal(first.state, "ALL_REGION_ACCEPTED");
  assert.equal(first.acceptedHeadEligible, true);
  assert.deepEqual(first.missingTargets, []);
  assert.equal(first.scheduledWindow, SCHEDULED_WINDOW);
  assert.equal(first.materializedAtIso, "2026-08-02T12:00:00.000Z");
  assert.equal(first.dataThroughAtIso, "2026-08-02T10:30:00.000Z");
  assert.equal(first.observedAtIso, "2026-08-02T11:58:00.000Z");
  assert.deepEqual(first.freshBindings.map((binding) => binding.binding.planId), planSet.planIds);
  assert.deepEqual(first.coverage, {
    expectedTargetCount: 4,
    mappedTargetCount: 4,
    rowCount: 4,
    recommendationCount: 4,
    rejectedRowCount: 0,
    sourceBytes: 480,
  });
  assert.deepEqual(first.targets.map((target) => [target.source.region, target.source.exportFamily]), [
    ["ap-south-1", "EC2_INSTANCE"],
    ["ap-south-1", "IDLE_RESOURCE"],
    ["us-east-1", "EC2_INSTANCE"],
    ["us-east-1", "IDLE_RESOURCE"],
  ]);
  assert.deepEqual(first.schemaAssurances, [
    "API_FIELD_NAME_ONLY_UNVERIFIED",
    "OFFICIAL_USER_GUIDE_CSV_LABELS",
  ]);
  assert.deepEqual(first.unresolvedEvidence, {
    targetCount: 2,
    savingsChannelCount: 2,
    targetKeys: [
      { region: "ap-south-1", exportFamily: "IDLE_RESOURCE" },
      { region: "us-east-1", exportFamily: "IDLE_RESOURCE" },
    ],
  });
  assert.equal(
    first.targets[0]!.recommendations[0]!.savings[0]!.normalizationState,
    "EXACT_DOCUMENTED_CSV_LABEL",
  );
  assert.equal(
    (first.targets[0]!.recommendations[0]!.savings[0] as { amountMicros: string }).amountMicros,
    "9223372036854775807",
  );
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.targets[0]!.recommendations[0]!.savings[0]), true);
  assert.deepEqual(await verifyComputeOptimizerExportGeneration(planSet, structuredClone(first)), first);
});

test("mixed-Region chronology is plan-ordered while freshness uses timestamp extrema", async () => {
  const { planSet, targets } = await fixture();
  const bindings = freshBindingsFor(planSet);
  const changed = mutable(bindings);
  changed[0]!.jobChronology[0]!.lastUpdatedTimestampIso = "2026-08-02T11:20:00.000Z";
  changed[0]!.jobChronology[1]!.lastUpdatedTimestampIso = "2026-08-02T10:40:00.000Z";
  changed[1]!.jobChronology[0]!.lastUpdatedTimestampIso = "2026-08-02T11:10:00.000Z";
  changed[1]!.jobChronology[1]!.lastUpdatedTimestampIso = "2026-08-02T10:50:00.000Z";
  const generation = await finalizeRaw(
    planSet,
    [...targets].reverse(),
    [...changed].reverse(),
    OPTIONS,
  );
  assert.deepEqual(generation.freshBindings.map((binding) => binding.binding.planId), planSet.planIds);
  assert.equal(generation.dataThroughAtIso, "2026-08-02T10:40:00.000Z");
  assert.equal(generation.observedAtIso, "2026-08-02T11:58:00.000Z");
  assert.deepEqual(generation.freshBindings[0]!.jobChronology.map(({ jobId }) => jobId),
    planSet.plans[0]!.targets.map(({ expectedJob }) => expectedJob.jobId));
});

test("records partial and complete attempts as permanently ineligible evidence", async () => {
  const { planSet, targets } = await fixture();
  const partial = await createComputeOptimizerExportGenerationAttempt(planSet, targets.slice(0, 3));
  assert.equal(partial.state, "PARTIAL");
  assert.equal(partial.acceptedHeadEligible, false);
  assert.equal(partial.attemptId, `coa_${partial.contentSha256}`);
  assert.deepEqual(partial.missingTargets, [
    { region: "us-east-1", exportFamily: "IDLE_RESOURCE" },
  ]);
  const complete = await createComputeOptimizerExportGenerationAttempt(planSet, targets);
  assert.equal(complete.state, "ALL_REGION_COMPLETE");
  assert.equal(complete.acceptedHeadEligible, false);
  assert.deepEqual(complete.missingTargets, []);
  assert.notEqual(complete.contentSha256, partial.contentSha256);
});

test("never finalizes a partial matrix and rejects duplicate or extra pairs", async () => {
  const { planSet, targets } = await fixture();
  await rejects(finalizeComputeOptimizerExportGeneration(planSet, targets.slice(0, 3)), "INCOMPLETE_COVERAGE");
  await rejects(
    finalizeComputeOptimizerExportGeneration(planSet, [...targets, structuredClone(targets[0]!)]),
    "DUPLICATE_TARGET",
  );
  const extra = mutable(targets[0]!);
  extra.source.region = "eu-west-1";
  await rejects(createComputeOptimizerExportGenerationAttempt(planSet, [extra]), "TARGET_SUBSTITUTION");
});

test("re-binds request, job, resource type, bucket and object identities to the verified plan", async (context) => {
  const { planSet, targets } = await fixture();
  const mutations: readonly [string, (target: DeepMutable<MappedComputeOptimizerExportTarget>) => void, ComputeOptimizerExportGenerationError["code"]][] = [
    ["request hash", (target) => { target.source.requestSha256 = "f".repeat(64); }, "TARGET_SUBSTITUTION"],
    ["job", (target) => { target.source.jobId = "job-substitution"; }, "TARGET_SUBSTITUTION"],
    ["resource type", (target) => { target.source.providerResourceType = "Idle"; }, "TARGET_SUBSTITUTION"],
    ["bucket", (target) => { target.source.bucket = "substituted-bucket"; }, "TARGET_SUBSTITUTION"],
    ["CSV key", (target) => { target.source.csvObject.key += ".substituted"; }, "OBJECT_SUBSTITUTION"],
    ["metadata key", (target) => { target.source.metadataObject.key += ".substituted"; }, "OBJECT_SUBSTITUTION"],
    ["CSV digest", (target) => { target.source.csvSha256 = "e".repeat(64); }, "OBJECT_SUBSTITUTION"],
    ["metadata digest", (target) => { target.source.metadataSha256 = "e".repeat(64); }, "OBJECT_SUBSTITUTION"],
    ["basename", (target) => { target.source.csvBasename = "other.csv"; }, "OBJECT_SUBSTITUTION"],
  ];
  for (const [name, mutate, code] of mutations) {
    await context.test(name, async () => {
      const changed = mutable(targets);
      mutate(changed[0]!);
      await rejects(finalizeComputeOptimizerExportGeneration(planSet, changed), code);
    });
  }
});

test("rejects missing, overlapping, out-of-range and non-canonical row evidence", async (context) => {
  const { planSet, targets } = await fixture();
  const mutations: readonly [string, (target: DeepMutable<MappedComputeOptimizerExportTarget>) => void][] = [
    ["count mismatch", (target) => { target.rowCount = 2; }],
    ["out of range", (target) => { target.recommendations[0]!.rowNumber = 2; }],
    ["overlap", (target) => {
      target.rejectedRows = [{ rowNumber: 1, errorCode: "Error", errorMessage: "error", accountId: ACCOUNT, resourceArn: null }];
      target.rejectedRowCount = 1;
      target.rowCount = 2;
    }],
    ["unsafe count", (target) => { target.rowCount = Number.MAX_SAFE_INTEGER + 1; }],
  ];
  for (const [name, mutate] of mutations) {
    await context.test(name, async () => {
      const changed = mutable(targets);
      mutate(changed[0]!);
      await rejects(finalizeComputeOptimizerExportGeneration(planSet, changed), "ROW_EVIDENCE_INVALID");
    });
  }
});

test("preserves intentional cross-family overlap but rejects duplicate rows within one target", async () => {
  const { planSet, targets } = await fixture();
  const overlap = mutable(targets);
  overlap[1]!.recommendations[0]!.accountId = overlap[0]!.recommendations[0]!.accountId;
  overlap[1]!.recommendations[0]!.resourceArn = overlap[0]!.recommendations[0]!.resourceArn;
  overlap[1]!.recommendations[0]!.resourceId = overlap[0]!.recommendations[0]!.resourceId;
  const accepted = await finalizeComputeOptimizerExportGeneration(planSet, overlap);
  assert.equal(accepted.coverage.recommendationCount, 4);

  const duplicate = mutable(targets);
  const second = structuredClone(duplicate[0]!.recommendations[0]!);
  second.rowNumber = 2;
  duplicate[0]!.recommendations.push(second);
  duplicate[0]!.recommendationCount = 2;
  duplicate[0]!.rowCount = 2;
  await rejects(finalizeComputeOptimizerExportGeneration(planSet, duplicate), "DUPLICATE_RESOURCE");
});

test("re-validates ARN tenancy, Region binding, schema assurance and per-object byte ceilings", async (context) => {
  const { planSet, targets } = await fixture();
  const mutations: readonly [string, (target: DeepMutable<MappedComputeOptimizerExportTarget>) => void][] = [
    ["ARN account", (target) => {
      target.recommendations[0]!.resourceArn = target.recommendations[0]!.resourceArn.replace(
        ACCOUNT,
        "999900001111",
      );
    }],
    ["ARN Region", (target) => {
      target.recommendations[0]!.resourceArn = target.recommendations[0]!.resourceArn.replace(
        target.source.region,
        "eu-west-1",
      );
    }],
    ["ARN partition", (target) => {
      target.recommendations[0]!.resourceArn = target.recommendations[0]!.resourceArn.replace(
        "arn:aws:",
        "arn:aws-cn:",
      );
    }],
    ["CSV byte ceiling", (target) => { target.source.csvObject.bytes = 256 * 1_024 * 1_024 + 1; }],
    ["metadata byte ceiling", (target) => { target.source.metadataObject.bytes = 1 * 1_024 * 1_024 + 1; }],
  ];
  for (const [name, mutate] of mutations) {
    await context.test(name, async () => {
      const changed = mutable(targets);
      mutate(changed[0]!);
      await rejects(finalizeComputeOptimizerExportGeneration(planSet, changed), "ROW_EVIDENCE_INVALID");
    });
  }
  const changedAssurance = mutable(targets);
  changedAssurance[1]!.schemaAssurance = "OFFICIAL_USER_GUIDE_CSV_LABELS";
  await rejects(
    finalizeComputeOptimizerExportGeneration(planSet, changedAssurance),
    "ROW_EVIDENCE_INVALID",
  );
});

test("preserves signed 64-bit micros and integer basis points and rejects float-like evidence", async (context) => {
  const { planSet, targets } = await fixture();
  const valid = mutable(targets);
  const savings = valid[0]!.recommendations[0]!.savings[0] as DeepMutable<{
    amountMicros: string;
    percentageBasisPoints: number;
  }>;
  savings.amountMicros = "-9223372036854775808";
  savings.percentageBasisPoints = 10_000;
  const generation = await finalizeComputeOptimizerExportGeneration(planSet, valid);
  const retained = generation.targets[0]!.recommendations[0]!.savings[0] as {
    amountMicros: string;
    percentageBasisPoints: number;
  };
  assert.equal(retained.amountMicros, "-9223372036854775808");
  assert.equal(retained.percentageBasisPoints, 10_000);

  const invalid: readonly [string, string | number][] = [
    ["leading zero", "01"],
    ["negative zero", "-0"],
    ["decimal", "1.5"],
    ["overflow", "9223372036854775808"],
    ["basis point fraction", 1.5],
    ["basis point overflow", 10_001],
  ];
  for (const [name, value] of invalid) {
    await context.test(name, async () => {
      const changed = mutable(targets);
      const channel = changed[0]!.recommendations[0]!.savings[0] as DeepMutable<{
        amountMicros: string;
        percentageBasisPoints: number;
      }>;
      if (typeof value === "string") channel.amountMicros = value;
      else channel.percentageBasisPoints = value;
      await rejects(finalizeComputeOptimizerExportGeneration(planSet, changed), "NUMERIC_EVIDENCE_INVALID");
    });
  }
});

test("enforces target, row, recommendation, error, source-byte and serialized-byte limits", async (context) => {
  const recommended = await fixture();
  const rejected = await fixture("error");
  const cases: readonly [
    string,
    ComputeOptimizerExportPlanSet,
    MappedComputeOptimizerExportTarget[],
    Partial<ComputeOptimizerExportGenerationLimits>,
  ][] = [
    ["targets", recommended.planSet, recommended.targets, { maximumTargets: 3 }],
    ["rows", recommended.planSet, recommended.targets, { maximumAggregateRows: 3 }],
    ["recommendations", recommended.planSet, recommended.targets, { maximumRecommendations: 3 }],
    ["errors", rejected.planSet, rejected.targets, { maximumRejectedRows: 3 }],
    ["source bytes", recommended.planSet, recommended.targets, { maximumAggregateSourceBytes: 479 }],
    ["serialized bytes", recommended.planSet, recommended.targets, { maximumSerializedBytes: 100 }],
  ];
  for (const [name, planSet, targets, limits] of cases) {
    await context.test(name, async () => {
      await rejects(
        finalizeComputeOptimizerExportGeneration(planSet, targets, { limits }),
        "LIMIT_EXCEEDED",
      );
    });
  }
  await rejects(
    finalizeComputeOptimizerExportGeneration(recommended.planSet, recommended.targets, {
      limits: { maximumRecommendations: 0 },
    }),
    "INVALID_INPUT",
  );
});

test("rejects plan-set tampering, unknown evidence keys and malformed object identity", async () => {
  const { planSet, targets } = await fixture();
  const changedPlan = mutable(planSet);
  changedPlan.contentSha256 = "f".repeat(64);
  await rejects(
    finalizeComputeOptimizerExportGeneration(changedPlan as unknown as ComputeOptimizerExportPlanSet, targets),
    "PLAN_SET_INVALID",
  );

  const unknown = mutable(targets) as unknown as Array<Record<string, unknown>>;
  unknown[0]!.invented = true;
  await rejects(
    finalizeComputeOptimizerExportGeneration(planSet, unknown as unknown as MappedComputeOptimizerExportTarget[]),
    "ROW_EVIDENCE_INVALID",
  );

  const badObject = mutable(targets);
  badObject[0]!.source.csvObject.bytes = 0;
  await rejects(finalizeComputeOptimizerExportGeneration(planSet, badObject), "ROW_EVIDENCE_INVALID");
});

test("requires exactly one non-replayed fresh binding for every regional plan", async () => {
  const { planSet, targets } = await fixture();
  const bindings = freshBindingsFor(planSet);
  await rejects(
    finalizeRaw(planSet, targets, bindings.slice(0, 1), OPTIONS),
    "MISSING_FRESH_BINDING",
  );

  const repeatedPlan = [bindings[0]!, structuredClone(bindings[0]!)];
  await rejects(
    finalizeRaw(planSet, targets, repeatedPlan, OPTIONS),
    "DUPLICATE_FRESH_BINDING",
  );

  const replayedRun = mutable(bindings);
  replayedRun[1]!.discoveryRunId = replayedRun[0]!.discoveryRunId;
  await rejects(
    finalizeRaw(planSet, targets, replayedRun, OPTIONS),
    "DUPLICATE_FRESH_BINDING",
  );

  const invalidRun = mutable(bindings);
  invalidRun[0]!.discoveryRunId = "cor_not-canonical";
  await rejects(
    finalizeRaw(planSet, targets, invalidRun, OPTIONS),
    "FRESH_BINDING_INVALID",
  );
});

test("rejects cross-plan, missing, reordered and stale job chronology", async (context) => {
  const { planSet, targets } = await fixture();
  const mutations: readonly [
    string,
    (bindings: DeepMutable<FreshComputeOptimizerExportBinding[]>) => void,
    ComputeOptimizerExportGenerationError["code"],
  ][] = [
    ["cross-plan plan identity", (bindings) => {
      bindings[0]!.binding.planId = bindings[1]!.binding.planId;
      bindings[0]!.binding.contentSha256 = bindings[1]!.binding.contentSha256;
    }, "CHRONOLOGY_INVALID"],
    ["missing chronology row", (bindings) => { bindings[0]!.jobChronology.pop(); }, "CHRONOLOGY_INVALID"],
    ["reordered chronology", (bindings) => { bindings[0]!.jobChronology.reverse(); }, "CHRONOLOGY_INVALID"],
    ["cross-plan target", (bindings) => {
      bindings[0]!.binding.targets[0]!.requestSha256 = bindings[1]!.binding.targets[0]!.requestSha256;
    }, "CHRONOLOGY_INVALID"],
    ["non-canonical timestamp", (bindings) => {
      bindings[0]!.jobChronology[0]!.lastUpdatedTimestampIso = "2026-08-02 10:30:00Z";
    }, "CHRONOLOGY_INVALID"],
    ["update precedes creation", (bindings) => {
      bindings[0]!.jobChronology[0]!.lastUpdatedTimestampIso = "2026-07-31T23:59:59.999Z";
    }, "CHRONOLOGY_INVALID"],
    ["seven-day visibility replay", (bindings) => {
      bindings[0]!.jobChronology[0]!.creationTimestampIso = "2026-07-26T00:00:00.000Z";
    }, "CHRONOLOGY_INVALID"],
  ];
  for (const [name, mutate, code] of mutations) {
    await context.test(name, async () => {
      const changed = mutable(freshBindingsFor(planSet));
      mutate(changed);
      await rejects(finalizeRaw(planSet, targets, changed, OPTIONS), code);
    });
  }
});

test("expiry is exclusive at materialization and one millisecond before remains valid", async () => {
  const { planSet, targets } = await fixture();
  const bindings = mutable(freshBindingsFor(planSet));
  for (const binding of bindings) binding.expiresAtIso = "2026-08-02T12:00:00.000Z";
  await rejects(
    finalizeRaw(planSet, targets, bindings, OPTIONS),
    "FRESH_BINDING_EXPIRED",
  );
  const accepted = await finalizeRaw(planSet, targets, bindings, {
    ...OPTIONS,
    materializedAtMs: MATERIALIZED_AT_MS - 1,
  });
  assert.equal(accepted.materializedAtIso, "2026-08-02T11:59:59.999Z");

  const futureBinding = mutable(freshBindingsFor(planSet));
  futureBinding[0]!.resolvedAtIso = "2026-08-02T12:00:00.001Z";
  futureBinding[0]!.expiresAtIso = "2026-08-02T12:05:00.001Z";
  await rejects(
    finalizeRaw(planSet, targets, futureBinding, OPTIONS),
    "CHRONOLOGY_INVALID",
  );
});

test("requires a caller-owned safe materialization clock and canonical daily scheduled window", async () => {
  const { planSet, targets } = await fixture();
  const bindings = freshBindingsFor(planSet);
  for (const options of [
    { ...OPTIONS, materializedAtMs: Number.NaN },
    { ...OPTIONS, materializedAtMs: -1 },
    { ...OPTIONS, scheduledWindow: "2026-08-02T01:00:00.000Z" },
    { ...OPTIONS, scheduledWindow: "2026-08-02 00:00:00Z" },
    { ...OPTIONS, scheduledWindow: "2026-02-30T00:00:00.000Z" },
  ]) await rejects(finalizeRaw(planSet, targets, bindings, options), "INVALID_INPUT");
});

test("verification detects any accepted-generation identity or evidence mutation", async () => {
  const { planSet, targets } = await fixture();
  const generation = await finalizeComputeOptimizerExportGeneration(planSet, targets);
  const changedHash = mutable(generation);
  changedHash.contentSha256 = "f".repeat(64);
  await rejects(verifyComputeOptimizerExportGeneration(planSet, changedHash), "CONTENT_HASH_MISMATCH");

  const changedEvidence = mutable(generation);
  const channel = changedEvidence.targets[0]!.recommendations[0]!.savings[0] as DeepMutable<{
    amountMicros: string;
  }>;
  channel.amountMicros = "123";
  await rejects(verifyComputeOptimizerExportGeneration(planSet, changedEvidence), "CONTENT_HASH_MISMATCH");

  const changedChronology = mutable(generation);
  changedChronology.freshBindings[0]!.jobChronology[0]!.lastUpdatedTimestampIso =
    "2026-08-02T10:31:00.000Z";
  await rejects(
    verifyComputeOptimizerExportGeneration(planSet, changedChronology),
    "CONTENT_HASH_MISMATCH",
  );
});
