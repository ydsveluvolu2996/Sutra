import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCurCsv, type CanonicalCurLine } from "../lib/finops-cur.ts";
import {
  buildFinopsBillingProjection,
  FINOPS_PROJECTION_DIMENSIONS,
  type FinopsBillingProjectionEvidenceInput,
  type FinopsBillingProjectionInput,
  type FinopsBillingProjectionQuery,
} from "../lib/finops-billing-projections.ts";
import type {
  FinopsReconciliationScope,
  ScopedCanonicalBillingRow,
} from "../lib/finops-reconciliation.ts";

const SCOPE: FinopsReconciliationScope = {
  organizationId: "org_projection",
  customerId: "customer_projection",
  connectionId: "conn_projection",
  exportName: "aws-cur",
  billingPeriod: "2026-07",
  generationId: `fbg_${"c".repeat(64)}`,
};

function parsedLines(rows: readonly string[]): readonly CanonicalCurLine[] {
  const parsed = parseCurCsv([
    "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_usage_end_date,line_item_unblended_cost,line_item_net_unblended_cost,line_item_currency_code,line_item_usage_amount,pricing_unit",
    ...rows,
  ].join("\n"));
  if ("error" in parsed) throw new Error(parsed.error);
  assert.equal(parsed.rejected.length, 0);
  return parsed.lines;
}

function sourceLines(): readonly CanonicalCurLine[] {
  const [usage, tax, credit, refund, fee] = parsedLines([
    "usage,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,2026-07-01T01:00:00Z,10,9.5,USD,2,Hrs",
    "tax,111122223333,AmazonTax,Tax,2026-07-01T01:00:00Z,2026-07-01T02:00:00Z,1,1,USD,,",
    "credit,111122223333,AWS,Credit,2026-07-02T00:00:00Z,2026-07-02T01:00:00Z,-2,-2,USD,,",
    "refund,444455556666,AWS,Refund,2026-07-02T01:00:00Z,2026-07-02T02:00:00Z,-3,-3,EUR,,",
    "fee,111122223333,AmazonEC2,Fee,2026-07-03T00:00:00Z,2026-07-03T02:00:00Z,12,12,USD,3600,seconds",
  ]);
  return [
    {
      ...usage,
      usageAccountName: "Production",
      region: "us-east-1",
      availabilityZone: "us-east-1a",
      resourceId: "i-usage",
      resourceName: "api-one",
      resourceType: "EC2 Instance",
      productCode: "AmazonEC2",
      productName: "Amazon Elastic Compute Cloud",
      invoiceId: "INV-1",
      invoiceIssuerId: "AWS-INC",
      invoiceIssuerName: "Amazon Web Services, Inc.",
      legalEntity: "Amazon Web Services, Inc.",
      billingEntity: "AWS",
      tags: { Environment: "prod", Team: "platform" },
      costCategories: { BusinessUnit: "Payments" },
      amortizedMicros: "7000000",
      listCostMicros: "13000000",
      contractedCostMicros: "9500000",
      publicOnDemandCostMicros: "14000000",
      commitmentType: "savings_plan",
      commitmentId: "sp-1",
      commitmentName: "Compute SP",
      commitmentCategory: "SavingsPlan",
      commitmentStatus: "active",
      commitmentPurchaseOption: "No Upfront",
    },
    {
      ...tax,
      region: "us-east-1",
      legalEntity: "Amazon Web Services, Inc.",
      billingEntity: "AWS",
      invoiceId: "INV-1",
      tags: { Environment: "prod" },
      costCategories: { BusinessUnit: "Payments" },
      amortizedMicros: "1000000",
    },
    {
      ...credit,
      region: "us-west-2",
      legalEntity: "Amazon Web Services, Inc.",
      billingEntity: "AWS",
      invoiceId: "INV-1",
      tags: { Environment: "prod" },
      costCategories: { BusinessUnit: "Payments" },
      amortizedMicros: "-2000000",
    },
    {
      ...refund,
      usageAccountName: "Europe",
      region: "eu-west-1",
      legalEntity: "AWS EMEA SARL",
      billingEntity: "AWS",
      invoiceId: "INV-EUR",
      tags: { Environment: "prod" },
      costCategories: { BusinessUnit: "International" },
      amortizedMicros: "-3000000",
    },
    {
      ...fee,
      usageAccountName: "Production",
      region: "us-east-1",
      legalEntity: "Amazon Web Services, Inc.",
      billingEntity: "AWS",
      invoiceId: "INV-1",
      tags: { Environment: "prod" },
      costCategories: { BusinessUnit: "Payments" },
      amortizedMicros: "3000000",
      commitmentType: "savings_plan",
      commitmentId: "sp-1",
      commitmentName: "Compute SP",
      commitmentCategory: "SavingsPlan",
      commitmentStatus: "active",
      commitmentPurchaseOption: "No Upfront",
    },
  ];
}

function scoped(lines: readonly CanonicalCurLine[]): readonly ScopedCanonicalBillingRow[] {
  return lines.map((line) => ({ ...SCOPE, line }));
}

function evidence(rowCount: number): FinopsBillingProjectionEvidenceInput {
  return {
    sourceEvidenceId: "s3://sutra-billing/aws-cur/2026-07/manifest#version-1",
    manifestSha256: "d".repeat(64),
    sourceUpdatedAtIso: "2026-07-31T10:00:00Z",
    observedAtIso: "2026-07-31T10:05:00Z",
    committedAtIso: "2026-07-31T10:10:00Z",
    evaluatedAtIso: "2026-07-31T11:00:00Z",
    reconciledRowCount: rowCount,
  };
}

function project(
  rows: readonly ScopedCanonicalBillingRow[],
  query: FinopsBillingProjectionQuery,
  overrides: Partial<FinopsBillingProjectionInput> = {},
) {
  return buildFinopsBillingProjection({
    scope: SCOPE,
    evidence: evidence(rows.length),
    rows,
    query,
    ...overrides,
  });
}

describe("active-generation FinOps billing projections", () => {
  it("projects every required dimension with explicit evidence and missing values", () => {
    const rows = scoped(sourceLines());
    for (const dimension of FINOPS_PROJECTION_DIMENSIONS) {
      const result = project(rows, {
        dimension,
        ...(
          dimension === "tag"
            ? { dimensionKey: "Environment" }
            : dimension === "cost_category"
              ? { dimensionKey: "BusinessUnit" }
              : {}
        ),
      });
      assert.equal(result.ok, true, dimension);
      assert.ok(result.buckets.length > 0, dimension);
      assert.equal(result.evidence.generationId, SCOPE.generationId);
      assert.equal(result.evidence.sourceEvidenceId.includes("manifest"), true);
      assert.equal(result.evidence.freshness.status, "fresh");
      assert.equal(result.evidence.activeRowCount, rows.length);
    }
  });

  it("keeps mixed currencies independent and uses exact BigInt for every cost basis", () => {
    const [usd, , , eur] = sourceLines();
    const huge = "90000000000000000000000000000000000000";
    const rows = scoped([
      {
        ...usd,
        amountMicros: huge,
        netUnblendedCostMicros: huge,
        amortizedMicros: huge,
        listCostMicros: huge,
        contractedCostMicros: huge,
        publicOnDemandCostMicros: huge,
      },
      {
        ...usd,
        lineItemId: "huge-two",
        amountMicros: huge,
        netUnblendedCostMicros: huge,
        amortizedMicros: huge,
        listCostMicros: huge,
        contractedCostMicros: huge,
        publicOnDemandCostMicros: huge,
      },
      {
        ...eur,
        amountMicros: "-90000000000000000000000000000000000000",
        netUnblendedCostMicros: null,
        amortizedMicros: null,
      },
    ]);
    const result = project(rows, { dimension: "monthly", costBasis: "net" });
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.buckets.map(({ currency, selectedTotalMicros }) => ({
        currency,
        selectedTotalMicros,
      })),
      [
        { currency: "EUR", selectedTotalMicros: null },
        {
          currency: "USD",
          selectedTotalMicros: "180000000000000000000000000000000000000",
        },
      ],
    );
    const eurBucket = result.buckets[0];
    assert.equal(
      eurBucket.costs.find(({ basis }) => basis === "net")?.coverage,
      "unavailable",
    );
  });

  it("projects tax, credit, refund, and fee charges as signed exact totals", () => {
    const result = project(scoped(sourceLines()), {
      dimension: "charge_kind",
    });
    assert.equal(result.ok, true);
    const byKind = new Map(result.buckets.map((bucket) => [
      bucket.dimensionValues.chargeKind,
      bucket.selectedTotalMicros,
    ]));
    assert.equal(byKind.get("tax"), "1000000");
    assert.equal(byKind.get("credit"), "-2000000");
    assert.equal(byKind.get("refund"), "-3000000");
    assert.equal(byKind.get("purchase"), "12000000");
  });

  it("discloses commitment amortization true-up only with complete basis coverage", () => {
    const result = project(scoped(sourceLines()), {
      dimension: "commitment",
      filters: { commitmentIds: ["sp-1"] },
      costBasis: "amortized",
    });
    assert.equal(result.ok, true);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].rowCount, 2);
    assert.equal(result.buckets[0].selectedTotalMicros, "10000000");
    assert.equal(result.buckets[0].amortizedTrueUpMicros, "-12000000");

    const [incomplete] = sourceLines();
    const missing = project(scoped([{ ...incomplete, amortizedMicros: null }]), {
      dimension: "commitment",
      costBasis: "amortized",
    });
    assert.equal(missing.ok, true);
    assert.equal(missing.buckets[0].amortizedTrueUpMicros, null);
    assert.equal(missing.buckets[0].selectedTotalMicros, null);
  });

  it("keeps missing dimensions explicit and never aggregates mixed usage units", () => {
    const [base] = sourceLines();
    const rows = scoped([
      {
        ...base,
        resourceId: null,
        resourceName: null,
        resourceType: null,
        usageAmountMicros: "1000000",
        usageUnit: "Hrs",
      },
      {
        ...base,
        lineItemId: "seconds",
        resourceId: null,
        resourceName: null,
        resourceType: null,
        usageAmountMicros: "3600000000",
        usageUnit: "seconds",
      },
      {
        ...base,
        lineItemId: "unknown-unit",
        resourceId: null,
        resourceName: null,
        resourceType: null,
        usageAmountMicros: "10",
        usageUnit: null,
      },
    ]);
    const result = project(rows, { dimension: "resource" });
    assert.equal(result.ok, true);
    assert.equal(result.buckets.length, 1);
    assert.equal(result.buckets[0].dimensionValues.resourceId, null);
    assert.equal(result.buckets[0].mixedUsageUnits, true);
    assert.deepEqual(
      result.buckets[0].usage.map(({ unit, quantityMicros }) => ({
        unit,
        quantityMicros,
      })),
      [
        { unit: null, quantityMicros: "10" },
        { unit: "Hrs", quantityMicros: "1000000" },
        { unit: "seconds", quantityMicros: "3600000000" },
      ],
    );
    assert.equal(result.evidence.availability.resource, "unavailable");
    assert.equal(result.evidence.availability.hourly, "complete");
  });

  it("rejects every cross-tenant or cross-generation active row", () => {
    const [line] = sourceLines();
    const mismatches: readonly Partial<FinopsReconciliationScope>[] = [
      { organizationId: "org_attacker" },
      { customerId: "customer_attacker" },
      { connectionId: "conn_attacker" },
      { exportName: "other-export" },
      { billingPeriod: "2026-06" },
      { generationId: `fbg_${"e".repeat(64)}` },
    ];
    for (const mismatch of mismatches) {
      const rows = [{ ...SCOPE, ...mismatch, line }];
      const result = project(rows, { dimension: "service" });
      assert.equal(result.ok, false);
      assert.equal(result.failures[0]?.code, "ROW_SCOPE_MISMATCH");
      assert.equal(result.failures[0]?.rowIndex, 0);
    }
  });

  it("rejects unsafe, high-cardinality, unknown, and cursor-changing queries", () => {
    const rows = scoped(sourceLines());
    const unsafe = [
      { dimension: "service", filters: { services: ["*"] } },
      {
        dimension: "service",
        filters: {
          services: Array.from({ length: 101 }, (_, index) => `service-${index}`),
        },
      },
      { dimension: "service", filters: { arbitrarySql: "1=1" } },
      { dimension: "service", page: { limit: 501 } },
      { dimension: "tag" },
    ] as unknown as readonly FinopsBillingProjectionQuery[];
    for (const query of unsafe) {
      const result = project(rows, query);
      assert.equal(result.ok, false);
      assert.ok(["UNSAFE_FILTER", "INVALID_QUERY"].includes(
        result.failures[0]?.code ?? "",
      ));
    }

    const first = project(rows, {
      dimension: "service",
      page: { limit: 1 },
    });
    assert.equal(first.ok, true);
    assert.notEqual(first.nextCursor, null);
    const changed = project(rows, {
      dimension: "account",
      page: { limit: 1, cursor: first.nextCursor ?? undefined },
    });
    assert.equal(changed.ok, false);
    assert.equal(changed.failures[0]?.code, "INVALID_CURSOR");
  });

  it("is deterministic across input order and offers stable cursor pagination", () => {
    const rows = scoped(sourceLines());
    const query = {
      dimension: "service",
      filters: { currencies: ["USD", "EUR"], tags: [{ key: "Environment", value: "prod" }] },
      page: { limit: 100 },
    } as const;
    const forward = project(rows, query);
    const reverse = project([...rows].reverse(), query);
    assert.equal(forward.ok, true);
    assert.equal(reverse.ok, true);
    assert.equal(JSON.stringify(forward), JSON.stringify(reverse));

    const first = project(rows, { ...query, page: { limit: 1 } });
    assert.equal(first.ok, true);
    assert.notEqual(first.nextCursor, null);
    const second = project(rows, {
      ...query,
      page: { limit: 1, cursor: first.nextCursor ?? undefined },
    });
    assert.equal(second.ok, true);
    assert.equal(second.buckets.length, 1);
    assert.notDeepEqual(second.buckets[0], first.buckets[0]);
  });
});
