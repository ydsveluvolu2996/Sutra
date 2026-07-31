import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EXTENDED_SUPPORT_PROJECTION_BOUNDS,
  EXTENDED_SUPPORT_READ_OPERATIONS,
  ExtendedSupportProjectionError,
  buildExtendedSupportProjection,
  type ExtendedSupportCalendarEntry,
  type ExtendedSupportEvidenceReference,
  type ExtendedSupportInventoryObservation,
  type ExtendedSupportObservedCharge,
  type ExtendedSupportProjectionCapture,
  type ExtendedSupportRate,
  type ExtendedSupportService,
  type ExtendedSupportTenantBoundary,
  type ExtendedSupportUnit,
} from "../lib/finops-extended-support-projection.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const COMPLETED_AT = "2026-07-31T11:05:00.000Z";
const ACCOUNT_ID = "123456789012";
const REGION = "us-east-1";
const scope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const boundary: ExtendedSupportTenantBoundary = {
  scope,
  managementAccountId: ACCOUNT_ID,
  partition: "aws",
  accountIds: [ACCOUNT_ID],
  regions: [REGION],
};

const serviceConfig: Readonly<Record<ExtendedSupportService, {
  readonly resourceType:
    | "EKS_CLUSTER"
    | "RDS_DB_INSTANCE"
    | "AURORA_DB_CLUSTER"
    | "OPENSEARCH_DOMAIN"
    | "ELASTICACHE_CACHE";
  readonly engine: string;
  readonly engineVersion: string;
  readonly versionKey: string;
  readonly operation: string;
  readonly arn: string;
  readonly unit: ExtendedSupportUnit;
  readonly unitsPerHour: number;
}>> = {
  EKS: {
    resourceType: "EKS_CLUSTER",
    engine: "kubernetes",
    engineVersion: "1.30",
    versionKey: "1.30",
    operation: "eks:DescribeCluster",
    arn: `arn:aws:eks:${REGION}:${ACCOUNT_ID}:cluster/prod`,
    unit: "CLUSTER_HOUR",
    unitsPerHour: 1,
  },
  RDS: {
    resourceType: "RDS_DB_INSTANCE",
    engine: "postgres",
    engineVersion: "14.18",
    versionKey: "14",
    operation: "rds:DescribeDBInstances",
    arn: `arn:aws:rds:${REGION}:${ACCOUNT_ID}:db:orders`,
    unit: "VCPU_HOUR",
    unitsPerHour: 2,
  },
  AURORA: {
    resourceType: "AURORA_DB_CLUSTER",
    engine: "aurora-mysql",
    engineVersion: "5.7.mysql_aurora.2.12.5",
    versionKey: "2",
    operation: "rds:DescribeDBClusters",
    arn: `arn:aws:rds:${REGION}:${ACCOUNT_ID}:cluster:ledger`,
    unit: "VCPU_HOUR",
    unitsPerHour: 4,
  },
  OPENSEARCH: {
    resourceType: "OPENSEARCH_DOMAIN",
    engine: "OpenSearch",
    engineVersion: "OpenSearch_1.2",
    versionKey: "1.2",
    operation: "es:DescribeDomains",
    arn: `arn:aws:es:${REGION}:${ACCOUNT_ID}:domain/search`,
    unit: "NORMALIZED_INSTANCE_HOUR",
    unitsPerHour: 4,
  },
  ELASTICACHE: {
    resourceType: "ELASTICACHE_CACHE",
    engine: "redis",
    engineVersion: "5.0.6",
    versionKey: "5",
    operation: "elasticache:DescribeCacheClusters",
    arn: `arn:aws:elasticache:${REGION}:${ACCOUNT_ID}:cluster:session-cache`,
    unit: "INSTANCE_HOUR",
    unitsPerHour: 2,
  },
};

function reference(
  id: string,
  kind: ExtendedSupportEvidenceReference["kind"],
  operation: string,
  overrides: Partial<ExtendedSupportEvidenceReference> = {},
): ExtendedSupportEvidenceReference {
  return {
    id,
    kind,
    operation,
    url: kind === "AWS_PRICING"
      ? "https://aws.amazon.com/eks/pricing/"
      : "https://docs.aws.amazon.com/eks/latest/APIReference/API_DescribeCluster.html",
    retrievedAt: "2026-07-31T10:00:00.000Z",
    effectiveAt: "2026-07-30T00:00:00.000Z",
    sha256: "a".repeat(64),
    ...overrides,
  };
}

function observation(
  service: ExtendedSupportService,
  overrides: Partial<ExtendedSupportInventoryObservation> = {},
): ExtendedSupportInventoryObservation {
  const config = serviceConfig[service];
  const source = reference(
    `inventory_${service.toLowerCase()}`,
    "AWS_API",
    config.operation,
  );
  return {
    service,
    resourceType: config.resourceType,
    accountId: ACCOUNT_ID,
    region: REGION,
    resourceArn: config.arn,
    resourceId: config.arn.split(":").at(-1)!,
    engine: config.engine,
    engineVersion: config.engineVersion,
    supportVersionKey: config.versionKey,
    supportEnrollment: service === "OPENSEARCH" || service === "ELASTICACHE"
      ? "AUTOMATIC"
      : "ENABLED",
    observedAt: "2026-07-31T10:05:00.000Z",
    source,
    projectionBasis: {
      unit: config.unit,
      unitsPerHour: config.unitsPerHour,
      observedAt: "2026-07-31T10:05:00.000Z",
      evidence: [source],
    },
    ...overrides,
  };
}

function calendar(
  service: ExtendedSupportService,
  overrides: Partial<ExtendedSupportCalendarEntry> = {},
): ExtendedSupportCalendarEntry {
  const config = serviceConfig[service];
  const isRds = service === "RDS";
  const isRdsFamily = isRds || service === "AURORA";
  return {
    service,
    engine: config.engine,
    supportVersionKey: config.versionKey,
    region: service === "EKS" || isRdsFamily ? REGION : "GLOBAL",
    calendarStatus: "ANNOUNCED",
    standardSupportEndAt: isRds
      ? "2026-08-31T23:59:59.000Z"
      : "2026-06-30T23:59:59.000Z",
    extendedSupportStartAt: isRds
      ? "2026-09-01T00:00:00.000Z"
      : "2026-07-01T00:00:00.000Z",
    chargeableFromAt: isRds
      ? "2026-09-01T00:00:00.000Z"
      : "2026-07-01T00:00:00.000Z",
    extendedSupportEndAt: service === "EKS"
      ? "2027-07-01T00:00:00.000Z"
      : "2029-07-01T00:00:00.000Z",
    effectiveAt: "2026-07-30T00:00:00.000Z",
    source: reference(
      `calendar_${service.toLowerCase()}`,
      service === "EKS" || isRdsFamily
        ? "AWS_API"
        : "AWS_DOCUMENTATION",
      service === "EKS"
        ? "eks:DescribeClusterVersions"
        : isRdsFamily
          ? "rds:DescribeDBMajorEngineVersions"
          : "AWS_SUPPORT_CALENDAR",
    ),
    ...overrides,
  };
}

function supportRate(
  service: ExtendedSupportService,
  overrides: Partial<ExtendedSupportRate> = {},
): ExtendedSupportRate {
  const config = serviceConfig[service];
  const elasticache = service === "ELASTICACHE";
  const directPrices: Readonly<Record<ExtendedSupportService, number>> = {
    EKS: 0.5,
    RDS: 0.1,
    AURORA: 0.1,
    OPENSEARCH: 0.0065,
    ELASTICACHE: 0.1248,
  };
  return {
    rateId: `rate_${service.toLowerCase()}`,
    service,
    engine: config.engine,
    supportVersionKey: config.versionKey,
    region: REGION,
    tier: "YEAR_1",
    unit: config.unit,
    currency: "USD",
    incrementalUnitPrice: directPrices[service],
    pricingModel: elasticache
      ? "ON_DEMAND_PREMIUM"
      : "DIRECT_UNIT_RATE",
    baseUnitPrice: elasticache ? 0.156 : null,
    premiumPercent: elasticache ? 80 : null,
    effectiveFromAt: service === "RDS"
      ? "2026-09-01T00:00:00.000Z"
      : "2026-07-01T00:00:00.000Z",
    effectiveToAt: service === "EKS"
      ? "2027-07-01T00:00:00.000Z"
      : "2029-07-01T00:00:00.000Z",
    source: reference(
      `pricing_${service.toLowerCase()}`,
      "AWS_PRICING",
      "pricing:GetProducts",
    ),
    ...overrides,
  };
}

function charge(
  service: ExtendedSupportService,
  overrides: Partial<ExtendedSupportObservedCharge> = {},
): ExtendedSupportObservedCharge {
  const config = serviceConfig[service];
  return {
    chargeId: `charge_${service.toLowerCase()}`,
    service,
    accountId: ACCOUNT_ID,
    region: REGION,
    resourceArn: config.arn,
    periodStartAt: "2026-07-01T00:00:00.000Z",
    periodEndAt: "2026-07-31T00:00:00.000Z",
    usageUnit: config.unit,
    usageQuantity: 720 * config.unitsPerHour,
    actualExtendedSupportCost: 17.25,
    currency: "USD",
    source: reference(
      `cur_${service.toLowerCase()}`,
      "CUR2_DATA_EXPORT",
      "CUR2_DATA_EXPORT",
      {
        url: "https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-cur2.html",
      },
    ),
    ...overrides,
  };
}

function capture(
  overrides: Partial<ExtendedSupportProjectionCapture> = {},
): ExtendedSupportProjectionCapture {
  const services = Object.keys(serviceConfig) as ExtendedSupportService[];
  const observations = services.map((item) => observation(item));
  return {
    schemaVersion: "sutra.extended-support-projection.v1",
    scope,
    managementAccountId: ACCOUNT_ID,
    partition: "aws",
    accountIds: [ACCOUNT_ID],
    regions: [REGION],
    collectionId: `esp_${"b".repeat(64)}`,
    startedAt: "2026-07-31T11:00:00.000Z",
    completedAt: COMPLETED_AT,
    coverage: services.map((service) => ({
      service,
      status: "SUCCEEDED",
      readPermissionsValidated: true,
      accountIds: [ACCOUNT_ID],
      regions: [REGION],
      recordCount: observations.filter((item) => item.service === service).length,
      errorCode: null,
    })),
    observations,
    calendars: services.map((item) => calendar(item)),
    rates: services.map((item) => supportRate(item)),
    observedCharges: [
      charge("EKS"),
      charge("EKS", {
        chargeId: "charge_eks_eur",
        currency: "EUR",
        actualExtendedSupportCost: 8,
      }),
      charge("OPENSEARCH"),
    ],
    ...overrides,
  };
}

function withRecordCounts(
  value: ExtendedSupportProjectionCapture,
): ExtendedSupportProjectionCapture {
  return {
    ...value,
    coverage: value.coverage.map((item) => ({
      ...item,
      recordCount: value.observations.filter((observation) =>
        observation.service === item.service
      ).length,
    })),
  };
}

describe("Extended Support projection", () => {
  it("keeps all five services separate and labels actual versus projected cost", () => {
    const result = buildExtendedSupportProjection(capture(), boundary, NOW);

    assert.equal(result.state, "READY");
    assert.equal(result.services.length, 5);
    assert.deepEqual(
      result.services.map((item) => item.service),
      ["EKS", "RDS", "AURORA", "OPENSEARCH", "ELASTICACHE"],
    );
    assert.equal(
      result.observedCostLabel,
      "RECONCILED_ACTUAL_EXTENDED_SUPPORT_COST",
    );
    assert.equal(
      result.projectionLabel,
      "PROJECTED_INCREMENTAL_EXTENDED_SUPPORT_COST_IF_UNCHANGED",
    );
    const eks = result.services.find((item) => item.service === "EKS")!;
    assert.deepEqual(eks.observedActualCosts, [
      { currency: "EUR", amount: 8 },
      { currency: "USD", amount: 17.25 },
    ]);
    assert.deepEqual(eks.observedActualUsage, [
      { unit: "CLUSTER_HOUR", quantity: 1_440 },
    ]);
    assert.deepEqual(
      result.resources.find((item) => item.service === "EKS")!
        .observedActualUsage,
      [{ unit: "CLUSTER_HOUR", quantity: 1_440 }],
    );
    assert.equal(eks.currentlyExtendedResources, 1);
    const eksResource = result.resources.find((item) =>
      item.service === "EKS"
    )!;
    assert.equal(eksResource.calendarFreshness, "CURRENT");
    assert.equal(eksResource.pricingFreshness, "CURRENT");
    assert.equal(eksResource.calendarEffectiveAt, "2026-07-30T00:00:00.000Z");
    assert.deepEqual(eksResource.pricingRateIds, ["rate_eks"]);
    assert.equal(
      eks.horizons[0]!.projectedIncrementalCosts[0]!.currency,
      "USD",
    );
    assert.ok(
      eks.horizons[0]!.projectedIncrementalCosts[0]!.amount > 1_000,
    );
    const rds = result.services.find((item) => item.service === "RDS")!;
    assert.equal(rds.horizons[0]!.enteringExtendedSupportResources, 1);
    assert.equal(rds.horizons[0]!.completeResourceProjections, 1);
    assert.equal(
      result.resources.every((item) =>
        item.horizons.length === 3
        && item.horizons.map((entry) => entry.months).join(",") === "3,6,12"
      ),
      true,
    );
    assert.equal(
      result.sourceReferences.some((item) =>
        item.kind === "CUR2_DATA_EXPORT"
      ),
      true,
    );
  });

  it("never turns missing pricing, dates, basis, version, or enrollment into zero", () => {
    const base = capture();
    const input = {
      ...base,
      rates: base.rates.filter((item) => item.service !== "OPENSEARCH"),
      observations: base.observations.map((item) => {
        if (item.service === "RDS") {
          return { ...item, projectionBasis: null };
        }
        if (item.service === "AURORA") {
          return { ...item, supportVersionKey: null };
        }
        if (item.service === "ELASTICACHE") {
          return { ...item, supportEnrollment: "UNKNOWN" as const };
        }
        return item;
      }),
      calendars: base.calendars.map((item) =>
        item.service === "EKS"
          ? calendar("EKS", {
            calendarStatus: "NOT_ANNOUNCED",
            standardSupportEndAt: null,
            extendedSupportStartAt: null,
            chargeableFromAt: null,
            extendedSupportEndAt: null,
          })
          : item
      ),
    };

    const result = buildExtendedSupportProjection(input, boundary, NOW);

    assert.equal(result.state, "PARTIAL");
    for (const resource of result.resources) {
      assert.equal(resource.horizons[0]!.projectedIncrementalCost, null);
      assert.notEqual(resource.horizons[0]!.projectionState, "COMPLETE");
    }
    assert.equal(
      result.resources.find((item) => item.service === "AURORA")!
        .lifecycleState,
      "VERSION_REQUIRED",
    );
  });

  it("uses explicit disabled enrollment as not-applicable, not as a cost claim", () => {
    const base = capture();
    const input = {
      ...base,
      observations: base.observations.map((item) =>
        item.service === "EKS"
          ? { ...item, supportEnrollment: "DISABLED" as const }
          : item
      ),
    };

    const result = buildExtendedSupportProjection(input, boundary, NOW);
    const horizon = result.resources.find((item) => item.service === "EKS")!
      .horizons[0]!;

    assert.equal(horizon.projectionState, "NOT_APPLICABLE");
    assert.equal(horizon.projectedIncrementalCost, null);
    assert.deepEqual(horizon.reasonCodes, ["EXTENDED_SUPPORT_NOT_ENABLED"]);
  });

  it("deduplicates identical observations and rejects conflicting history", () => {
    const base = capture();
    const duplicate = base.observations[0]!;
    const dedupedInput = withRecordCounts({
      ...base,
      observations: [...base.observations, duplicate],
    });
    const result = buildExtendedSupportProjection(dedupedInput, boundary, NOW);
    assert.equal(result.resources.length, 5);
    assert.equal(result.resources.find((item) => item.service === "EKS")!
      .historyObservationCount, 1);

    const conflicting = withRecordCounts({
      ...base,
      observations: [
        ...base.observations,
        { ...duplicate, engineVersion: "1.29" },
      ],
    });
    assert.throws(
      () => buildExtendedSupportProjection(conflicting, boundary, NOW),
      (error: unknown) =>
        error instanceof ExtendedSupportProjectionError
        && error.code === "CONFLICTING_DUPLICATE"
        && error.message === "The Extended Support projection evidence is invalid",
    );
  });

  it("fails closed on tenant, record-shape, rate-overlap, and history bounds", () => {
    const wrongAccountBase = capture();
    const wrongAccount = {
      ...wrongAccountBase,
      observations: wrongAccountBase.observations.map((item, index) =>
        index === 0 ? { ...item, accountId: "999999999999" } : item
      ),
    };
    assert.throws(
      () => buildExtendedSupportProjection(wrongAccount, boundary, NOW),
      (error: unknown) =>
        error instanceof ExtendedSupportProjectionError
        && error.code === "SCOPE_MISMATCH",
    );

    const extraField = {
      ...capture(),
      clientTenantId: "customer_other",
    };
    assert.throws(
      () => buildExtendedSupportProjection(extraField, boundary, NOW),
      (error: unknown) =>
        error instanceof ExtendedSupportProjectionError
        && error.code === "INVALID_INPUT",
    );

    const overlapBase = capture();
    const overlap = {
      ...overlapBase,
      rates: [
        ...overlapBase.rates,
        supportRate("EKS", { rateId: "rate_eks_overlap" }),
      ],
    };
    assert.throws(
      () => buildExtendedSupportProjection(overlap, boundary, NOW),
      (error: unknown) =>
        error instanceof ExtendedSupportProjectionError
        && error.code === "CONFLICTING_DUPLICATE",
    );

    const historyBase = capture();
    const eks = historyBase.observations.find((item) =>
      item.service === "EKS"
    )!;
    const tooMuchHistory = Array.from(
      {
        length:
          EXTENDED_SUPPORT_PROJECTION_BOUNDS.maximumHistoryPerResource + 1,
      },
      (_, index) => {
        const observedAt = new Date(
          Date.parse("2026-07-01T10:00:00.000Z") + index * 60_000,
        ).toISOString();
        return {
          ...eks,
          observedAt,
          projectionBasis: {
            ...eks.projectionBasis!,
            observedAt,
          },
        };
      },
    );
    const bounded = withRecordCounts({
      ...historyBase,
      observations: [
        ...historyBase.observations.filter((item) => item.service !== "EKS"),
        ...tooMuchHistory,
      ],
    });
    assert.throws(
      () => buildExtendedSupportProjection(bounded, boundary, NOW),
      (error: unknown) =>
        error instanceof ExtendedSupportProjectionError
        && error.code === "RECORD_LIMIT_EXCEEDED",
    );
  });

  it("requires complete tenant-pinned coverage and reports failed sources", () => {
    const base = capture();
    const input = {
      ...base,
      observations: base.observations.filter((item) => item.service !== "EKS"),
      observedCharges: base.observedCharges.filter((item) =>
        item.service !== "EKS"
      ),
      coverage: base.coverage.map((item) =>
        item.service === "EKS"
          ? {
            ...item,
            status: "FAILED" as const,
            readPermissionsValidated: false,
            recordCount: 0,
            errorCode: "ACCESS_DENIED",
          }
          : item
      ),
    };

    const result = buildExtendedSupportProjection(input, boundary, NOW);

    assert.equal(result.state, "CONFIGURATION_REQUIRED");
    assert.equal(
      result.services.find((item) => item.service === "EKS")!.state,
      "CONFIGURATION_REQUIRED",
    );
  });

  it("executes stale, past-support, and complete-empty inventory paths honestly", () => {
    const base = capture();
    const staleObservedAt = "2026-01-31T10:05:00.000Z";
    const stalePast = withRecordCounts({
      ...base,
      observations: base.observations.map((item) =>
        item.service === "EKS"
          ? {
            ...item,
            observedAt: staleObservedAt,
            projectionBasis: {
              ...item.projectionBasis!,
              observedAt: staleObservedAt,
            },
          }
          : item
      ),
      calendars: base.calendars.map((item) =>
        item.service === "EKS"
          ? calendar("EKS", {
            standardSupportEndAt: "2024-06-30T23:59:59.000Z",
            extendedSupportStartAt: "2024-07-01T00:00:00.000Z",
            chargeableFromAt: "2024-07-01T00:00:00.000Z",
            extendedSupportEndAt: "2025-07-01T00:00:00.000Z",
          })
          : item
      ),
      rates: base.rates.map((item) =>
        item.service === "EKS"
          ? supportRate("EKS", {
            effectiveFromAt: "2024-07-01T00:00:00.000Z",
            effectiveToAt: "2025-07-01T00:00:00.000Z",
          })
          : item
      ),
    });
    const staleResult = buildExtendedSupportProjection(
      stalePast,
      boundary,
      NOW,
    );
    const staleEks = staleResult.resources.find((item) =>
      item.service === "EKS"
    )!;
    assert.equal(staleEks.observationFreshness, "STALE");
    assert.equal(staleEks.lifecycleState, "END_OF_SUPPORT");
    assert.equal(staleEks.horizons[0]!.projectionState, "NOT_APPLICABLE");
    assert.equal(staleEks.horizons[0]!.projectedIncrementalCost, null);
    assert.deepEqual(
      staleEks.horizons[0]!.reasonCodes,
      ["PAST_EXTENDED_SUPPORT_NO_COST_PROJECTION"],
    );
    assert.equal(
      staleResult.services.find((item) => item.service === "EKS")!.state,
      "PARTIAL",
    );

    const emptyBase = capture();
    const emptyEks = withRecordCounts({
      ...emptyBase,
      observations: emptyBase.observations.filter((item) =>
        item.service !== "EKS"
      ),
      observedCharges: emptyBase.observedCharges.filter((item) =>
        item.service !== "EKS"
      ),
    });
    const emptyResult = buildExtendedSupportProjection(
      emptyEks,
      boundary,
      NOW,
    );
    const emptySummary = emptyResult.services.find((item) =>
      item.service === "EKS"
    )!;
    assert.equal(emptySummary.state, "READY");
    assert.equal(emptySummary.resourceCount, 0);
    assert.equal(emptySummary.horizons[0]!.windowStartAt, NOW.toISOString());
    assert.equal(
      emptySummary.horizons[0]!.windowEndAt,
      "2026-10-31T12:00:00.000Z",
    );
  });

  it("suppresses projections backed by stale calendar or pricing evidence", () => {
    const calendarBase = capture();
    const staleCalendar = {
      ...calendarBase,
      calendars: calendarBase.calendars.map((item) =>
        item.service === "EKS"
          ? {
            ...item,
            source: reference(
              "calendar_eks",
              "AWS_API",
              "eks:DescribeClusterVersions",
              {
                retrievedAt: "2026-05-01T10:00:00.000Z",
                effectiveAt: "2026-05-01T00:00:00.000Z",
              },
            ),
          }
          : item
      ),
    };
    const calendarResult = buildExtendedSupportProjection(
      staleCalendar,
      boundary,
      NOW,
    );
    const calendarResource = calendarResult.resources.find((item) =>
      item.service === "EKS"
    )!;
    assert.equal(calendarResource.calendarFreshness, "STALE");
    assert.equal(
      calendarResource.horizons[0]!.projectedIncrementalCost,
      null,
    );
    assert.deepEqual(
      calendarResource.horizons[0]!.reasonCodes,
      ["CALENDAR_EVIDENCE_STALE"],
    );

    const priceBase = capture();
    const stalePricing = {
      ...priceBase,
      rates: priceBase.rates.map((item) =>
        item.service === "EKS"
          ? {
            ...item,
            source: reference(
              "pricing_eks",
              "AWS_PRICING",
              "pricing:GetProducts",
              {
                retrievedAt: "2026-05-01T10:00:00.000Z",
                effectiveAt: "2026-05-01T00:00:00.000Z",
              },
            ),
          }
          : item
      ),
    };
    const priceResult = buildExtendedSupportProjection(
      stalePricing,
      boundary,
      NOW,
    );
    const priceResource = priceResult.resources.find((item) =>
      item.service === "EKS"
    )!;
    assert.equal(priceResource.pricingFreshness, "STALE");
    assert.equal(priceResource.horizons[0]!.projectedIncrementalCost, null);
    assert.deepEqual(
      priceResource.horizons[0]!.reasonCodes,
      ["PRICING_EVIDENCE_STALE"],
    );
  });

  it("documents the exact read-only operations without mutation permissions", () => {
    assert.deepEqual(EXTENDED_SUPPORT_READ_OPERATIONS, [
      "eks:ListClusters",
      "eks:DescribeCluster",
      "eks:DescribeClusterVersions",
      "rds:DescribeDBInstances",
      "rds:DescribeDBClusters",
      "rds:DescribeDBMajorEngineVersions",
      "rds:DescribeOrderableDBInstanceOptions",
      "es:ListDomainNames",
      "es:DescribeDomain",
      "es:DescribeDomains",
      "elasticache:DescribeCacheClusters",
      "elasticache:DescribeReplicationGroups",
      "elasticache:DescribeCacheEngineVersions",
      "pricing:GetProducts",
    ]);
    assert.equal(
      EXTENDED_SUPPORT_READ_OPERATIONS.some((operation) =>
        /(?:Create|Delete|Modify|Update)/u.test(operation)
      ),
      false,
    );
  });
});
