import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import type { CanonicalCurLine } from "../lib/finops-cur.ts";
import {
  DATA_TRANSFER_ADDITIONAL_READ_OPERATIONS,
  DATA_TRANSFER_TAXONOMY,
  DATA_TRANSFER_TAXONOMY_CANONICAL,
  DataTransferAnalysisError,
  buildDataTransferAnalysis,
  type DataTransferCapture,
  type DataTransferCur2Evidence,
  type DataTransferTenantBoundary,
} from "../lib/finops-data-transfer.ts";
import type {
  FinopsReconciliationScope,
  ScopedCanonicalBillingRow,
} from "../lib/finops-reconciliation.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const PAYER = "111111111111";
const MEMBER = "222222222222";
const GENERATION = `fbg_${"a".repeat(64)}`;
const SCOPE: FinopsReconciliationScope = {
  organizationId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: "conn_alpha",
  exportName: "sutra_cur2",
  billingPeriod: "2026-07",
  generationId: GENERATION,
};
const BOUNDARY: DataTransferTenantBoundary = {
  scope: SCOPE,
  payerAccountIds: [PAYER],
  usageAccountIds: [PAYER, MEMBER],
};

type Mutable<T> = T extends readonly (infer Item)[]
  ? Mutable<Item>[]
  : T extends object
    ? { -readonly [Key in keyof T]: Mutable<T[Key]> }
    : T;

function line(
  lineItemId: string,
  usageType: string | null,
  overrides: Partial<CanonicalCurLine> = {},
): CanonicalCurLine {
  return {
    lineItemId,
    usageAccountId: MEMBER,
    service: "Amazon Elastic Compute Cloud",
    chargeCategory: "Usage",
    usageStartIso: "2026-07-31T10:00:00.000Z",
    amountMicros: "1000000",
    currency: "USD",
    region: "us-east-1",
    amortizedMicros: "1000000",
    commitmentType: null,
    commitmentId: null,
    commitmentExpiry: null,
    usageType,
    usageAmountMicros: "2000000",
    usageUnit: "GB",
    tags: {},
    sourceFormat: "aws-cur",
    sourceVersion: "2.0",
    payerAccountId: PAYER,
    payerAccountName: "Example payer",
    usageAccountName: "Payments production",
    billingPeriodStartIso: "2026-07-01T00:00:00.000Z",
    billingPeriodEndIso: "2026-08-01T00:00:00.000Z",
    usageEndIso: "2026-07-31T11:00:00.000Z",
    invoiceId: "invoice-2026-07",
    invoiceIssuerId: null,
    invoiceIssuerName: "Amazon Web Services, Inc.",
    billingEntity: "AWS",
    legalEntity: "Amazon Web Services, Inc.",
    billType: "Anniversary",
    resourceId: "i-0123456789abcdef0",
    resourceName: null,
    resourceType: "AWS::EC2::Instance",
    availabilityZone: "us-east-1a",
    operation: "RunInstances",
    productCode: "AmazonEC2",
    productName: "Amazon Elastic Compute Cloud",
    productFamily: "Data Transfer",
    serviceCategory: "Compute",
    serviceSubcategory: null,
    chargeClass: null,
    chargeDescription: "data transfer",
    chargeFrequency: "Usage-Based",
    chargeKind: "usage",
    taxType: null,
    taxMicros: null,
    creditMicros: null,
    refundMicros: null,
    netUnblendedCostMicros: "900000",
    listCostMicros: "1100000",
    contractedCostMicros: "950000",
    publicOnDemandCostMicros: "1100000",
    listUnitPriceMicros: "500000",
    contractedUnitPriceMicros: "475000",
    publicOnDemandRateMicros: "500000",
    pricingCurrency: "USD",
    pricingCurrencyEffectiveCostMicros: "900000",
    pricingCurrencyListUnitPriceMicros: "500000",
    pricingCurrencyContractedUnitPriceMicros: "475000",
    pricingCategory: "OnDemand",
    pricingTerm: "OnDemand",
    pricingRateId: "rate-1",
    commitmentName: null,
    commitmentCategory: null,
    commitmentStatus: null,
    commitmentStart: null,
    commitmentQuantityMicros: null,
    commitmentUnit: null,
    commitmentPurchaseOption: null,
    capacityReservationId: null,
    capacityReservationStatus: null,
    costCategories: {},
    ...overrides,
  };
}

function scoped(entry: CanonicalCurLine): ScopedCanonicalBillingRow {
  return { ...SCOPE, line: entry };
}

function evidence(
  rows: readonly ScopedCanonicalBillingRow[],
  overrides: Partial<DataTransferCur2Evidence> = {},
): DataTransferCur2Evidence {
  return {
    source: "AWS_CUR2_ACTIVE_GENERATION",
    sourceFormat: "aws-cur",
    sourceVersion: "2.0",
    sourceEvidenceId: "cur2:sutra_cur2:2026-07:manifest-001",
    manifestSha256: "b".repeat(64),
    generationId: GENERATION,
    generationState: "ACTIVE",
    generatedAtIso: "2026-07-31T11:30:00.000Z",
    dataThroughAtIso: "2026-07-31T11:00:00.000Z",
    observedAtIso: "2026-07-31T11:35:00.000Z",
    payerAccountIds: [PAYER],
    usageAccountIds: [PAYER, MEMBER],
    status: "SUCCEEDED",
    manifestObjectCount: 2,
    processedObjectCount: 2,
    sourceRowCount: rows.length,
    acceptedRowCount: rows.length,
    rejectedRowCount: 0,
    rowsExhausted: true,
    errorCode: null,
    ...overrides,
  };
}

function capture(
  rows: readonly ScopedCanonicalBillingRow[],
  overrides: Partial<DataTransferCapture> = {},
): DataTransferCapture {
  return {
    schemaVersion: "sutra.finops-data-transfer-capture.v1",
    scope: SCOPE,
    evidence: evidence(rows),
    rows,
    ...overrides,
  };
}

function expectCode(code: string, run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof DataTransferAnalysisError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

describe("AWS Data Transfer analysis", () => {
  it("pins the official CUR2 taxonomy and requires no additional AWS reads", () => {
    assert.deepEqual(DATA_TRANSFER_ADDITIONAL_READ_OPERATIONS, []);
    assert.equal(DATA_TRANSFER_TAXONOMY.version, "2026-08-01.v2");
    assert.match(DATA_TRANSFER_TAXONOMY.sha256, /^[a-f0-9]{64}$/u);
    assert.match(DATA_TRANSFER_TAXONOMY_CANONICAL, /CLOUDFRONT_PRODUCT_OUT_BYTES_V1/u);
    assert.equal(
      createHash("sha256").update(DATA_TRANSFER_TAXONOMY_CANONICAL).digest("hex"),
      DATA_TRANSFER_TAXONOMY.sha256,
    );
    assert.equal(DATA_TRANSFER_TAXONOMY.rules.length, 6);
    assert.equal(DATA_TRANSFER_TAXONOMY.references.every((url) =>
      url.startsWith("https://docs.aws.amazon.com/")
      || url.startsWith("https://pricing.us-east-1.amazonaws.com/")), true);
  });

  it("separates Global Accelerator premium transfer and fixed fees from generic internet traffic", () => {
    const rows = [
      scoped(line("ga-premium", "NA-EU-OUT-Bytes-Internet", {
        productCode: "AWSGlobalAccelerator",
        productFamily: "AWS Global Accelerator",
        service: "AWS Global Accelerator",
      })),
      scoped(line("ga-fixed", "Global-Accelerator-fixed-fee", {
        productCode: "AWSGlobalAccelerator",
        productFamily: "AWS Global Accelerator",
        service: "AWS Global Accelerator",
        usageAmountMicros: "1000000",
        usageUnit: "Hrs",
      })),
    ];
    const result = buildDataTransferAnalysis(BOUNDARY, capture(rows), NOW);
    assert.deepEqual(result.categorySummaries.map(({ category }) => category), [
      "GLOBAL_ACCELERATOR",
    ]);
    assert.deepEqual(result.categorySummaries[0]?.directionCounts, {
      INBOUND: 0,
      OUTBOUND: 1,
      UNKNOWN: 1,
    });
    assert.deepEqual(
      result.drilldowns.flatMap(({ classificationRuleIds }) => classificationRuleIds).sort(),
      [
        "GLOBAL_ACCELERATOR_FIXED_FEE_V1",
        "GLOBAL_ACCELERATOR_TRANSFER_PREMIUM_V1",
      ],
    );
    assert.equal(result.coverage.classification, "complete");
  });

  it("classifies internet, inter-region, inter-AZ, and CloudFront from CUR evidence", () => {
    const rows = [
      scoped(line("internet", "USE1-DataTransfer-Out-Bytes")),
      scoped(line("inter-region", "USE1-EUW1-AWS-Out-Bytes", { region: "us-east-1" })),
      scoped(line("inter-az", "USE1-DataTransfer-Regional-Bytes")),
      scoped(line("cloudfront", "AP-DataTransfer-Out-OBytes", {
        productCode: "AmazonCloudFront",
        service: "Amazon CloudFront",
        region: null,
        availabilityZone: null,
        resourceId: "E123EXAMPLE",
      })),
    ];
    const result = buildDataTransferAnalysis(BOUNDARY, capture(rows), NOW);

    assert.equal(result.state, "COMPLETE");
    assert.equal(result.complete, true);
    assert.deepEqual(result.categorySummaries.map(({ category }) => category), [
      "CLOUDFRONT",
      "INTERNET",
      "INTER_AZ",
      "INTER_REGION",
    ]);
    assert.equal(result.coverage.classification, "complete");
    assert.equal(result.coverage.classifiedRowCount, 4);
    assert.equal(result.coverage.dimensions.region, "partial");
    assert.equal(result.drilldowns.find(({ category }) => category === "INTER_REGION")?.direction, "OUTBOUND");
    assert.deepEqual(
      result.drilldowns.find(({ category }) => category === "CLOUDFRONT")?.classificationRuleIds,
      ["CLOUDFRONT_PRODUCT_OUT_BYTES_V1"],
    );
  });

  it("retains signed corrections in exact cost and byte arithmetic", () => {
    const rows = [
      scoped(line("internet-charge", "USE1-DataTransfer-Out-Bytes", {
        amountMicros: "10000000",
        amortizedMicros: "9000000",
        usageAmountMicros: "2000000",
      })),
      scoped(line("internet-correction", "USE1-DataTransfer-Out-Bytes", {
        amountMicros: "-3000000",
        amortizedMicros: "-2500000",
        usageAmountMicros: "-500000",
        chargeKind: "adjustment",
      })),
    ];
    const result = buildDataTransferAnalysis(BOUNDARY, capture(rows), NOW);
    const summary = result.categorySummaries[0];
    const drilldown = result.drilldowns[0];

    assert.equal(summary?.costs.find(({ basis }) => basis === "unblended")?.totalMicros, "7000000");
    assert.equal(summary?.costs.find(({ basis }) => basis === "amortized")?.totalMicros, "6500000");
    assert.equal(summary?.quantities[0]?.quantityMicros, "1500000");
    assert.equal(summary?.normalizedBytesMicros, "1500000000000000");
    assert.equal(drilldown?.rowCount, 2);
    assert.deepEqual(drilldown?.sourceLineIds, ["internet-charge", "internet-correction"]);
  });

  it("provides account, service, region, AZ, and resource drilldowns with basis coverage", () => {
    const result = buildDataTransferAnalysis(
      BOUNDARY,
      capture([scoped(line("line-1", "USE1-DataTransfer-Out-Bytes", {
        amortizedMicros: null,
      }))]),
      NOW,
    );
    const group = result.drilldowns[0];
    assert.equal(group?.usageAccountId, MEMBER);
    assert.equal(group?.service, "Amazon Elastic Compute Cloud");
    assert.equal(group?.region, "us-east-1");
    assert.equal(group?.availabilityZone, "us-east-1a");
    assert.equal(group?.resourceId, "i-0123456789abcdef0");
    assert.equal(group?.costs.find(({ basis }) => basis === "unblended")?.coverage, "complete");
    assert.equal(group?.costs.find(({ basis }) => basis === "amortized")?.coverage, "unavailable");
  });

  it("keeps missing usage types unknown and novel transfer signals unclassified", () => {
    const rows = [
      scoped(line("unknown", null)),
      scoped(line("direct-connect", "USE1-DataXfer-Out:dc.3")),
      scoped(line("not-transfer", "USE1-BoxUsage:m7i.large", { productFamily: "Compute Instance" })),
    ];
    const result = buildDataTransferAnalysis(BOUNDARY, capture(rows), NOW);

    assert.equal(result.coverage.transferCandidateRowCount, 2);
    assert.equal(result.coverage.unknownRowCount, 1);
    assert.equal(result.coverage.unclassifiedRowCount, 1);
    assert.equal(result.coverage.excludedNonTransferRowCount, 1);
    assert.equal(result.coverage.classification, "partial");
    assert.deepEqual(result.categorySummaries.map(({ category }) => category), ["UNCLASSIFIED", "UNKNOWN"]);
  });

  it("discloses missing quantities and unknown units instead of inventing bytes", () => {
    const rows = [
      scoped(line("missing-quantity", "USE1-DataTransfer-Out-Bytes", {
        usageAmountMicros: null,
        usageUnit: null,
      })),
      scoped(line("unknown-unit", "USE1-DataTransfer-Out-Bytes", {
        usageAmountMicros: "3000000",
        usageUnit: "GB-Month",
      })),
    ];
    const result = buildDataTransferAnalysis(BOUNDARY, capture(rows), NOW);
    assert.equal(result.coverage.byteNormalization, "unavailable");
    assert.equal(result.coverage.missingQuantityRowCount, 1);
    assert.equal(result.coverage.unknownUnitRowCount, 1);
    assert.equal(result.categorySummaries[0]?.normalizedBytesMicros, null);
    assert.equal(result.categorySummaries[0]?.quantities[0]?.normalizedBytesMicros, null);
  });

  it("represents configuration, error, empty, partial, and stale source states honestly", () => {
    const configuration = buildDataTransferAnalysis(
      BOUNDARY,
      capture([], { evidence: null }),
      NOW,
    );
    assert.equal(configuration.state, "CONFIGURATION_REQUIRED");

    const failedEvidence = evidence([], {
      status: "FAILED",
      sourceRowCount: 0,
      acceptedRowCount: 0,
      rejectedRowCount: 0,
      rowsExhausted: false,
      processedObjectCount: 0,
      errorCode: "S3_ACCESS_DENIED",
    });
    assert.equal(buildDataTransferAnalysis(
      BOUNDARY,
      capture([], { evidence: failedEvidence }),
      NOW,
    ).state, "ERROR");

    assert.equal(buildDataTransferAnalysis(BOUNDARY, capture([]), NOW).state, "EMPTY");

    const partialRows = [scoped(line("partial", "USE1-DataTransfer-Out-Bytes"))];
    const partialEvidence = evidence(partialRows, {
      status: "PARTIAL",
      manifestObjectCount: 2,
      processedObjectCount: 1,
      sourceRowCount: 2,
      acceptedRowCount: 1,
      rowsExhausted: false,
      errorCode: "OBJECT_READ_FAILED",
    });
    const partial = buildDataTransferAnalysis(
      BOUNDARY,
      capture(partialRows, { evidence: partialEvidence }),
      NOW,
    );
    assert.equal(partial.state, "PARTIAL");
    assert.equal(partial.complete, false);
    assert.deepEqual(partial.source.objectCoverage, {
      status: "partial",
      manifestObjectCount: 2,
      processedObjectCount: 1,
    });

    const staleRows = [scoped(line("stale", "USE1-DataTransfer-Out-Bytes"))];
    const staleEvidence = evidence(staleRows, {
      generatedAtIso: "2026-07-20T12:00:00.000Z",
      dataThroughAtIso: "2026-07-20T11:00:00.000Z",
      observedAtIso: "2026-07-20T12:05:00.000Z",
    });
    assert.equal(buildDataTransferAnalysis(
      BOUNDARY,
      capture(staleRows, { evidence: staleEvidence }),
      NOW,
    ).state, "STALE");
  });

  it("keeps unavailable manifest object coverage null and forces a partial result", () => {
    const rows = [scoped(line(
      "object-coverage-unavailable",
      "USE1-DataTransfer-Out-Bytes",
    ))];
    const unavailable = evidence(rows, {
      status: "PARTIAL",
      generatedAtIso: null,
      dataThroughAtIso: null,
      manifestObjectCount: null,
      processedObjectCount: null,
      errorCode: "MANIFEST_OBJECT_COVERAGE_UNAVAILABLE",
    });
    const result = buildDataTransferAnalysis(
      BOUNDARY,
      capture(rows, { evidence: unavailable }),
      NOW,
    );

    assert.equal(result.state, "PARTIAL");
    assert.equal(result.complete, false);
    assert.equal(result.source.ageHours, null);
    assert.deepEqual(result.source.objectCoverage, {
      status: "unavailable",
      manifestObjectCount: null,
      processedObjectCount: null,
    });

    const dishonestSuccess = {
      ...unavailable,
      status: "SUCCEEDED" as const,
      errorCode: null,
    };
    expectCode("SOURCE_MISMATCH", () => buildDataTransferAnalysis(
      BOUNDARY,
      capture(rows, { evidence: dishonestSuccess }),
      NOW,
    ));
  });

  it("rejects cross-tenant scope and account substitutions", () => {
    const otherScope = { ...SCOPE, customerId: "customer_beta" };
    expectCode("SCOPE_MISMATCH", () => buildDataTransferAnalysis(
      BOUNDARY,
      { ...capture([]), scope: otherScope },
      NOW,
    ));

    const row = scoped(line("foreign", "USE1-DataTransfer-Out-Bytes", {
      usageAccountId: "999999999999",
    }));
    expectCode("SCOPE_MISMATCH", () => buildDataTransferAnalysis(
      BOUNDARY,
      capture([row]),
      NOW,
    ));
  });

  it("fails closed for inactive or substituted generations", () => {
    const inactive = capture([]) as Mutable<DataTransferCapture>;
    inactive.evidence!.generationState = "STAGED" as "ACTIVE";
    expectCode("IMMUTABILITY_VIOLATION", () => buildDataTransferAnalysis(BOUNDARY, inactive, NOW));

    const substituted = capture([]) as Mutable<DataTransferCapture>;
    substituted.evidence!.generationId = `fbg_${"f".repeat(64)}`;
    expectCode("IMMUTABILITY_VIOLATION", () => buildDataTransferAnalysis(BOUNDARY, substituted, NOW));
  });

  it("rejects duplicate line evidence and bounded drilldown overflow", () => {
    const duplicate = scoped(line("duplicate", "USE1-DataTransfer-Out-Bytes"));
    expectCode("DUPLICATE_EVIDENCE", () => buildDataTransferAnalysis(
      BOUNDARY,
      capture([duplicate, { ...duplicate }]),
      NOW,
    ));

    const rows = [
      scoped(line("one", "USE1-DataTransfer-Out-Bytes")),
      scoped(line("two", "USE1-DataTransfer-Out-Bytes", { resourceId: "i-other" })),
    ];
    expectCode("BOUND_EXCEEDED", () => buildDataTransferAnalysis(
      BOUNDARY,
      capture(rows, { groupLimit: 1 }),
      NOW,
    ));
  });

  it("rejects dishonest success evidence and non-CUR2 rows", () => {
    const rows = [scoped(line("line-1", "USE1-DataTransfer-Out-Bytes"))];
    const dishonest = evidence(rows, { processedObjectCount: 1 });
    expectCode("SOURCE_MISMATCH", () => buildDataTransferAnalysis(
      BOUNDARY,
      capture(rows, { evidence: dishonest }),
      NOW,
    ));

    const focus = scoped(line("focus", "USE1-DataTransfer-Out-Bytes", {
      sourceFormat: "focus",
      sourceVersion: "1.2",
    }));
    expectCode("SOURCE_MISMATCH", () => buildDataTransferAnalysis(
      BOUNDARY,
      capture([focus]),
      NOW,
    ));
  });

  it("is deterministic regardless of input order", () => {
    const rows = [
      scoped(line("b", "USE1-DataTransfer-Regional-Bytes", { resourceId: "r-b" })),
      scoped(line("a", "USE1-DataTransfer-Out-Bytes", { resourceId: "r-a" })),
    ];
    const forward = buildDataTransferAnalysis(BOUNDARY, capture(rows), NOW);
    const reversedRows = [...rows].reverse();
    const reversed = buildDataTransferAnalysis(BOUNDARY, capture(reversedRows), NOW);
    assert.deepEqual(forward.categorySummaries, reversed.categorySummaries);
    assert.deepEqual(forward.drilldowns, reversed.drilldowns);
  });
});
