import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildFinopsCostIntelligence,
  type FinopsCostIntelligenceInput,
  type FinopsCostIntelligenceResult,
  type FinopsCostPeriod,
  type FinopsOrganizationTaxonomy,
} from "../lib/finops-cost-intelligence.ts";
import {
  parseCurCsv,
  type CanonicalCurLine,
} from "../lib/finops-cur.ts";
import type {
  FinopsReconciliationScope,
  ScopedCanonicalBillingRow,
} from "../lib/finops-reconciliation.ts";

const ACCOUNT_A = "111122223333";
const ACCOUNT_B = "444455556666";
const ACCOUNT_UNKNOWN = "777788889999";
const ORG_ID = "org_cost_intelligence";
const CUSTOMER_ID = "customer_cost_intelligence";
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const CUR_HEADER = [
  "line_item_id",
  "line_item_usage_account_id",
  "product_servicecode",
  "line_item_line_item_type",
  "line_item_usage_start_date",
  "line_item_unblended_cost",
  "line_item_currency_code",
].join(",");

const TAXONOMY: FinopsOrganizationTaxonomy = {
  scope: {
    organizationId: ORG_ID,
    customerId: CUSTOMER_ID,
    connectionId: CONNECTION_ID,
  },
  evidence: {
    source: "aws_organizations",
    sourceEvidenceId: "aws://organizations/account-taxonomy/2026-07-31",
    observedAtIso: "2026-07-31T00:00:00.000Z",
  },
  allowLists: {
    company: ["Acme"],
    business_unit: ["Platform"],
    environment: ["prod"],
    cost_center: ["CC-100"],
    account: [ACCOUNT_A, ACCOUNT_B],
  },
  assignments: [
    {
      accountId: ACCOUNT_A,
      company: "Acme",
      businessUnit: "Platform",
      environment: "prod",
      costCenter: "CC-100",
      owner: "Platform Team",
    },
    {
      accountId: ACCOUNT_B,
      company: "Acme",
      owner: "Shared Services",
    },
  ],
};

function scope(
  billingPeriod: string,
  generationCharacter: string,
): FinopsReconciliationScope {
  return {
    organizationId: ORG_ID,
    customerId: CUSTOMER_ID,
    connectionId: CONNECTION_ID,
    exportName: "aws-cur",
    billingPeriod,
    generationId: `fbg_${generationCharacter.repeat(64)}`,
  };
}

function canonicalLine(
  period: string,
  id: string,
  accountId: string,
  service: string,
  amount: string,
  currency = "USD",
  overrides: Partial<CanonicalCurLine> = {},
): CanonicalCurLine {
  const parsed = parseCurCsv([
    CUR_HEADER,
    [
      id,
      accountId,
      service,
      "Usage",
      `${period}-01T00:00:00Z`,
      amount,
      currency,
    ].join(","),
  ].join("\n"));
  if ("error" in parsed || parsed.lines[0] === undefined) {
    throw new Error("canonical fixture failed");
  }
  return { ...parsed.lines[0], ...overrides };
}

function billingPeriod(
  periodScope: FinopsReconciliationScope,
  lines: readonly CanonicalCurLine[],
  observedThroughIso?: string,
): FinopsCostPeriod {
  return {
    scope: periodScope,
    rows: lines.map((line): ScopedCanonicalBillingRow => ({
      ...periodScope,
      line,
    })),
    ...(observedThroughIso === undefined ? {} : { observedThroughIso }),
  };
}

function input(
  periods: readonly FinopsCostPeriod[],
  overrides: Partial<FinopsCostIntelligenceInput> = {},
): FinopsCostIntelligenceInput {
  return {
    periods,
    costBasis: "billed",
    allocationMode: "showback",
    taxonomy: TAXONOMY,
    pivotDimensions: ["service", "account"],
    forecast: { minimumPeriods: 3, trainingPeriods: 6 },
    commitments: {
      asOfIso: "2026-07-01T00:00:00.000Z",
      expiresWithinDays: 90,
      coverage: {
        evidenceLabel: "cur2-commitment-columns-2026-07",
        unusedChargesComplete: false,
        publicOnDemandCostComplete: false,
        usageQuantityComplete: false,
      },
    },
    ...overrides,
  };
}

function requireReport(result: FinopsCostIntelligenceResult) {
  assert.equal(result.ok, true, result.ok ? undefined : JSON.stringify(result.failures));
  if (!result.ok) throw new Error("expected report");
  return result;
}

function failureCodes(result: FinopsCostIntelligenceResult): readonly string[] {
  assert.equal(result.ok, false);
  return result.ok ? [] : result.failures.map(({ code }) => code);
}

describe("buildFinopsCostIntelligence", () => {
  it("reconciles taxonomy parents/children with explicit unallocated remainder and separate currencies", () => {
    const juneScope = scope("2026-06", "1");
    const julyScope = scope("2026-07", "2");
    const periods = [
      billingPeriod(juneScope, [
        canonicalLine("2026-06", "june", ACCOUNT_A, "AmazonEC2", "1.00"),
      ]),
      billingPeriod(julyScope, [
        canonicalLine("2026-07", "direct", ACCOUNT_A, "AmazonEC2", "100.00"),
        canonicalLine("2026-07", "credit", ACCOUNT_A, "AWS Credits", "-10.00", "USD", {
          chargeKind: "credit",
          chargeCategory: "Credit",
          creditMicros: "-10000000",
        }),
        canonicalLine("2026-07", "partial", ACCOUNT_B, "AmazonS3", "50.00"),
        canonicalLine("2026-07", "refund", ACCOUNT_B, "AWS Refund", "-5.00", "USD", {
          chargeKind: "refund",
          chargeCategory: "Refund",
          refundMicros: "-5000000",
        }),
        canonicalLine("2026-07", "unknown", ACCOUNT_UNKNOWN, "AmazonRDS", "25.00"),
        canonicalLine("2026-07", "tax", ACCOUNT_A, "AWS Tax", "10.00", "USD", {
          chargeKind: "tax",
          chargeCategory: "Tax",
          taxMicros: "10000000",
        }),
        canonicalLine("2026-07", "support", ACCOUNT_A, "AWS Support", "20.00"),
        canonicalLine("2026-07", "marketplace", ACCOUNT_A, "Vendor Product", "30.00", "USD", {
          billingEntity: "AWS Marketplace",
        }),
        canonicalLine("2026-07", "euro", ACCOUNT_A, "AmazonEC2", "10.00", "EUR"),
      ]),
    ];

    const showback = requireReport(buildFinopsCostIntelligence(input(periods)));
    const usd = showback.allocations.find((entry) =>
      entry.period === "2026-07" && entry.currency === "USD");
    assert.ok(usd);
    assert.equal(usd.sourceTotalMicros, "220000000");
    assert.equal(usd.includedMicros, "220000000");
    assert.equal(usd.excludedMicros, "0");
    assert.equal(usd.rootUnallocatedMicros, "25000000");
    const company = usd.children.find(({ value }) => value === "Acme");
    assert.ok(company);
    assert.equal(company.amountMicros, "195000000");
    assert.equal(company.unallocatedMicros, "45000000");
    const businessUnit = company.children.find(({ value }) => value === "Platform");
    assert.ok(businessUnit);
    assert.equal(businessUnit.amountMicros, "150000000");
    assert.equal(
      (BigInt(company.unallocatedMicros)
        + company.children.reduce((sum, child) => sum + BigInt(child.amountMicros), BigInt(0)))
        .toString(),
      company.amountMicros,
      "every parent equals allocated children plus its exact unallocated remainder",
    );
    assert.equal(
      (BigInt(usd.rootUnallocatedMicros)
        + usd.children.reduce((sum, child) => sum + BigInt(child.amountMicros), BigInt(0)))
        .toString(),
      usd.includedMicros,
    );
    const eur = showback.allocations.find((entry) =>
      entry.period === "2026-07" && entry.currency === "EUR");
    assert.equal(eur?.includedMicros, "10000000", "currencies remain independent");
    const julyUsdSummary = showback.summaries.find((entry) =>
      entry.period === "2026-07" && entry.currency === "USD");
    assert.equal(julyUsdSummary?.averageDailyRunRate.observedDays, 31);
    assert.equal(julyUsdSummary?.averageDailyRunRate.roundedMicrosPerDay, "7096774");

    const chargeback = requireReport(buildFinopsCostIntelligence(input(periods, {
      allocationMode: "chargeback",
    })));
    const chargedUsd = chargeback.summaries.find((entry) =>
      entry.period === "2026-07" && entry.currency === "USD");
    assert.equal(chargedUsd?.sourceTotalMicros, "220000000");
    assert.equal(chargedUsd?.includedMicros, "160000000");
    assert.equal(chargedUsd?.excludedMicros, "60000000");
    assert.deepEqual(chargedUsd?.excludedByClass, [
      { chargeClass: "marketplace", amountMicros: "30000000", lineCount: 1 },
      { chargeClass: "support", amountMicros: "20000000", lineCount: 1 },
      { chargeClass: "tax", amountMicros: "10000000", lineCount: 1 },
    ]);
    assert.equal(
      (BigInt(chargedUsd?.includedMicros ?? "0") + BigInt(chargedUsd?.excludedMicros ?? "0")).toString(),
      chargedUsd?.sourceTotalMicros,
    );
    assert.match(chargeback.inclusionPolicy.description, /credits\/refunds/u);
    assert.deepEqual(chargeback.taxonomyEvidence, TAXONOMY.evidence);
  });

  it("reports signed movers, zero-baseline state, and an exact two-dimensional MoM pivot", () => {
    const juneScope = scope("2026-06", "3");
    const julyScope = scope("2026-07", "4");
    const report = requireReport(buildFinopsCostIntelligence(input([
      billingPeriod(juneScope, [
        canonicalLine("2026-06", "ec2-old", ACCOUNT_A, "AmazonEC2", "100.00"),
        canonicalLine("2026-06", "credit-old", ACCOUNT_A, "Credits", "-10.00", "USD", {
          chargeKind: "credit",
          chargeCategory: "Credit",
        }),
      ]),
      billingPeriod(julyScope, [
        canonicalLine("2026-07", "ec2-new", ACCOUNT_A, "AmazonEC2", "150.00"),
        canonicalLine("2026-07", "s3-new", ACCOUNT_A, "AmazonS3", "20.00"),
        canonicalLine("2026-07", "credit-new", ACCOUNT_A, "Credits", "-5.00", "USD", {
          chargeKind: "credit",
          chargeCategory: "Credit",
        }),
      ]),
    ])));
    assert.deepEqual(report.movers.map((mover) => ({
      value: mover.value,
      baseline: mover.baselineMicros,
      comparison: mover.comparisonMicros,
      delta: mover.absoluteDeltaMicros,
      bps: mover.deltaPercentBasisPoints,
      state: mover.percentageState,
    })), [
      {
        value: "AmazonEC2",
        baseline: "100000000",
        comparison: "150000000",
        delta: "50000000",
        bps: "5000",
        state: "available",
      },
      {
        value: "AmazonS3",
        baseline: "0",
        comparison: "20000000",
        delta: "20000000",
        bps: null,
        state: "zero_baseline",
      },
      {
        value: "Credits",
        baseline: "-10000000",
        comparison: "-5000000",
        delta: "5000000",
        bps: "5000",
        state: "available",
      },
    ]);
    assert.deepEqual(report.momPivot.dimensions, ["service", "account"]);
    const ec2Cell = report.momPivot.cells.find(({ rowValue }) => rowValue === "AmazonEC2");
    assert.equal(ec2Cell?.columnValue, ACCOUNT_A);
    assert.equal(ec2Cell?.deltaMicros, "50000000");
    assert.equal(ec2Cell?.deltaPercentBasisPoints, "5000");
  });

  it("keeps monetary arithmetic exact above Number limits and fails rather than substituting a missing basis", () => {
    const juneScope = scope("2026-06", "f");
    const julyScope = scope("2026-07", "0");
    const periods = [
      billingPeriod(juneScope, [
        canonicalLine("2026-06", "huge-old", ACCOUNT_A, "AmazonEC2", "1.00", "USD", {
          amountMicros: "9007199254740993",
        }),
      ]),
      billingPeriod(julyScope, [
        canonicalLine("2026-07", "huge-new", ACCOUNT_A, "AmazonEC2", "1.00", "USD", {
          amountMicros: "9007199254741000",
        }),
      ]),
    ];
    const billed = requireReport(buildFinopsCostIntelligence(input(periods)));
    assert.equal(
      billed.summaries.find(({ period }) => period === "2026-07")?.includedMicros,
      "9007199254741000",
    );
    assert.equal(billed.movers[0]?.absoluteDeltaMicros, "7");

    const missingAmortized = buildFinopsCostIntelligence(input(periods, {
      costBasis: "amortized",
    }));
    assert.deepEqual(failureCodes(missingAmortized), [
      "INCOMPLETE_COST_BASIS",
      "INCOMPLETE_COST_BASIS",
    ]);
  });

  it("labels insufficient forecasts and emits deterministic integer forecasts with an evidence range", () => {
    const mayScope = scope("2026-05", "5");
    const juneScope = scope("2026-06", "6");
    const julyScope = scope("2026-07", "7");
    const twoPeriods = [
      billingPeriod(juneScope, [
        canonicalLine("2026-06", "june", ACCOUNT_A, "AmazonEC2", "200.00"),
      ]),
      billingPeriod(julyScope, [
        canonicalLine("2026-07", "july", ACCOUNT_A, "AmazonEC2", "300.00"),
      ]),
    ];
    const insufficient = requireReport(buildFinopsCostIntelligence(input(twoPeriods)));
    assert.deepEqual(insufficient.forecasts, [{
      currency: "USD",
      status: "insufficient_data",
      model: "integer_linear_trend_v1",
      minimumPeriods: 3,
      observedPeriods: 2,
      trainingWindow: null,
      evidenceLabels: [
        `2026-06:${juneScope.generationId}`,
        `2026-07:${julyScope.generationId}`,
      ],
      reason: "insufficient_currency_history",
    }]);

    const validInput = input([
      billingPeriod(mayScope, [
        canonicalLine("2026-05", "may", ACCOUNT_A, "AmazonEC2", "100.00"),
      ]),
      ...twoPeriods,
    ]);
    const first = requireReport(buildFinopsCostIntelligence(validInput));
    const second = requireReport(buildFinopsCostIntelligence(validInput));
    assert.deepEqual(first, second, "identical evidence always produces byte-order-equivalent output");
    const forecast = first.forecasts[0];
    assert.equal(forecast?.status, "available");
    if (forecast?.status !== "available") return;
    assert.equal(forecast.forecastPeriod, "2026-08");
    assert.equal(forecast.forecastMicros, "400000000");
    assert.deepEqual(forecast.confidenceRange, {
      method: "mean_absolute_residual_band",
      lowerMicros: "400000000",
      upperMicros: "400000000",
      meanAbsoluteResidualMicros: "0",
      disclosure: "deterministic_error_band_not_statistical_confidence",
    });
    assert.deepEqual(forecast.evidenceLabels, [
      `2026-05:${mayScope.generationId}`,
      `2026-06:${juneScope.generationId}`,
      `2026-07:${julyScope.generationId}`,
    ]);
  });

  it("bounds the safe explorer and rejects arbitrary dimensions, filters, and cardinality", () => {
    const juneScope = scope("2026-06", "8");
    const julyScope = scope("2026-07", "9");
    const periods = [
      billingPeriod(juneScope, [
        canonicalLine("2026-06", "old", ACCOUNT_A, "AmazonEC2", "1.00"),
      ]),
      billingPeriod(julyScope, [
        canonicalLine("2026-07", "a", ACCOUNT_A, "ServiceA", "1.00"),
        canonicalLine("2026-07", "b", ACCOUNT_A, "ServiceB", "1.00"),
        canonicalLine("2026-07", "c", ACCOUNT_A, "ServiceC", "1.00"),
      ]),
    ];
    const safe = requireReport(buildFinopsCostIntelligence(input(periods, {
      explorer: {
        dimensions: ["service", "account"],
        filters: [{ dimension: "company", value: "Acme" }],
        limit: 2,
      },
    })));
    assert.deepEqual(safe.explorer?.groups.map((group) =>
      group.dimensions[0]?.value), ["ServiceA", "ServiceB"]);

    const arbitraryDimension = buildFinopsCostIntelligence({
      ...input(periods),
      pivotDimensions: ["service", "tags.owner"],
    } as unknown as FinopsCostIntelligenceInput);
    assert.deepEqual(failureCodes(arbitraryDimension), ["INVALID_DIMENSION"]);

    const arbitraryFilter = buildFinopsCostIntelligence({
      ...input(periods),
      explorer: {
        dimensions: ["service"],
        filters: [{ dimension: "tags.owner", value: "attacker" }],
      },
    } as unknown as FinopsCostIntelligenceInput);
    assert.deepEqual(failureCodes(arbitraryFilter), ["INVALID_FILTER"]);

    const highCardinality = buildFinopsCostIntelligence(input(periods, {
      explorer: {
        dimensions: ["service"],
        maximumCardinality: 2,
      },
    }));
    assert.deepEqual(failureCodes(highCardinality), ["HIGH_CARDINALITY"]);
  });

  it("discloses incomplete commitment coverage and computes complete savings without mixing usage units", () => {
    const juneScope = scope("2026-06", "a");
    const julyScope = scope("2026-07", "b");
    const commitment = {
      commitmentType: "Reserved",
      commitmentId: "arn:aws:ec2:us-east-1:111122223333:reserved-instances/ri-1",
      commitmentExpiry: "2026-07-31T00:00:00.000Z",
      commitmentStart: "2026-01-01T00:00:00.000Z",
      commitmentPurchaseOption: "Partial Upfront",
      pricingTerm: "1yr",
      chargeFrequency: "Monthly",
    } satisfies Partial<CanonicalCurLine>;
    const periods = [
      billingPeriod(juneScope, [
        canonicalLine("2026-06", "old", ACCOUNT_A, "AmazonEC2", "1.00"),
      ]),
      billingPeriod(julyScope, [
        canonicalLine("2026-07", "used", ACCOUNT_A, "AmazonEC2", "8.00", "USD", {
          ...commitment,
          publicOnDemandCostMicros: "10000000",
          usageAmountMicros: "2000000",
          usageUnit: "Hrs",
        }),
        canonicalLine("2026-07", "unused", ACCOUNT_A, "AmazonEC2", "1.00", "USD", {
          ...commitment,
          chargeDescription: "Unused reservation commitment",
          usageAmountMicros: null,
          usageUnit: null,
        }),
      ]),
    ];
    const incomplete = requireReport(buildFinopsCostIntelligence(input(periods)));
    const incompleteItem = incomplete.commitments.items[0];
    assert.equal(incompleteItem?.grossMicros, "9000000");
    assert.equal(incompleteItem?.usedMicros, "8000000");
    assert.equal(incompleteItem?.unusedMicros, null);
    assert.equal(incompleteItem?.onDemandEquivalentMicros, null);
    assert.equal(incompleteItem?.netSavingsMicros, null);
    assert.equal(incompleteItem?.usageQuantity, null);
    assert.deepEqual(incompleteItem?.coverage.missing, [
      "unused_charges",
      "public_on_demand_cost",
      "usage_quantity",
    ]);

    const complete = requireReport(buildFinopsCostIntelligence(input(periods, {
      commitments: {
        asOfIso: "2026-07-01T00:00:00.000Z",
        expiresWithinDays: 90,
        coverage: {
          evidenceLabel: "cur2-complete-commitment-evidence",
          unusedChargesComplete: true,
          publicOnDemandCostComplete: true,
          usageQuantityComplete: true,
        },
      },
    })));
    const item = complete.commitments.items[0];
    assert.equal(item?.commitmentType, "Reserved");
    assert.equal(item?.terms.pricingTerm, "1yr");
    assert.equal(item?.terms.purchaseOption, "Partial Upfront");
    assert.equal(item?.endIso, "2026-07-31T00:00:00.000Z");
    assert.equal(item?.owner, "Platform Team");
    assert.equal(item?.receivingAccountId, ACCOUNT_A);
    assert.equal(item?.grossMicros, "9000000");
    assert.equal(item?.usedMicros, "8000000");
    assert.equal(item?.unusedMicros, "1000000");
    assert.deepEqual(item?.usageQuantity, { amountMicros: "2000000", unit: "Hrs" });
    assert.equal(item?.onDemandEquivalentMicros, "10000000");
    assert.equal(item?.netSavingsMicros, "1000000");
    assert.equal(item?.coverage.complete, true);
  });

  it("rejects cross-tenant and cross-generation rows and orders outputs deterministically", () => {
    const juneScope = scope("2026-06", "c");
    const julyScope = scope("2026-07", "d");
    const validPeriods = [
      billingPeriod(juneScope, [
        canonicalLine("2026-06", "z", ACCOUNT_A, "ZService", "1.00"),
      ]),
      billingPeriod(julyScope, [
        canonicalLine("2026-07", "z", ACCOUNT_A, "ZService", "1.00"),
        canonicalLine("2026-07", "a", ACCOUNT_A, "AService", "1.00"),
      ]),
    ];
    const first = requireReport(buildFinopsCostIntelligence(input(validPeriods, {
      explorer: { dimensions: ["service"] },
    })));
    const second = requireReport(buildFinopsCostIntelligence(input(validPeriods, {
      explorer: { dimensions: ["service"] },
    })));
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.momPivot.cells.map(({ rowValue }) => rowValue),
      ["AService", "ZService"],
    );
    assert.deepEqual(
      first.allocations.find(({ period }) => period === "2026-07")
        ?.children.map(({ value }) => value),
      ["Acme"],
    );

    for (const mismatch of [
      { customerId: "customer_attacker" },
      { generationId: `fbg_${"e".repeat(64)}` },
    ]) {
      const maliciousRow: ScopedCanonicalBillingRow = {
        ...julyScope,
        ...mismatch,
        line: canonicalLine("2026-07", "malicious", ACCOUNT_A, "AmazonEC2", "1.00"),
      };
      const maliciousPeriods = [
        validPeriods[0],
        { scope: julyScope, rows: [maliciousRow] },
      ];
      const result = buildFinopsCostIntelligence(input(maliciousPeriods));
      assert.deepEqual(failureCodes(result), ["ROW_SCOPE_MISMATCH"]);
    }

    const foreignTaxonomy: FinopsOrganizationTaxonomy = {
      ...TAXONOMY,
      scope: {
        ...TAXONOMY.scope,
        customerId: "customer_attacker",
      },
    };
    const taxonomyResult = buildFinopsCostIntelligence(input(validPeriods, {
      taxonomy: foreignTaxonomy,
    }));
    assert.deepEqual(failureCodes(taxonomyResult), ["INVALID_TAXONOMY"]);
  });
});
