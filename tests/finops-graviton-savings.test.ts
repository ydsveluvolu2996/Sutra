import assert from "node:assert/strict";
import test from "node:test";

import {
  GRAVITON_SAVINGS_BOUNDS,
  GravitonSavingsError,
  buildGravitonSavingsSnapshot,
  type GravitonEvidenceReference,
  type GravitonSavingsCapture,
  type GravitonTenantBoundary,
} from "../lib/finops-graviton-savings.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const MANAGEMENT_ACCOUNT = "123456789012";
const MEMBER_ACCOUNT = "210987654321";
const REGION = "ap-south-1";
const ARN = `arn:aws:ec2:${REGION}:${MEMBER_ACCOUNT}:instance/i-0123456789abcdef0`;
const RESOURCE_FIELDS = {
  accountId: MEMBER_ACCOUNT,
  region: REGION,
  resourceType: "EC2_INSTANCE" as const,
  resourceArn: ARN,
  resourceId: "i-0123456789abcdef0",
};
const boundary: GravitonTenantBoundary = {
  scope: {
    orgId: "org_alpha",
    customerId: "customer_alpha",
    connectionId: `conn_${"a".repeat(32)}`,
  },
  managementAccountId: MANAGEMENT_ACCOUNT,
  partition: "aws",
  accountIds: [MEMBER_ACCOUNT, MANAGEMENT_ACCOUNT].sort(),
  regions: [REGION],
};

type Mutable<T> = T extends readonly (infer U)[]
  ? Mutable<U>[]
  : T extends object
    ? { -readonly [K in keyof T]: Mutable<T[K]> }
    : T;

function mutable<T>(value: T): Mutable<T> {
  return structuredClone(value) as Mutable<T>;
}

function evidence(
  id: string,
  kind: GravitonEvidenceReference["kind"],
  operation: string,
  sha = "b",
): GravitonEvidenceReference {
  return {
    id,
    kind,
    operation,
    url: "https://docs.aws.amazon.com/compute-optimizer/latest/ug/graviton-recommendations.html",
    retrievedAt: "2026-07-31T09:00:00.000Z",
    effectiveAt: "2026-01-01T00:00:00.000Z",
    sha256: sha.repeat(64),
  };
}

function cost(
  costRecordId: string,
  periodStartAt: string,
  periodEndAt: string,
  costBasis: "PUBLIC_ON_DEMAND_EQUIVALENT" | "OBSERVED_EFFECTIVE",
  costMicros: string,
  architecture: "X86_64" | "ARM64" = "X86_64",
  configuration = "m6i.large",
) {
  return {
    costRecordId,
    canonicalSchemaVersion: "sutra.cur2.canonical.v1" as const,
    generationId: "generation_20260731",
    ...RESOURCE_FIELDS,
    configuration,
    architecture,
    periodStartAt,
    periodEndAt,
    usageUnit: "HOURS" as const,
    usageQuantityMicros: "100000000",
    costBasis,
    costMicros,
    currency: "USD",
    source: evidence(`source_${costRecordId}`, "CUR2_DATA_EXPORT", "CUR2_CANONICAL_ROW", "c"),
  };
}

function capture(): GravitonSavingsCapture {
  const dimensions = [
    ["comp_arch", "ARCHITECTURE", "AWS_ARM64_METADATA_VALIDATED", "AWS_INSTANCE_METADATA"],
    ["comp_license", "LICENSING", "LICENSE_PORTABILITY_VALIDATED", "LICENSE_ATTESTATION"],
    ["comp_os", "OS_AMI", "ARM64_IMAGE_VALIDATED", "AWS_API"],
    ["comp_service", "SERVICE_FEATURE", "SERVICE_FEATURES_VALIDATED", "AWS_API"],
    ["comp_workload", "WORKLOAD", "ARM64_WORKLOAD_TEST_PASSED", "WORKLOAD_ATTESTATION"],
  ] as const;
  return {
    schemaVersion: "sutra.graviton-savings.capture.v1",
    scope: boundary.scope,
    managementAccountId: MANAGEMENT_ACCOUNT,
    partition: "aws",
    accountIds: boundary.accountIds,
    regions: boundary.regions,
    collectionId: "graviton_collection_20260731",
    startedAt: "2026-07-31T08:50:00.000Z",
    completedAt: "2026-07-31T09:00:00.000Z",
    recommendations: [{
      recommendationId: "recommendation_20260731",
      ...RESOURCE_FIELDS,
      refreshedAt: "2026-07-31T08:00:00.000Z",
      lookbackPeriodDays: 14,
      currentConfiguration: "m6i.large",
      targetConfiguration: "m7g.large",
      cpuVendorArchitecture: "AWS_ARM64",
      migrationEffort: "MEDIUM",
      performanceRiskBasisPoints: 120,
      estimatedMonthlySavingsMicros: "5000000",
      estimatedSavingsCurrency: "USD",
      inventoryObservationId: "inventory_current",
      targetMetadataId: "metadata_target",
      compatibilityEvidenceIds: dimensions.map(([id]) => id).sort(),
      baselineCostRecordId: "cost_potential",
      currentPriceId: "price_current",
      targetPriceId: "price_target",
      realizationId: "realization_1",
      source: evidence(
        "source_compute_optimizer",
        "AWS_API",
        "compute-optimizer:GetEC2InstanceRecommendations",
        "d",
      ),
    }],
    inventory: [{
      observationId: "inventory_current",
      ...RESOURCE_FIELDS,
      configuration: "m6i.large",
      architecture: "X86_64",
      operatingSystem: "LINUX",
      imageId: "ami-0123456789abcdef0",
      observedAt: "2026-07-31T07:00:00.000Z",
      source: evidence("source_inventory", "AWS_API", "ec2:DescribeInstances", "e"),
    }, {
      observationId: "inventory_target",
      ...RESOURCE_FIELDS,
      configuration: "m7g.large",
      architecture: "ARM64",
      operatingSystem: "LINUX",
      imageId: "ami-0fedcba9876543210",
      observedAt: "2026-07-31T07:00:00.000Z",
      source: evidence("source_target_inventory", "AWS_API", "ec2:DescribeInstances", "f"),
    }],
    instanceMetadata: [{
      metadataId: "metadata_target",
      resourceType: "EC2_INSTANCE",
      region: REGION,
      configuration: "m7g.large",
      architecture: "ARM64",
      vcpu: 2,
      memoryMiB: 8_192,
      effectiveFromAt: "2026-01-01T00:00:00.000Z",
      effectiveToAt: null,
      source: evidence("source_metadata", "AWS_INSTANCE_METADATA", "ec2:DescribeInstanceTypes", "1"),
    }],
    compatibility: dimensions.map(([compatibilityId, dimension, reasonCode, kind], index) => ({
      compatibilityId,
      ...RESOURCE_FIELDS,
      dimension,
      status: "COMPATIBLE" as const,
      reasonCode,
      assessedAt: "2026-07-31T07:30:00.000Z",
      sources: [evidence(`source_compat_${index}`, kind, `evidence:${dimension}`, String(index + 2))],
    })),
    costs: [
      cost(
        "cost_potential",
        "2026-06-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
        "PUBLIC_ON_DEMAND_EQUIVALENT",
        "10000000",
      ),
      cost(
        "cost_realized_before",
        "2026-05-01T00:00:00.000Z",
        "2026-05-31T00:00:00.000Z",
        "OBSERVED_EFFECTIVE",
        "8000000",
      ),
      cost(
        "cost_realized_after",
        "2026-07-01T00:00:00.000Z",
        "2026-07-31T00:00:00.000Z",
        "OBSERVED_EFFECTIVE",
        "5000000",
        "ARM64",
        "m7g.large",
      ),
    ],
    pricing: [{
      priceId: "price_current",
      resourceType: "EC2_INSTANCE",
      region: REGION,
      configuration: "m6i.large",
      architecture: "X86_64",
      operatingSystem: "Linux",
      tenancy: "Shared",
      purchaseOption: "ON_DEMAND",
      unit: "HRS",
      currency: "USD",
      unitPriceMicros: "100000",
      priceListVersion: "20260701000000",
      productSku: "SKU_CURRENT",
      termCode: "TERM_CURRENT",
      dimensionCode: "DIMENSION_CURRENT",
      effectiveFromAt: "2026-01-01T00:00:00.000Z",
      effectiveToAt: null,
      source: evidence("source_price_current", "AWS_PRICING", "pricing:GetPriceListFileUrl", "8"),
    }, {
      priceId: "price_target",
      resourceType: "EC2_INSTANCE",
      region: REGION,
      configuration: "m7g.large",
      architecture: "ARM64",
      operatingSystem: "Linux",
      tenancy: "Shared",
      purchaseOption: "ON_DEMAND",
      unit: "HRS",
      currency: "USD",
      unitPriceMicros: "60000",
      priceListVersion: "20260701000000",
      productSku: "SKU_TARGET",
      termCode: "TERM_TARGET",
      dimensionCode: "DIMENSION_TARGET",
      effectiveFromAt: "2026-01-01T00:00:00.000Z",
      effectiveToAt: null,
      source: evidence("source_price_target", "AWS_PRICING", "pricing:GetPriceListFileUrl", "9"),
    }],
    realizations: [{
      realizationId: "realization_1",
      ...RESOURCE_FIELDS,
      migrationAt: "2026-06-15T00:00:00.000Z",
      targetConfiguration: "m7g.large",
      targetInventoryObservationId: "inventory_target",
      baselineCostRecordId: "cost_realized_before",
      postMigrationCostRecordId: "cost_realized_after",
      comparableWorkloadEvidenceId: "comp_workload",
      source: evidence("source_realization", "AWS_API", "sutra:MigrationEvidence", "a"),
    }],
  };
}

test("builds separate evidence-backed potential, provider, and realized savings", () => {
  const result = buildGravitonSavingsSnapshot(capture(), boundary, NOW);
  assert.equal(result.state, "COMPLETE");
  assert.deepEqual(result.summary, {
    resources: 1,
    ready: 1,
    reviewRequired: 0,
    blocked: 0,
    configurationRequired: 0,
    modeledPotentialByPeriod: [{
      periodStartAt: "2026-06-01T00:00:00.000Z",
      periodEndAt: "2026-07-01T00:00:00.000Z",
      currency: "USD",
      amountMicros: "4000000",
    }],
    measuredRealizedByPeriod: [{
      periodStartAt: "2026-07-01T00:00:00.000Z",
      periodEndAt: "2026-07-31T00:00:00.000Z",
      currency: "USD",
      amountMicros: "3000000",
    }],
  });
  const opportunity = result.opportunities[0]!;
  assert.equal(opportunity.providerEstimate?.savings.amountMicros, "5000000");
  assert.equal(opportunity.potentialSavings?.savings.amountMicros, "4000000");
  assert.equal(opportunity.realizedSavings?.observedSavings.amountMicros, "3000000");
  assert.equal(opportunity.realizedSavings?.kind, "MEASURED_REALIZED");
  assert.ok(opportunity.potentialSavings?.assumptionCodes.includes("NOT_A_SAVINGS_PROMISE"));
  assert.equal(result.instanceMapping.length, 2);
  const target = result.instanceMapping.find((row) => row.role === "TARGET")!;
  assert.equal(target.architecture, "ARM64");
  assert.equal(target.vcpu, 2);
  assert.equal(target.memoryMiB, 8_192);
  assert.equal(target.priceListVersion, "20260701000000");
  assert.ok(target.evidenceIds.includes("source_metadata"));
});

test("does not infer compatibility from a Graviton-looking target name", () => {
  const value = mutable(capture());
  value.recommendations[0]!.compatibilityEvidenceIds = [];
  value.compatibility = [];
  const result = buildGravitonSavingsSnapshot(value, boundary, NOW);
  const opportunity = result.opportunities[0]!;
  assert.equal(result.state, "CONFIGURATION_REQUIRED");
  assert.equal(opportunity.state, "CONFIGURATION_REQUIRED");
  assert.equal(opportunity.potentialSavings, null);
  assert.deepEqual(
    opportunity.blockerReasons.filter((item) => item.code.endsWith("_EVIDENCE_REQUIRED")),
    [
      { category: "ARCHITECTURE", code: "ARCHITECTURE_EVIDENCE_REQUIRED" },
      { category: "LICENSING", code: "LICENSING_EVIDENCE_REQUIRED" },
      { category: "OS_AMI", code: "OS_AMI_EVIDENCE_REQUIRED" },
      { category: "SERVICE_FEATURE", code: "SERVICE_FEATURE_EVIDENCE_REQUIRED" },
      { category: "WORKLOAD", code: "WORKLOAD_EVIDENCE_REQUIRED" },
    ],
  );
});

test("returns explicit incompatibility and review blockers without savings claims", () => {
  const value = mutable(capture());
  value.compatibility.find((item) => item.dimension === "LICENSING")!.status = "INCOMPATIBLE";
  value.compatibility.find((item) => item.dimension === "OS_AMI")!.status = "REVIEW_REQUIRED";
  const result = buildGravitonSavingsSnapshot(value, boundary, NOW);
  const opportunity = result.opportunities[0]!;
  assert.equal(result.state, "PARTIAL");
  assert.equal(opportunity.state, "BLOCKED");
  assert.equal(opportunity.potentialSavings, null);
  assert.ok(opportunity.blockerReasons.some((item) => item.code === "LICENSING_INCOMPATIBLE"));
  assert.ok(opportunity.blockerReasons.some((item) => item.code === "OS_AMI_REVIEW_REQUIRED"));
});

test("uses review-required only when there is no hard incompatibility", () => {
  const value = mutable(capture());
  value.compatibility.find((item) => item.dimension === "OS_AMI")!.status = "REVIEW_REQUIRED";
  const result = buildGravitonSavingsSnapshot(value, boundary, NOW);
  assert.equal(result.opportunities[0]!.state, "REVIEW_REQUIRED");
  assert.equal(result.opportunities[0]!.potentialSavings, null);
});

test("requires CUR2, pricing, and metadata period reconciliation", () => {
  const value = mutable(capture());
  value.costs.find((item) => item.costRecordId === "cost_potential")!.costMicros = "9999999";
  const result = buildGravitonSavingsSnapshot(value, boundary, NOW);
  assert.equal(result.opportunities[0]!.state, "CONFIGURATION_REQUIRED");
  assert.equal(result.opportunities[0]!.potentialSavings, null);
  assert.ok(result.opportunities[0]!.blockerReasons.some((item) =>
    item.code === "CUR2_PRICING_RECONCILIATION_REQUIRED"
  ));
});

test("keeps currencies and billing periods separate in totals", () => {
  const value = mutable(capture());
  const second = structuredClone(value.recommendations[0]!);
  second.recommendationId = "recommendation_20260730";
  second.refreshedAt = "2026-07-30T08:00:00.000Z";
  value.recommendations.push(second);
  const result = buildGravitonSavingsSnapshot(value, boundary, NOW);
  assert.equal(result.opportunities.length, 1);
  assert.equal(result.opportunities[0]!.historyCount, 2);
  assert.equal(result.summary.modeledPotentialByPeriod[0]!.amountMicros, "4000000");
});

test("collapses exact duplicates and rejects conflicting duplicate ids", () => {
  const exact = mutable(capture());
  exact.pricing.push(structuredClone(exact.pricing[0]!));
  assert.equal(buildGravitonSavingsSnapshot(exact, boundary, NOW).summary.ready, 1);

  const conflicting = mutable(capture());
  const duplicate = structuredClone(conflicting.pricing[0]!);
  duplicate.unitPriceMicros = "100001";
  conflicting.pricing.push(duplicate);
  assert.throws(
    () => buildGravitonSavingsSnapshot(conflicting, boundary, NOW),
    (error: unknown) => error instanceof GravitonSavingsError
      && error.code === "CONFLICTING_DUPLICATE",
  );
});

test("fails closed on tenant scope changes and credential-shaped fields", () => {
  const wrongScope = mutable(capture());
  wrongScope.scope.customerId = "customer_other";
  assert.throws(
    () => buildGravitonSavingsSnapshot(wrongScope, boundary, NOW),
    (error: unknown) => error instanceof GravitonSavingsError
      && error.code === "SCOPE_MISMATCH",
  );
  const credential = {
    ...capture(),
    accessKeyId: "not-accepted",
  };
  assert.throws(
    () => buildGravitonSavingsSnapshot(credential, boundary, NOW),
    (error: unknown) => error instanceof GravitonSavingsError
      && error.code === "INVALID_INPUT",
  );
});

test("enforces deterministic history and response bounds", () => {
  const value = mutable(capture());
  value.recommendations = Array.from(
    { length: GRAVITON_SAVINGS_BOUNDS.maximumHistoryPerResource + 1 },
    (_, index) => ({
      ...structuredClone(value.recommendations[0]!),
      recommendationId: `recommendation_${String(index).padStart(2, "0")}`,
      refreshedAt: new Date(Date.parse("2026-07-31T08:00:00.000Z") - index * 1_000).toISOString(),
    }),
  );
  assert.throws(
    () => buildGravitonSavingsSnapshot(value, boundary, NOW),
    (error: unknown) => error instanceof GravitonSavingsError
      && error.code === "HISTORY_LIMIT_EXCEEDED",
  );
});

test("returns configuration-required when no recommendation evidence exists", () => {
  const value = mutable(capture());
  value.recommendations = [];
  const result = buildGravitonSavingsSnapshot(value, boundary, NOW);
  assert.equal(result.state, "CONFIGURATION_REQUIRED");
  assert.equal(result.summary.resources, 0);
});

function managedServiceCapture(
  resourceType: "OPENSEARCH_DOMAIN" | "ELASTICACHE_REPLICATION_GROUP",
): Mutable<GravitonSavingsCapture> {
  const value = mutable(capture());
  const service = resourceType === "OPENSEARCH_DOMAIN" ? "es" : "elasticache";
  const resourceId = resourceType === "OPENSEARCH_DOMAIN" ? "domain/search-prod" : "replicationgroup/cache-prod";
  const resourceArn = `arn:aws:${service}:${REGION}:${MEMBER_ACCOUNT}:${resourceId}`;
  for (const item of [
    ...value.recommendations, ...value.inventory, ...value.compatibility,
    ...value.costs, ...value.realizations,
  ]) {
    item.resourceType = resourceType;
    item.resourceArn = resourceArn;
    item.resourceId = resourceId;
  }
  for (const item of [...value.instanceMetadata, ...value.pricing]) {
    item.resourceType = resourceType;
  }
  const recommendation = value.recommendations[0]!;
  recommendation.recommendationAuthority = "AWS_SERVICE_INVENTORY_PRICING";
  recommendation.source.operation = resourceType === "OPENSEARCH_DOMAIN"
    ? "es:DescribeDomain"
    : "elasticache:DescribeReplicationGroups";
  recommendation.estimatedMonthlySavingsMicros = null;
  recommendation.estimatedSavingsCurrency = null;
  return value;
}

test("supports OpenSearch and ElastiCache only with full compatibility and exact modeled economics", () => {
  for (const resourceType of ["OPENSEARCH_DOMAIN", "ELASTICACHE_REPLICATION_GROUP"] as const) {
    const result = buildGravitonSavingsSnapshot(managedServiceCapture(resourceType), boundary, NOW);
    assert.equal(result.opportunities[0]!.resourceType, resourceType);
    assert.equal(result.opportunities[0]!.state, "READY");
    assert.equal(result.opportunities[0]!.providerEstimate, null);
    assert.equal(result.opportunities[0]!.potentialSavings?.savings.amountMicros, "4000000");
    assert.ok(result.currentUsage.every((item) => item.resourceType === resourceType));
  }
});

test("rejects a fabricated Compute Optimizer estimate on managed-service inventory evidence", () => {
  const value = managedServiceCapture("OPENSEARCH_DOMAIN");
  value.recommendations[0]!.estimatedMonthlySavingsMicros = "1";
  value.recommendations[0]!.estimatedSavingsCurrency = "USD";
  assert.throws(
    () => buildGravitonSavingsSnapshot(value, boundary, NOW),
    (error: unknown) => error instanceof GravitonSavingsError && error.code === "INVALID_INPUT",
  );
  const missingAuthority = managedServiceCapture("ELASTICACHE_REPLICATION_GROUP");
  delete missingAuthority.recommendations[0]!.recommendationAuthority;
  assert.throws(
    () => buildGravitonSavingsSnapshot(missingAuthority, boundary, NOW),
    (error: unknown) => error instanceof GravitonSavingsError && error.code === "INVALID_INPUT",
  );
});
