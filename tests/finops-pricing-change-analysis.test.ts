import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRICING_CHANGE_ASSUMPTIONS,
  PRICING_CHANGE_READ_OPERATIONS,
  PricingChangeAnalysisError,
  buildPricingChangeAnalysis,
  type PricingCatalogRole,
  type PricingChangeCapture,
  type PricingChangeCatalogSnapshot,
  type PricingChangeCatalogTerm,
  type PricingChangeEvidenceReference,
  type PricingChangeTenantBoundary,
  type PricingChangeUsageRecord,
} from "../lib/finops-pricing-change-analysis.ts";

const NOW = new Date("2026-07-31T12:00:00.000Z");
const PAYER = "111111111111";
const LINKED = "222222222222";
const REGION = "us-east-1";
const scope = {
  orgId: "org_alpha",
  customerId: "customer_alpha",
  connectionId: "conn_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};
const boundary: PricingChangeTenantBoundary = {
  scope,
  partition: "aws",
  payerAccountIds: [PAYER],
  linkedAccountIds: [LINKED],
  regions: [REGION],
};
const GENERATION_ID = `gen_${"a".repeat(64)}`;
const BASELINE_SNAPSHOT_ID = `pls_${"b".repeat(64)}`;
const COMPARISON_SNAPSHOT_ID = `pls_${"c".repeat(64)}`;

function evidence(
  id: string,
  kind: PricingChangeEvidenceReference["kind"],
  effectiveAt: string,
  overrides: Partial<PricingChangeEvidenceReference> = {},
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
    url: kind === "AWS_PRICE_LIST_FILE"
      ? "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonEC2/index.json"
      : "https://docs.aws.amazon.com/cur/latest/userguide/table-dictionary-cur2.html",
    retrievedAt: "2026-07-31T10:00:00.000Z",
    effectiveAt,
    sha256: "d".repeat(64),
    ...overrides,
  };
}

function snapshot(
  role: PricingCatalogRole,
  overrides: Partial<PricingChangeCatalogSnapshot> = {},
): PricingChangeCatalogSnapshot {
  const baseline = role === "BASELINE";
  const requestedEffectiveAt = baseline
    ? "2025-01-15T00:00:00.000Z"
    : "2026-01-15T00:00:00.000Z";
  const catalogEffectiveAt = baseline
    ? "2025-01-01T00:00:00.000Z"
    : "2026-01-01T00:00:00.000Z";
  const version = baseline ? "20250101000000" : "20260101000000";
  return {
    snapshotId: baseline ? BASELINE_SNAPSHOT_ID : COMPARISON_SNAPSHOT_ID,
    role,
    partition: "aws",
    serviceCode: "AmazonEC2",
    region: REGION,
    currency: "USD",
    requestedEffectiveAt,
    catalogEffectiveAt,
    catalogPublicationAt: catalogEffectiveAt,
    catalogVersion: version,
    priceListArn: `arn:aws:pricing:::price-list/aws/AmazonEC2/USD/${version}/${REGION}`,
    fileFormat: "json",
    listEvidence: evidence(
      `list_${role.toLowerCase()}`,
      "AWS_PRICE_LIST_API",
      requestedEffectiveAt,
    ),
    fileEvidence: evidence(
      `file_${role.toLowerCase()}`,
      "AWS_PRICE_LIST_FILE",
      catalogEffectiveAt,
    ),
    ...overrides,
  };
}

function term(
  role: PricingCatalogRole,
  overrides: Partial<PricingChangeCatalogTerm> = {},
): PricingChangeCatalogTerm {
  const baseline = role === "BASELINE";
  return {
    priceId: baseline ? "price_baseline" : "price_comparison",
    snapshotId: baseline ? BASELINE_SNAPSHOT_ID : COMPARISON_SNAPSHOT_ID,
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
    ...overrides,
  };
}

function usage(
  overrides: Partial<PricingChangeUsageRecord> = {},
): PricingChangeUsageRecord {
  return {
    usageId: "usage_1",
    generationId: GENERATION_ID,
    payerAccountId: PAYER,
    linkedAccountId: LINKED,
    serviceCode: "AmazonEC2",
    region: REGION,
    usageStartAt: "2026-06-01T00:00:00.000Z",
    usageEndAt: "2026-07-01T00:00:00.000Z",
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
    source: evidence(
      "cur2_usage_1",
      "CUR2_DATA_EXPORT",
      "2026-06-01T00:00:00.000Z",
    ),
    ...overrides,
  };
}

function capture(
  overrides: Partial<PricingChangeCapture> = {},
): PricingChangeCapture {
  return {
    schemaVersion: "sutra.pricing-change.capture.v1",
    scope,
    partition: "aws",
    payerAccountIds: [PAYER],
    linkedAccountIds: [LINKED],
    regions: [REGION],
    collectionId: `pca_${"e".repeat(64)}`,
    startedAt: "2026-07-31T10:55:00.000Z",
    completedAt: "2026-07-31T11:00:00.000Z",
    usagePeriodStartAt: "2026-06-01T00:00:00.000Z",
    usagePeriodEndAt: "2026-07-01T00:00:00.000Z",
    baselineEffectiveAt: "2025-01-15T00:00:00.000Z",
    comparisonEffectiveAt: "2026-01-15T00:00:00.000Z",
    activeCur2GenerationId: GENERATION_ID,
    activeCur2GeneratedAt: "2026-07-31T10:00:00.000Z",
    activeCur2ManifestSha256: "f".repeat(64),
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
    usage: [usage()],
    catalogSnapshots: [snapshot("BASELINE"), snapshot("COMPARISON")],
    catalogTerms: [term("BASELINE"), term("COMPARISON")],
    ...overrides,
  };
}

function expectCode(code: string, run: () => unknown): void {
  assert.throws(run, (error: unknown) => {
    assert.ok(error instanceof PricingChangeAnalysisError);
    assert.equal(error.code, code);
    assert.equal(error.message, code);
    return true;
  });
}

describe("AWS Pricing Change Analysis", () => {
  it("re-prices active CUR2 usage with exact rational arithmetic", () => {
    const result = buildPricingChangeAnalysis(boundary, capture(), NOW);

    assert.equal(result.state, "READY");
    assert.deepEqual(PRICING_CHANGE_READ_OPERATIONS, [
      "pricing:ListPriceLists",
      "pricing:GetPriceListFileUrl",
    ]);
    assert.deepEqual(result.assumptions, PRICING_CHANGE_ASSUMPTIONS);
    assert.equal(result.summary.modeledLineCount, 1);
    assert.equal(result.summary.excludedLineCount, 0);
    assert.equal(result.groups.length, 1);
    assert.deepEqual(result.groups[0]?.usage, {
      unit: "Hrs",
      exactNumerator: "3",
      exactDenominator: "10",
    });
    assert.deepEqual(result.groups[0]?.baselineModeledCost, {
      currency: "USD",
      exactNumerator: "3",
      exactDenominator: "100",
      roundedMicros: "30000",
    });
    assert.deepEqual(result.groups[0]?.comparisonModeledCost, {
      currency: "USD",
      exactNumerator: "3",
      exactDenominator: "80",
      roundedMicros: "37500",
    });
    assert.deepEqual(result.groups[0]?.modeledChange, {
      currency: "USD",
      exactNumerator: "3",
      exactDenominator: "400",
      roundedMicros: "7500",
    });
    assert.deepEqual(result.groups[0]?.catalogSnapshotIds, [
      BASELINE_SNAPSHOT_ID,
      COMPARISON_SNAPSHOT_ID,
    ]);
    assert.deepEqual(result.catalogEvidence.map((entry) => ({
      role: entry.role,
      requestedEffectiveAt: entry.requestedEffectiveAt,
      catalogPublicationAt: entry.catalogPublicationAt,
      listResponseSha256: entry.listResponseSha256,
      priceListFileSha256: entry.priceListFileSha256,
    })), [
      {
        role: "BASELINE",
        requestedEffectiveAt: "2025-01-15T00:00:00.000Z",
        catalogPublicationAt: "2025-01-01T00:00:00.000Z",
        listResponseSha256: "d".repeat(64),
        priceListFileSha256: "d".repeat(64),
      },
      {
        role: "COMPARISON",
        requestedEffectiveAt: "2026-01-15T00:00:00.000Z",
        catalogPublicationAt: "2026-01-01T00:00:00.000Z",
        listResponseSha256: "d".repeat(64),
        priceListFileSha256: "d".repeat(64),
      },
    ]);
  });

  it("keeps payer, linked account, Region, unit, term, and currency isolated", () => {
    const secondLinked = "333333333333";
    const secondUsage = usage({
      usageId: "usage_2",
      linkedAccountId: secondLinked,
      usageQuantity: { numerator: "1", denominator: "4" },
      source: evidence(
        "cur2_usage_2",
        "CUR2_DATA_EXPORT",
        "2026-06-01T00:00:00.000Z",
      ),
    });
    const result = buildPricingChangeAnalysis(
      { ...boundary, linkedAccountIds: [LINKED, secondLinked] },
      capture({
        linkedAccountIds: [LINKED, secondLinked],
        usage: [usage(), secondUsage],
      }),
      NOW,
    );

    assert.equal(result.groups.length, 2);
    assert.deepEqual(result.groups.map((entry) => entry.linkedAccountId), [
      LINKED,
      secondLinked,
    ]);
    assert.deepEqual(result.summary.modeledTotalsByCurrency[0]?.baselineModeledCost, {
      currency: "USD",
      exactNumerator: "11",
      exactDenominator: "200",
      roundedMicros: "55000",
    });
  });

  it("suppresses mismatched applicability instead of inventing a price", () => {
    const result = buildPricingChangeAnalysis(
      boundary,
      capture({
        catalogTerms: [
          term("BASELINE"),
          term("COMPARISON", {
            applicabilityAttributes: [
              { name: "instanceType", value: "m8i.large" },
              { name: "operation", value: "RunInstances" },
              { name: "tenancy", value: "Shared" },
            ],
          }),
        ],
      }),
      NOW,
    );

    assert.equal(result.state, "CONFIGURATION_REQUIRED");
    assert.equal(result.groups.length, 0);
    assert.equal(result.summary.modeledTotalsByCurrency.length, 0);
    assert.equal(result.exclusions[0]?.reason, "PRICE_PRODUCT_APPLICABILITY_MISMATCH");
    assert.equal(result.exclusions[0]?.excludedLineCount, 1);
  });

  it("reports a modeled decrease as signed change, never as savings", () => {
    const result = buildPricingChangeAnalysis(
      boundary,
      capture({
        catalogTerms: [
          term("BASELINE"),
          term("COMPARISON", {
            unitPrice: { numerator: "1", denominator: "20" },
          }),
        ],
      }),
      NOW,
    );

    assert.deepEqual(result.groups[0]?.modeledChange, {
      currency: "USD",
      exactNumerator: "-3",
      exactDenominator: "200",
      roundedMicros: "-15000",
    });
    assert.equal(JSON.stringify(result).toLowerCase().includes("savings"), true);
    assert.ok(result.assumptions.includes("NOT_AN_INVOICE_FORECAST_QUOTE_OR_SAVINGS_CLAIM"));
    assert.equal(Object.hasOwn(result.groups[0]!, "savings"), false);
  });

  it("does not apply tiered prices without allocation evidence", () => {
    const result = buildPricingChangeAnalysis(
      boundary,
      capture({
        catalogTerms: [
          term("BASELINE", {
            endRange: { numerator: "100", denominator: "1" },
          }),
          term("COMPARISON"),
        ],
      }),
      NOW,
    );

    assert.equal(result.state, "CONFIGURATION_REQUIRED");
    assert.equal(result.exclusions[0]?.reason, "TIERED_RATE_REQUIRES_ALLOCATION_EVIDENCE");
  });

  it("distinguishes complete empty usage from incomplete collection", () => {
    const empty = buildPricingChangeAnalysis(
      boundary,
      capture({ usage: [] }),
      NOW,
    );
    assert.equal(empty.state, "NO_USAGE");

    const incomplete = buildPricingChangeAnalysis(
      boundary,
      capture({
        cur2Coverage: {
          status: "PARTIAL",
          readPermissionsValidated: true,
          manifestObjectCount: 2,
          processedObjectCount: 1,
          errorCode: "OBJECT_READ_INCOMPLETE",
        },
      }),
      NOW,
    );
    assert.equal(incomplete.state, "CONFIGURATION_REQUIRED");
    assert.equal(incomplete.exclusions[0]?.reason, "CUR2_SOURCE_INCOMPLETE");
  });

  it("suppresses stale active CUR2 and stale catalog retrieval independently", () => {
    const staleCur = buildPricingChangeAnalysis(
      boundary,
      capture({
        activeCur2GeneratedAt: "2026-07-28T00:00:00.000Z",
        usage: [usage({
          source: evidence(
            "cur2_usage_1",
            "CUR2_DATA_EXPORT",
            "2026-06-01T00:00:00.000Z",
            { retrievedAt: "2026-07-28T00:00:00.000Z" },
          ),
        })],
      }),
      NOW,
    );
    assert.equal(staleCur.state, "STALE");
    assert.equal(staleCur.exclusions[0]?.reason, "STALE_CUR2_GENERATION");

    const staleFile = evidence(
      "file_comparison",
      "AWS_PRICE_LIST_FILE",
      "2026-01-01T00:00:00.000Z",
      { retrievedAt: "2026-06-01T00:00:00.000Z" },
    );
    const staleCatalog = buildPricingChangeAnalysis(
      boundary,
      capture({
        catalogSnapshots: [
          snapshot("BASELINE"),
          snapshot("COMPARISON", { fileEvidence: staleFile }),
        ],
      }),
      NOW,
    );
    assert.equal(staleCatalog.state, "STALE");
    assert.equal(staleCatalog.exclusions[0]?.reason, "STALE_COMPARISON_CATALOG");
  });

  it("fails closed on cross-tenant scope and price-list partition mismatch", () => {
    const foreign = capture({ scope: { ...scope, customerId: "customer_beta" } });
    expectCode("SCOPE_MISMATCH", () =>
      buildPricingChangeAnalysis(boundary, foreign, NOW)
    );

    const wrongPartition = capture({
      catalogSnapshots: [
        snapshot("BASELINE", {
          priceListArn:
            "arn:aws-cn:pricing:::price-list/aws/AmazonEC2/USD/20250101000000/us-east-1",
        }),
        snapshot("COMPARISON"),
      ],
    });
    expectCode("INVALID_INPUT", () =>
      buildPricingChangeAnalysis(boundary, wrongPartition, NOW)
    );
  });

  it("rejects conflicting duplicate identities and non-decimal rationals", () => {
    const duplicate = capture({
      catalogTerms: [
        term("BASELINE"),
        term("BASELINE", { unitPrice: { numerator: "1", denominator: "5" } }),
        term("COMPARISON"),
      ],
    });
    expectCode("CONFLICTING_DUPLICATE", () =>
      buildPricingChangeAnalysis(boundary, duplicate, NOW)
    );

    const nonDecimal = capture({
      usage: [usage({ usageQuantity: { numerator: "1", denominator: "3" } })],
    });
    expectCode("INVALID_INPUT", () =>
      buildPricingChangeAnalysis(boundary, nonDecimal, NOW)
    );
  });

  it("requires exact object schemas and returns only generic error codes", () => {
    const extra: PricingChangeCapture & { readonly rawProviderError: string } = {
      ...capture(),
      rawProviderError: "customer secret from upstream",
    };
    expectCode("INVALID_INPUT", () =>
      buildPricingChangeAnalysis(boundary, extra, NOW)
    );
  });
});
