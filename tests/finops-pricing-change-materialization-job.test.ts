import assert from "node:assert/strict";
import test from "node:test";

import {
  FINOPS_PRICING_CHANGE_MATERIALIZE_JOB_KIND,
  PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS,
  PricingChangeMaterializationJobError,
  runPricingChangeMaterializationJob,
  type PricingChangeActiveCur2Source,
  type PricingChangeMaterializationJobDependencies,
  type PricingChangeMaterializerRequest,
  type PricingChangeServerPolicy,
} from "../lib/finops-pricing-change-materialization-job.ts";
import type { RunnableJob } from "../lib/background-job-runner.ts";
import type {
  PricingCatalogRole,
  PricingChangeCapture,
  PricingChangeCatalogSnapshot,
  PricingChangeCatalogTerm,
  PricingChangeEvidenceReference,
} from "../lib/finops-pricing-change-analysis.ts";

const ORG = "org_pricing_materializer";
const CUSTOMER = "customer_pricing_materializer";
const CONNECTION = `conn_${"a".repeat(32)}`;
const PAYER = "111122223333";
const LINKED = "222233334444";
const REGION = "us-east-1";
const GENERATION = `fbg_${"b".repeat(64)}`;
const MANIFEST_SHA = "c".repeat(64);
const NOW = Date.parse("2026-08-01T12:00:00.000Z");
const SCOPE = { organizationId: ORG, customerId: CUSTOMER, connectionId: CONNECTION };

const POLICY: PricingChangeServerPolicy = {
  policyId: "monthly-public-price-comparison",
  scope: SCOPE,
  exportName: "sutra_foundational_cur2_v1",
  billingPeriod: "2026-06",
  baselineEffectiveAt: "2025-01-15T00:00:00.000Z",
  comparisonEffectiveAt: "2026-01-15T00:00:00.000Z",
};

const CUR2: PricingChangeActiveCur2Source = {
  source: "ACTIVE_RECONCILED_CUR2_GENERATION",
  scope: SCOPE,
  partition: "aws",
  exportName: POLICY.exportName,
  billingPeriod: POLICY.billingPeriod,
  generationId: GENERATION,
  manifestSha256: MANIFEST_SHA,
  generatedAtIso: "2026-07-31T10:00:00.000Z",
  usagePeriodStartAt: "2026-06-01T00:00:00.000Z",
  usagePeriodEndAt: "2026-07-01T00:00:00.000Z",
  sourceFormat: "aws-cur",
  sourceVersion: "2.0",
  payerAccountIds: [PAYER],
  linkedAccountIds: [LINKED],
  regions: [REGION],
  coverage: {
    readPermissionsValidated: true,
    manifestObjectCount: 2,
    processedObjectCount: 2,
    acceptedRowCount: 1,
    rejectedRowCount: 0,
  },
};

function job(overrides: Partial<RunnableJob> = {}): RunnableJob {
  return {
    id: "job_pricing_materializer_1",
    orgId: ORG,
    customerId: CUSTOMER,
    connectionId: CONNECTION,
    kind: FINOPS_PRICING_CHANGE_MATERIALIZE_JOB_KIND,
    payload: { connectionId: CONNECTION, policyId: POLICY.policyId },
    attempt: 1,
    maxAttempts: 6,
    ...overrides,
  };
}

function sourceEvidence(
  id: string,
  kind: PricingChangeEvidenceReference["kind"],
  effectiveAt: string,
): PricingChangeEvidenceReference {
  const operation = kind === "CUR2_DATA_EXPORT"
    ? "AWS_DATA_EXPORTS_CUR2"
    : kind === "AWS_PRICE_LIST_API"
      ? "pricing:ListPriceLists"
      : "pricing:GetPriceListFileUrl";
  return {
    id,
    kind,
    operation,
    url: kind === "CUR2_DATA_EXPORT"
      ? `https://cur2-evidence.s3.us-east-1.amazonaws.com/${id}`
      : `https://pricing.us-east-1.amazonaws.com/${id}`,
    retrievedAt: "2026-07-31T10:00:00.000Z",
    effectiveAt,
    sha256: id.startsWith("baseline") ? "1".repeat(64)
      : id.startsWith("comparison") ? "2".repeat(64) : "3".repeat(64),
  };
}

function catalogSnapshot(
  role: PricingCatalogRole,
  requestedEffectiveAt: string,
): PricingChangeCatalogSnapshot {
  const baseline = role === "BASELINE";
  const effective = baseline
    ? "2025-01-01T00:00:00.000Z"
    : "2026-01-01T00:00:00.000Z";
  const version = baseline ? "20250101000000" : "20260101000000";
  return {
    snapshotId: `pls_${(baseline ? "1" : "2").repeat(64)}`,
    role,
    partition: "aws",
    serviceCode: "AmazonEC2",
    region: REGION,
    currency: "USD",
    requestedEffectiveAt,
    catalogEffectiveAt: effective,
    catalogPublicationAt: effective,
    catalogVersion: version,
    priceListArn: `arn:aws:pricing:::price-list/aws/AmazonEC2/USD/${version}/${REGION}`,
    fileFormat: "json",
    listEvidence: sourceEvidence(
      `${baseline ? "baseline" : "comparison"}_list`,
      "AWS_PRICE_LIST_API",
      requestedEffectiveAt,
    ),
    fileEvidence: sourceEvidence(
      `${baseline ? "baseline" : "comparison"}_file`,
      "AWS_PRICE_LIST_FILE",
      effective,
    ),
  };
}

function catalogTerm(role: PricingCatalogRole): PricingChangeCatalogTerm {
  const baseline = role === "BASELINE";
  return {
    priceId: baseline ? "price_baseline" : "price_comparison",
    snapshotId: `pls_${(baseline ? "1" : "2").repeat(64)}`,
    serviceCode: "AmazonEC2",
    region: REGION,
    currency: "USD",
    productSku: "SKU123",
    offerTermCode: "JRTCKXETXF",
    rateCode: baseline ? "SKU123.JRTCKXETXF.OLD" : "SKU123.JRTCKXETXF.NEW",
    termType: "ON_DEMAND",
    usageUnit: "Hrs",
    applicabilityAttributes: [
      { name: "instanceType", value: "m7i.large" },
      { name: "operation", value: "RunInstances" },
      { name: "tenancy", value: "Shared" },
    ],
    beginRange: { numerator: "0", denominator: "1" },
    endRange: null,
    unitPrice: baseline
      ? { numerator: "1", denominator: "10" }
      : { numerator: "1", denominator: "8" },
    effectiveFromAt: baseline
      ? "2025-01-01T00:00:00.000Z"
      : "2026-01-01T00:00:00.000Z",
    effectiveToAt: null,
  };
}

function capture(request: PricingChangeMaterializerRequest): PricingChangeCapture {
  return {
    schemaVersion: "sutra.pricing-change.capture.v1",
    scope: request.boundary.scope,
    partition: request.boundary.partition,
    payerAccountIds: request.boundary.payerAccountIds,
    linkedAccountIds: request.boundary.linkedAccountIds,
    regions: request.boundary.regions,
    collectionId: request.collectionId,
    startedAt: "2026-08-01T11:55:00.000Z",
    completedAt: "2026-08-01T12:00:00.000Z",
    usagePeriodStartAt: CUR2.usagePeriodStartAt,
    usagePeriodEndAt: CUR2.usagePeriodEndAt,
    baselineEffectiveAt: POLICY.baselineEffectiveAt,
    comparisonEffectiveAt: POLICY.comparisonEffectiveAt,
    activeCur2GenerationId: GENERATION,
    activeCur2GeneratedAt: CUR2.generatedAtIso,
    activeCur2ManifestSha256: MANIFEST_SHA,
    cur2Coverage: {
      status: "SUCCEEDED",
      readPermissionsValidated: true,
      manifestObjectCount: 2,
      processedObjectCount: 2,
      errorCode: null,
    },
    catalogCoverage: [
      {
        role: "BASELINE",
        serviceCode: "AmazonEC2",
        region: REGION,
        currency: "USD",
        status: "SUCCEEDED",
        readPermissionsValidated: true,
        priceListCount: 1,
        processedPriceListCount: 1,
        errorCode: null,
      },
      {
        role: "COMPARISON",
        serviceCode: "AmazonEC2",
        region: REGION,
        currency: "USD",
        status: "SUCCEEDED",
        readPermissionsValidated: true,
        priceListCount: 1,
        processedPriceListCount: 1,
        errorCode: null,
      },
    ],
    usage: [{
      usageId: "usage_1",
      generationId: GENERATION,
      payerAccountId: PAYER,
      linkedAccountId: LINKED,
      serviceCode: "AmazonEC2",
      region: REGION,
      usageStartAt: CUR2.usagePeriodStartAt,
      usageEndAt: CUR2.usagePeriodEndAt,
      lineItemType: "USAGE",
      termType: "ON_DEMAND",
      currency: "USD",
      usageUnit: "Hrs",
      usageQuantity: { numerator: "3", denominator: "10" },
      applicabilityAttributes: [
        { name: "instanceType", value: "m7i.large" },
        { name: "operation", value: "RunInstances" },
        { name: "tenancy", value: "Shared" },
      ],
      baselinePriceId: "price_baseline",
      comparisonPriceId: "price_comparison",
      source: sourceEvidence("cur2_usage_1", "CUR2_DATA_EXPORT", CUR2.usagePeriodStartAt),
    }],
    catalogSnapshots: [
      catalogSnapshot("BASELINE", POLICY.baselineEffectiveAt),
      catalogSnapshot("COMPARISON", POLICY.comparisonEffectiveAt),
    ],
    catalogTerms: [catalogTerm("BASELINE"), catalogTerm("COMPARISON")],
  };
}

async function digest(body: Uint8Array): Promise<string> {
  const value = await crypto.subtle.digest("SHA-256", body as BufferSource);
  return [...new Uint8Array(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function dependencies(overrides: Partial<PricingChangeMaterializationJobDependencies> = {}) {
  const requests: PricingChangeMaterializerRequest[] = [];
  const archived: Uint8Array[] = [];
  const recorded: Array<{
    readonly scope: typeof SCOPE;
    readonly input: Parameters<PricingChangeMaterializationJobDependencies["materializations"]["recordMaterialization"]>[1];
  }> = [];
  const base: PricingChangeMaterializationJobDependencies = {
    loadPolicy: async () => POLICY,
    loadActiveCur2: async () => CUR2,
    materializer: {
      async collect(request) {
        requests.push(request);
        return capture(request);
      },
    },
    evidence: {
      async archive(input) {
        assert.match(input.runId, /^pcjob_[a-f0-9]{64}$/u);
        archived.push(input.body);
        return {
          id: `eobj_${"d".repeat(32)}`,
          status: "available",
          contentSha256: await digest(input.body),
        };
      },
    },
    sealer: {
      async seal(objectId, context) {
        assert.equal(objectId, `eobj_${"d".repeat(32)}`);
        assert.deepEqual(context, {
          organizationId: ORG,
          customerId: CUSTOMER,
          connectionId: CONNECTION,
          sourceId: "aws_pricing_catalog",
          generationId: context.generationId,
        });
        return { ciphertext: `fsev1.${"A".repeat(40)}`, keyVersion: "pricing-change-v1" };
      },
    },
    materializations: {
      async recordMaterialization(scope, input) {
        recorded.push({ scope: scope as typeof SCOPE, input });
        const state = input.snapshot.state === "READY" ? "ready" as const
          : input.snapshot.state === "NO_USAGE" ? "no_usage" as const
            : input.snapshot.state === "PARTIAL" ? "partial" as const
              : input.snapshot.state === "STALE" ? "stale" as const
                : "configuration_required" as const;
        return {
          becameActive: state === "ready" || state === "no_usage",
          materialization: {
            scope,
            snapshotId: input.snapshot.collectionId,
            evidenceGenerationId: input.evidenceGenerationId,
            state,
            contentSha256: input.contentSha256,
            evidenceReference: input.evidenceReference,
            capturedAt: input.snapshot.generatedAt,
            usagePeriodStartAt: input.snapshot.usagePeriodStartAt,
            usagePeriodEndAt: input.snapshot.usagePeriodEndAt,
            baselineEffectiveAt: input.snapshot.baselineEffectiveAt,
            comparisonEffectiveAt: input.snapshot.comparisonEffectiveAt,
            activeCur2GenerationId: input.snapshot.activeCur2GenerationId,
            inputLineCount: input.snapshot.summary.inputLineCount,
            modeledLineCount: input.snapshot.summary.modeledLineCount,
            excludedLineCount: input.snapshot.summary.excludedLineCount,
            catalogSnapshotCount: input.snapshot.summary.catalogSnapshotCount,
            catalogTermCount: input.snapshot.summary.catalogTermCount,
            createdAtIso: input.snapshot.generatedAt,
          },
        };
      },
    },
    now: () => NOW,
    ...overrides,
  };
  return { base, requests, archived, recorded };
}

function expectCode(code: PricingChangeMaterializationJobError["code"]) {
  return (error: unknown) => {
    assert.ok(error instanceof PricingChangeMaterializationJobError);
    assert.equal(error.code, code);
    return true;
  };
}

test("pins active CUR2 and historical Price List inputs, archives evidence, and preserves exact money", async () => {
  const context = dependencies();
  const result = await runPricingChangeMaterializationJob(job(), context.base);
  assert.equal(result.status, "materialized");
  if (result.status !== "materialized") return;
  assert.equal(context.requests.length, 1);
  assert.deepEqual(context.requests[0]?.historicalPriceList.operations, [
    "pricing:ListPriceLists",
    "pricing:GetPriceListFileUrl",
  ]);
  assert.equal(context.requests[0]?.activeCur2.generationId, GENERATION);
  assert.equal(context.requests[0]?.activeCur2.sourceFormat, "aws-cur");
  assert.equal(context.requests[0]?.historicalPriceList.selectionAxes,
    "ACTIVE_CUR2_SERVICE_REGION_CURRENCY_ONLY");
  assert.equal(result.report.state, "READY");
  assert.deepEqual(result.report.summary.modeledTotalsByCurrency[0], {
    currency: "USD",
    baselineModeledCost: {
      currency: "USD",
      exactNumerator: "3",
      exactDenominator: "100",
      roundedMicros: "30000",
    },
    comparisonModeledCost: {
      currency: "USD",
      exactNumerator: "3",
      exactDenominator: "80",
      roundedMicros: "37500",
    },
    modeledChange: {
      currency: "USD",
      exactNumerator: "3",
      exactDenominator: "400",
      roundedMicros: "7500",
    },
  });
  assert.equal(context.archived.length, 1);
  assert.match(result.evidenceGenerationId, /^fss_[a-f0-9]{64}$/u);
  const body = JSON.parse(new TextDecoder().decode(context.archived[0])) as Record<string, unknown>;
  assert.equal(body.schemaVersion, "sutra.pricing-change.capture-evidence.v1");
  assert.equal(JSON.stringify(body).includes("roleArn"), false);
  assert.equal(JSON.stringify(body).includes("temporaryCredentials"), false);
  assert.equal(context.recorded[0]?.input.snapshot.activeCur2GenerationId, GENERATION);
  assert.equal(result.becameActive, true);
});

test("returns honest unavailable reasons without fabricating or persisting captures", async () => {
  const noPolicy = dependencies({ loadPolicy: async () => null });
  assert.deepEqual(await runPricingChangeMaterializationJob(job(), noPolicy.base), {
    status: "unavailable",
    reason: PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS.policy,
  });
  assert.equal(noPolicy.requests.length, 0);
  assert.equal(noPolicy.recorded.length, 0);

  const noCur2 = dependencies({ loadActiveCur2: async () => null });
  assert.deepEqual(await runPricingChangeMaterializationJob(job(), noCur2.base), {
    status: "unavailable",
    reason: PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS.cur2,
  });
  assert.equal(noCur2.requests.length, 0);
  assert.equal(noCur2.recorded.length, 0);

  const noProvider = dependencies({ materializer: null });
  assert.deepEqual(await runPricingChangeMaterializationJob(job(), noProvider.base), {
    status: "unavailable",
    reason: PRICING_CHANGE_MATERIALIZER_ACTIVATION_REASONS.provider,
  });
  assert.equal(noProvider.archived.length, 0);
  assert.equal(noProvider.recorded.length, 0);
});

test("fails closed on tenant, generation, policy, and capture mismatches", async () => {
  const cases: Array<{
    readonly dependencies: Partial<PricingChangeMaterializationJobDependencies>;
    readonly code: PricingChangeMaterializationJobError["code"];
  }> = [
    {
      dependencies: { loadPolicy: async () => ({ ...POLICY, scope: { ...SCOPE, organizationId: "org_other" } }) },
      code: "POLICY_REJECTED",
    },
    {
      dependencies: { loadActiveCur2: async () => ({ ...CUR2, generationId: `gen_${"b".repeat(64)}` }) },
      code: "CUR2_REJECTED",
    },
    {
      dependencies: {
        materializer: {
          async collect(request) {
            return { ...capture(request), scope: { ...request.boundary.scope, orgId: "org_other" } };
          },
        },
      },
      code: "CAPTURE_REJECTED",
    },
    {
      dependencies: {
        materializer: {
          async collect(request) {
            return { ...capture(request), activeCur2GenerationId: `fbg_${"9".repeat(64)}` };
          },
        },
      },
      code: "CAPTURE_REJECTED",
    },
    {
      dependencies: {
        materializer: {
          async collect() {
            throw new Error("raw provider response must not cross the job boundary");
          },
        },
      },
      code: "CAPTURE_REJECTED",
    },
  ];
  for (const item of cases) {
    const context = dependencies(item.dependencies);
    await assert.rejects(
      runPricingChangeMaterializationJob(job(), context.base),
      expectCode(item.code),
    );
    assert.equal(context.archived.length, 0);
    assert.equal(context.recorded.length, 0);
  }
});

test("at-least-once replay derives identical capture and evidence generations", async () => {
  const context = dependencies();
  const first = await runPricingChangeMaterializationJob(job(), context.base);
  const replay = await runPricingChangeMaterializationJob(job(), context.base);
  assert.equal(first.status, "materialized");
  assert.equal(replay.status, "materialized");
  if (first.status !== "materialized" || replay.status !== "materialized") return;
  assert.equal(first.report.collectionId, replay.report.collectionId);
  assert.equal(first.evidenceGenerationId, replay.evidenceGenerationId);
  assert.equal(first.contentSha256, replay.contentSha256);
  assert.equal(context.recorded.length, 2);
});
