import assert from "node:assert/strict";
import test from "node:test";

import { COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG } from
  "../lib/finops-compute-optimizer-export-field-catalog.ts";
import {
  finalizeComputeOptimizerExportGeneration,
  type ComputeOptimizerExportGeneration,
} from "../lib/finops-compute-optimizer-export-generation.ts";
import type {
  ComputeOptimizerMappedRecommendation,
  MappedComputeOptimizerExportTarget,
} from "../lib/finops-compute-optimizer-export-mapper.ts";
import {
  createComputeOptimizerExportPlanSet,
  type ComputeOptimizerExportPlanTarget,
} from "../lib/finops-compute-optimizer-export-plan.ts";
import type { FreshComputeOptimizerExportBinding } from
  "../lib/finops-compute-optimizer-export-fresh-resolver.ts";
import {
  buildComputeOptimizerExactDashboard,
  ComputeOptimizerExactDashboardError,
} from "../lib/finops-compute-optimizer-exact-dashboard.ts";
import {
  ComputeOptimizerExactClientError,
  parseComputeOptimizerExactApiPayload,
} from "../lib/finops-compute-optimizer-exact-client.ts";
import { FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION } from
  "../lib/finops-compute-optimizer-official-definition.ts";

const SCOPE = { organizationId: "org_alpha", customerId: "customer_alpha", connectionId: `conn_${"a".repeat(32)}` };
const ACCOUNT = "111122223333";
const REGION = "us-east-1";
const MATERIALIZED = Date.parse("2026-08-02T12:00:00.000Z");
const WINDOW = "2026-08-02T00:00:00.000Z";

type DeepMutable<T> = T extends readonly (infer U)[] ? DeepMutable<U>[]
  : T extends object ? { -readonly [K in keyof T]: DeepMutable<T[K]> } : T;

function hex(value: string): string {
  let accumulator = 0;
  for (const character of value) accumulator = (accumulator * 33 + character.charCodeAt(0)) % 16;
  return accumulator.toString(16).repeat(64);
}

function planTarget(family: "EC2_INSTANCE" | "IDLE_RESOURCE") {
  const jobId = `job-${family.toLowerCase().replaceAll("_", "-")}`;
  const basename = `${REGION}-2026-08-02T000000Z-${jobId}.csv`;
  const bucket = "sutra-dashboard-us-east-1";
  return {
    region: REGION,
    exportFamily: family,
    bucket,
    optionalPrefix: null,
    effectivePrefix: `compute-optimizer/${ACCOUNT}/`,
    request: {
      operation: family === "EC2_INSTANCE" ? "ExportEC2InstanceRecommendations" as const : "ExportIdleRecommendations" as const,
      region: REGION,
      fileFormat: "Csv" as const,
      includeMemberAccounts: true as const,
      filters: [] as const,
      fieldsToExport: COMPUTE_OPTIMIZER_EXPORT_FIELD_CATALOG[family].minimumProjection,
      s3DestinationConfig: { bucket, keyPrefix: null },
    },
    expectedJob: {
      jobId,
      providerResourceType: family === "EC2_INSTANCE" ? "Ec2Instance" as const : "Idle" as const,
      bucket,
      objectKey: `compute-optimizer/${ACCOUNT}/${basename}`,
      metadataKey: `compute-optimizer/${ACCOUNT}/${basename.slice(0, -4)}-metadata.json`,
    },
  };
}

function recommendation(target: ComputeOptimizerExportPlanTarget, rowNumber: number,
  finding: string, amountMicros: string | null): ComputeOptimizerMappedRecommendation {
  const resourceId = `${target.exportFamily.toLowerCase()}-${rowNumber}`;
  return {
    rowNumber,
    accountId: ACCOUNT,
    resourceArn: `arn:aws:ec2:${REGION}:${ACCOUNT}:instance/${resourceId}`,
    resourceId,
    resourceIdSource: "ARN",
    region: REGION,
    exportFamily: target.exportFamily,
    findings: [{
      scope: "RESOURCE",
      finding: { apiField: "Finding", column: "Finding", datatype: "string", raw: finding, assurance: "USER_GUIDE_CSV_LABEL" },
      reasons: [],
    }],
    lastRefreshTimestamp: "2026-08-02 00:00:00",
    lookbackPeriodLexeme: "14",
    currentConfiguration: target.exportFamily === "EC2_INSTANCE" ? [{
      apiField: "CurrentInstanceType", column: "currentInstanceType", datatype: "string",
      raw: "m5.large", assurance: "USER_GUIDE_CSV_LABEL",
    }] : [],
    recommendedConfiguration: [],
    currentRisk: [],
    rankedOptions: target.exportFamily === "EC2_INSTANCE" ? [{
      rank: 1,
      configuration: [{
        apiField: "RecommendationOptionsInstanceType",
        column: "recommendationOptions_1_instanceType",
        datatype: "string",
        raw: rowNumber === 1 ? "m7g.large" : "m5.xlarge",
        assurance: "USER_GUIDE_CSV_LABEL",
      }],
      risk: null,
    }] : [],
    savings: amountMicros === null ? [{
      scope: "RESOURCE",
      includesExistingDiscounts: false,
      normalizationState: "UNRESOLVED_PROVIDER_CSV_LABEL",
      apiField: "SavingsOpportunity",
      raw: '{"estimatedMonthlySavings":"999999999999.99"}',
      evidence: { apiField: "SavingsOpportunity", column: "SavingsOpportunity", datatype: "string", raw: '{"estimatedMonthlySavings":"999999999999.99"}', assurance: "API_FIELD_NAME_ONLY" },
    }] : [{
      scope: "RESOURCE",
      includesExistingDiscounts: false,
      normalizationState: "EXACT_DOCUMENTED_CSV_LABEL",
      currency: rowNumber === 1 ? "USD" : "EUR",
      amountMicros,
      percentageBasisPoints: 1_000,
      evidence: [],
    }, ...(rowNumber === 1 && target.exportFamily === "EC2_INSTANCE" ? [{
      scope: "RESOURCE" as const,
      includesExistingDiscounts: true,
      normalizationState: "EXACT_DOCUMENTED_CSV_LABEL" as const,
      currency: "USD",
      amountMicros: "1000000",
      percentageBasisPoints: 500,
      evidence: [],
    }] : [])],
    tags: [{ key: "BusinessUnit", value: rowNumber === 1 ? "Payments" : "Analytics", column: "tags_BusinessUnit", assurance: "CSVW_NAME_AND_TITLE" }],
    rds: null,
  };
}

async function fixture(): Promise<{ planSet: Awaited<ReturnType<typeof createComputeOptimizerExportPlanSet>>; generation: ComputeOptimizerExportGeneration }> {
  const planSet = await createComputeOptimizerExportPlanSet({
    scope: { orgId: SCOPE.organizationId, customerId: SCOPE.customerId, connectionId: SCOPE.connectionId },
    requesterAccountId: ACCOUNT,
    partition: "aws",
    regions: [REGION],
    exportFamilies: ["EC2_INSTANCE", "IDLE_RESOURCE"],
    targets: [planTarget("EC2_INSTANCE"), planTarget("IDLE_RESOURCE")],
  });
  const plan = planSet.plans[0]!;
  const targets: MappedComputeOptimizerExportTarget[] = plan.targets.map((target) => {
    const recommendations = target.exportFamily === "EC2_INSTANCE"
      ? [recommendation(target, 1, "Underprovisioned", "9223372036854775807"), recommendation(target, 2, "Overprovisioned", "9007199254740993")]
      : [recommendation(target, 1, "Idle", null)];
    const csvSha = hex(`${target.exportFamily}:csv`);
    const metadataSha = hex(`${target.exportFamily}:metadata`);
    return {
      schemaVersion: "sutra.compute-optimizer-export-mapped-target.v1",
      source: {
        region: REGION,
        exportFamily: target.exportFamily,
        providerResourceType: target.expectedJob.providerResourceType,
        requestSha256: target.requestSha256,
        jobId: target.expectedJob.jobId,
        bucket: target.expectedJob.bucket,
        csvObject: { key: target.expectedJob.objectKey, eTag: "etag", versionId: "version-1", bytes: 100, sha256: csvSha },
        metadataObject: { key: target.expectedJob.metadataKey, eTag: "etag-meta", versionId: null, bytes: 20, sha256: metadataSha },
        csvBasename: target.expectedJob.objectKey.slice(target.expectedJob.objectKey.lastIndexOf("/") + 1),
        csvSha256: csvSha,
        metadataSha256: metadataSha,
        modifiedDate: "2026-08-02",
      },
      schemaAssurance: target.exportFamily === "IDLE_RESOURCE" ? "API_FIELD_NAME_ONLY_UNVERIFIED" : "OFFICIAL_USER_GUIDE_CSV_LABELS",
      rowCount: recommendations.length,
      recommendationCount: recommendations.length,
      rejectedRowCount: 0,
      recommendations,
      rejectedRows: [],
    };
  });
  const fresh: FreshComputeOptimizerExportBinding = {
    schemaVersion: "sutra.compute-optimizer-export-fresh-binding.v1",
    discoveryRunId: `cor_${hex("run")}`,
    resolvedAtIso: "2026-08-02T11:58:00.000Z",
    expiresAtIso: "2026-08-02T12:03:00.000Z",
    binding: {
      planId: plan.planId,
      contentSha256: plan.contentSha256,
      targets: plan.targets.map((target) => ({ region: target.region, exportFamily: target.exportFamily,
        providerResourceType: target.expectedJob.providerResourceType, requestSha256: target.requestSha256,
        jobId: target.expectedJob.jobId, bucket: target.expectedJob.bucket,
        objectKey: target.expectedJob.objectKey, metadataKey: target.expectedJob.metadataKey })),
    },
    jobChronology: plan.targets.map((target, index) => ({ jobId: target.expectedJob.jobId,
      creationTimestampIso: `2026-08-02T09:0${index}:00.000Z`,
      lastUpdatedTimestampIso: `2026-08-02T10:0${index}:00.000Z` })),
  };
  const generation = await finalizeComputeOptimizerExportGeneration(planSet, targets, [fresh], {
    scheduledWindow: WINDOW,
    materializedAtMs: MATERIALIZED,
  });
  return { planSet, generation };
}

test("verified exact dashboard preserves micros and maps published visual purposes", async () => {
  const value = await fixture();
  const report = await buildComputeOptimizerExactDashboard({ scope: SCOPE, ...value,
    filters: { groupByTagKey: "BusinessUnit", limit: 1 } });
  assert.equal(report.summary.filteredRecommendationCount, 3);
  assert.equal(report.summary.selectedExactSavings.find((item) => item.currency === "USD")?.amountMicros, "1000000");
  assert.equal(report.summary.selectedExactSavings.find((item) => item.currency === "EUR")?.amountMicros, "9007199254740993");
  assert.equal(report.summary.unresolvedSavingsChannelCount, 1);
  assert.equal(report.visuals.totalInstances, 2);
  assert.equal(report.visuals.operationalRiskFindingCount, 0, "finding text is not substituted for risk evidence");
  assert.equal(report.visuals.maximumPotentialSavingsEc2.length, 2, "currency maxima remain separate");
  assert.equal(report.visuals.recommendedInstanceFamilyChanges.total, 1, "same-family resize is not a family change");
  assert.equal(report.visuals.potentialSavingsByInstance.total, 2);
  assert.equal(report.visuals.selectedInstances.total, 2);
  assert.equal(report.visuals.selectedInstances.rowKeys.length, 1);
  assert.equal(report.visuals.potentialSavingsHistogram.some((item) => item.bucket === "GTE_1000"), true);
  assert.equal(JSON.stringify(report).includes("999999999999.99"), false, "opaque savings never escape");
  assert.equal(Object.keys(report.visuals).length, 14);
});

test("tenant, content, runtime-filter and accepted-state substitutions fail closed", async () => {
  const value = await fixture();
  const rejected = async (input: Parameters<typeof buildComputeOptimizerExactDashboard>[0]) =>
    assert.rejects(buildComputeOptimizerExactDashboard(input),
      (error: unknown) => error instanceof ComputeOptimizerExactDashboardError && error.code === "INVALID_INPUT");
  await rejected({ scope: { ...SCOPE, organizationId: "org_other" }, ...value });
  await rejected({ scope: SCOPE, ...value, generation: { ...value.generation, contentSha256: "f".repeat(64) } });
  await rejected({ scope: SCOPE, ...value, filters: { exportFamily: "UNSUPPORTED" } });
  await rejected({ scope: SCOPE, ...value, filters: { search: [] } });
  await rejected({ scope: SCOPE, ...value, filters: { extra: "leak" } });
});

test("facets are derived only from filtered evidence and paging is visual-specific", async () => {
  const value = await fixture();
  const report = await buildComputeOptimizerExactDashboard({ scope: SCOPE, ...value,
    filters: { exportFamily: "IDLE_RESOURCE", limit: 1 } });
  assert.deepEqual(report.filterOptions.exportFamilies, ["IDLE_RESOURCE"]);
  assert.deepEqual(report.filterOptions.tagValues, ["Payments"]);
  assert.equal(report.visuals.selectedInstances.total, 0);
  assert.equal(report.visuals.potentialSavingsByInstance.total, 0);
  assert.deepEqual(report.summary.selectedExactSavings, []);
});

test("full provider timestamps are validated and timezone dates normalize to UTC", async () => {
  const value = await fixture();
  const targets = structuredClone(value.generation.targets) as DeepMutable<MappedComputeOptimizerExportTarget>[];
  targets[0]!.recommendations[0] = {
    ...targets[0]!.recommendations[0]!,
    lastRefreshTimestamp: "2026-08-02 99:99:99",
  };
  targets[0]!.recommendations[1] = {
    ...targets[0]!.recommendations[1]!,
    lastRefreshTimestamp: "2026-08-02T00:30:00+02:00",
  };
  const generation = await finalizeComputeOptimizerExportGeneration(
    value.planSet,
    targets,
    value.generation.freshBindings,
    { scheduledWindow: WINDOW, materializedAtMs: MATERIALIZED },
  );
  const report = await buildComputeOptimizerExactDashboard({ scope: SCOPE, planSet: value.planSet, generation });
  assert.equal(report.visuals.findingsByDate.some((item) => item.key.state === "MISSING"), true);
  assert.equal(report.visuals.findingsByDate.some((item) => item.key.value === "2026-08-01"), true);
  assert.ok(new TextEncoder().encode(JSON.stringify(report)).byteLength <= 48 * 1_024 * 1_024);
});

test("browser parser accepts the exact payload and rejects malformed evidence", async () => {
  const value = await fixture();
  const report = await buildComputeOptimizerExactDashboard({ scope: SCOPE, ...value });
  const payload = {
    schema: "sutra.finops-compute-optimizer.v2",
    connectionId: SCOPE.connectionId,
    source: "AWS_COMPUTE_OPTIMIZER_EXACT_ORGANIZATION_S3_EXPORT",
    sourceState: "READY",
    freshness: { dataThroughAt: report.generation.dataThroughAtIso, ageHours: 1, staleAfterHours: 48 },
    dashboard: report,
    officialDefinition: FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION,
    evidence: {
      acceptedHead: {
        generationId: report.generation.generationId,
        planSetId: report.generation.planSetId,
        planSetContentSha256: report.generation.planSetContentSha256,
      },
      planIds: value.planSet.planIds,
      schemaAssurances: report.generation.schemaAssurances,
      unresolvedEvidence: report.generation.unresolvedEvidence,
    },
    collection: { available: false, state: "EXACT_UPSTREAM_PRODUCER_NOT_REGISTERED" },
  };
  assert.equal(parseComputeOptimizerExactApiPayload(payload, SCOPE.connectionId).dashboard?.schemaVersion,
    "sutra.finops-compute-optimizer-exact-dashboard.v1");
  const rejects = (candidate: unknown) => assert.throws(
    () => parseComputeOptimizerExactApiPayload(candidate, SCOPE.connectionId),
    (error: unknown) => error instanceof ComputeOptimizerExactClientError,
  );
  const money = structuredClone(payload);
  (money.dashboard.summary.selectedExactSavings[0] as unknown as Record<string, unknown>).amountMicros = "not-an-integer";
  rejects(money);
  const missingRow = structuredClone(payload);
  (missingRow.dashboard.visuals.selectedInstances as unknown as Record<string, unknown>).rowKeys = ["unknown-row"];
  rejects(missingRow);
  const alteredDefinition = structuredClone(payload);
  (alteredDefinition.officialDefinition.documentedPreviewVisuals as unknown as string[])[0] = "Fabricated visual";
  rejects(alteredDefinition);
  const malformedPage = structuredClone(payload);
  (malformedPage.dashboard.page as unknown as Record<string, unknown>).hasMore = "yes";
  rejects(malformedPage);
  const malformedOptions = structuredClone(payload);
  (malformedOptions.dashboard as unknown as Record<string, unknown>).filterOptions = {};
  rejects(malformedOptions);
  const fabricatedGeneration = structuredClone(payload);
  (fabricatedGeneration.dashboard.generation as unknown as Record<string, unknown>).generationId = "not-a-generation-id";
  rejects(fabricatedGeneration);
  const substitutedGenerationHash = structuredClone(payload);
  (substitutedGenerationHash.dashboard.generation as unknown as Record<string, unknown>).contentSha256 = "f".repeat(64);
  rejects(substitutedGenerationHash);
  const substitutedPlanSetHash = structuredClone(payload);
  (substitutedPlanSetHash.dashboard.generation as unknown as Record<string, unknown>).planSetContentSha256 = "f".repeat(64);
  rejects(substitutedPlanSetHash);
  const inconsistentFreshness = structuredClone(payload);
  (inconsistentFreshness.freshness as unknown as Record<string, unknown>).dataThroughAt = "2025-08-02T00:00:00.000Z";
  rejects(inconsistentFreshness);
  const falseReady = structuredClone(payload);
  (falseReady.freshness as unknown as Record<string, unknown>).ageHours = 999;
  rejects(falseReady);
  const inconsistentSummary = structuredClone(payload);
  (inconsistentSummary.dashboard.summary as unknown as Record<string, unknown>).recommendationCount = 99_999;
  rejects(inconsistentSummary);
  const impossibleVisualCount = structuredClone(payload);
  (impossibleVisualCount.dashboard.visuals as unknown as Record<string, unknown>).totalInstances = 99_999;
  rejects(impossibleVisualCount);
  const impossibleRiskCount = structuredClone(payload);
  (impossibleRiskCount.dashboard.summary as unknown as Record<string, unknown>).resourcesWithCurrentRiskEvidence = 99_999;
  rejects(impossibleRiskCount);
  const inconsistentRows = structuredClone(payload);
  (inconsistentRows.dashboard.generation.coverage as unknown as Record<string, unknown>).rowCount = 99_999;
  rejects(inconsistentRows);
  const largeRejectedEvidence = structuredClone(payload);
  const largeCoverage = largeRejectedEvidence.dashboard.generation.coverage as unknown as Record<string, unknown>;
  largeCoverage.rejectedRowCount = 100_001;
  largeCoverage.rowCount = largeRejectedEvidence.dashboard.summary.recommendationCount + 100_001;
  (largeRejectedEvidence.dashboard.summary as unknown as Record<string, unknown>).rejectedRowCount = 100_001;
  assert.equal(parseComputeOptimizerExactApiPayload(largeRejectedEvidence, SCOPE.connectionId).dashboard?.summary.rejectedRowCount,
    100_001);
  const aggregate = structuredClone(payload);
  (aggregate.dashboard.summary.selectedExactSavings[0] as unknown as Record<string, unknown>).amountMicros = "18446744073709551614";
  assert.equal(parseComputeOptimizerExactApiPayload(aggregate, SCOPE.connectionId).dashboard?.summary.selectedExactSavings[0]?.amountMicros,
    "18446744073709551614");
  const oversizedSource = structuredClone(payload);
  (oversizedSource.dashboard.rows[0]!.selectedSavings[0] as unknown as Record<string, unknown>).amountMicros = "18446744073709551614";
  rejects(oversizedSource);
});
