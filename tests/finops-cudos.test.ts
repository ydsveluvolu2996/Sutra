import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCurCsv, type CanonicalCurLine } from "../lib/finops-cur.ts";
import {
  buildFinopsCudosDashboard,
  FINOPS_CUDOS_CHARGE_KINDS,
} from "../lib/finops-cudos.ts";
import type {
  FinopsReconciliationScope,
  ScopedCanonicalBillingRow,
} from "../lib/finops-reconciliation.ts";

const SCOPE: FinopsReconciliationScope = {
  organizationId: "org_cudos",
  customerId: "customer_cudos",
  connectionId: "conn_cudos",
  exportName: "aws-cur",
  billingPeriod: "2026-07",
  generationId: `fbg_${"a".repeat(64)}`,
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

function baseLines(): readonly CanonicalCurLine[] {
  const [compute, storage, tax, credit, refund, fee, discount, security] =
    parsedLines([
      "ec2,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,2026-07-01T01:00:00Z,10,9,USD,2,Hrs",
      "s3,111122223333,AmazonS3,Usage,2026-07-02T00:00:00Z,2026-07-03T00:00:00Z,4,4,USD,100,GB-Mo",
      "tax,111122223333,AmazonTax,Tax,2026-07-02T00:00:00Z,2026-07-02T01:00:00Z,1,1,USD,,",
      "credit,111122223333,AWS,Credit,2026-07-02T00:00:00Z,2026-07-02T01:00:00Z,-2,-2,USD,,",
      "refund,444455556666,AWS,Refund,2026-07-03T00:00:00Z,2026-07-03T01:00:00Z,-3,-3,EUR,,",
      "fee,111122223333,AmazonEC2,Fee,2026-07-03T00:00:00Z,2026-07-03T01:00:00Z,5,5,USD,,",
      "discount,111122223333,AWS,BundledDiscount,2026-07-03T00:00:00Z,2026-07-03T01:00:00Z,-1,-1,USD,,",
      "guardduty,111122223333,AmazonGuardDuty,Usage,2026-07-04T00:00:00Z,2026-07-04T01:00:00Z,3,3,USD,1,Events",
    ]);
  return [
    {
      ...compute,
      usageAccountName: "Production",
      region: "us-east-1",
      resourceId: "i-123",
      resourceType: "EC2 Instance",
      productCode: "AmazonEC2",
      productName: "Amazon Elastic Compute Cloud",
      usageType: "USE1-BoxUsage:m7g.large",
      commitmentType: "on_demand",
      amortizedMicros: "9000000",
    },
    {
      ...storage,
      usageAccountName: "Production",
      region: "us-east-1",
      resourceId: "bucket-one",
      resourceType: "S3 Bucket",
      productCode: "AmazonS3",
      productName: "Amazon Simple Storage Service",
      usageType: "TimedStorage-ByteHrs",
      amortizedMicros: "4000000",
    },
    { ...tax, amortizedMicros: "1000000" },
    { ...credit, amortizedMicros: "-2000000" },
    { ...refund, region: "eu-west-1", amortizedMicros: "-3000000" },
    {
      ...fee,
      chargeKind: "purchase",
      chargeCategory: "SavingsPlanRecurringFee",
      chargeDescription: "Recurring fee",
      commitmentType: "savings_plan",
      commitmentId: "sp-1",
      amortizedMicros: "3000000",
    },
    {
      ...discount,
      chargeKind: "discount",
      amortizedMicros: "-1000000",
    },
    {
      ...security,
      region: "us-east-1",
      productCode: "AmazonGuardDuty",
      productName: "Amazon GuardDuty",
      amortizedMicros: "3000000",
    },
  ];
}

function scoped(
  lines: readonly CanonicalCurLine[],
): readonly ScopedCanonicalBillingRow[] {
  return lines.map((line) => ({ ...SCOPE, line }));
}

function build(
  rows: readonly ScopedCanonicalBillingRow[] = scoped(baseLines()),
) {
  return buildFinopsCudosDashboard({ scope: SCOPE, rows });
}

describe("Foundational CUDOS pure engine", () => {
  it("rejects every cross-tenant, export, period, or generation row", () => {
    const [line] = baseLines();
    const mismatches: readonly Partial<FinopsReconciliationScope>[] = [
      { organizationId: "org_attacker" },
      { customerId: "customer_attacker" },
      { connectionId: "conn_attacker" },
      { exportName: "other-export" },
      { billingPeriod: "2026-06" },
      { generationId: `fbg_${"b".repeat(64)}` },
    ];
    for (const mismatch of mismatches) {
      const result = build([{ ...SCOPE, ...mismatch, line }]);
      assert.equal(result.ok, false);
      assert.equal(result.failures[0]?.code, "ROW_SCOPE_MISMATCH");
      assert.equal(result.failures[0]?.rowIndex, 0);
    }
  });

  it("never combines currencies or incompatible usage units", () => {
    const result = build();
    assert.equal(result.ok, true);
    assert.deepEqual(result.evidence.currencies, ["EUR", "USD"]);
    assert.deepEqual(
      result.unitCosts.metrics.map((metric) => [
        metric.currency,
        metric.service,
        metric.usageUnit,
      ]),
      [
        ["USD", "AmazonEC2", "Hrs"],
        ["USD", "AmazonGuardDuty", "Events"],
        ["USD", "AmazonS3", "GB-Mo"],
      ],
    );
    assert.equal(
      result.unitCosts.invariant,
      "currencies_and_usage_units_are_never_combined",
    );
    assert.deepEqual(
      result.executive.map(({ currency }) => currency),
      ["EUR", "USD"],
    );
  });

  it("discloses missing resource and hourly evidence", () => {
    const [line] = baseLines();
    const result = build(scoped([{
      ...line,
      resourceId: null,
      usageEndIso: null,
    }]));
    assert.equal(result.ok, true);
    assert.equal(result.drilldowns.resource.status, "unavailable");
    assert.equal(result.drilldowns.hourly.status, "unavailable");
    assert.equal(result.drilldowns.resourceHourly.status, "unavailable");
    assert.equal(result.drilldowns.resource.missingLineCount, 1);
  });

  it("preserves signed charge totals and discloses fee separately", () => {
    const result = build();
    assert.equal(result.ok, true);
    const usd = result.executive.find(({ currency }) => currency === "USD");
    assert.ok(usd);
    assert.deepEqual(
      usd.chargeKinds.map(({ chargeKind }) => chargeKind),
      FINOPS_CUDOS_CHARGE_KINDS,
    );
    const totals = new Map(usd.chargeKinds.map((entry) => [
      entry.chargeKind,
      entry.costs.find(({ basis }) => basis === "unblended")?.totalMicros,
    ]));
    assert.equal(totals.get("tax"), "1000000");
    assert.equal(totals.get("credit"), "-2000000");
    assert.equal(totals.get("fee"), "5000000");
    assert.equal(totals.get("discount"), "-1000000");
    const eur = result.executive.find(({ currency }) => currency === "EUR");
    assert.equal(
      eur?.chargeKinds.find(({ chargeKind }) => chargeKind === "refund")
        ?.costs.find(({ basis }) => basis === "unblended")?.totalMicros,
      "-3000000",
    );
  });

  it("marks commitment coverage, utilization, and true-up incomplete", () => {
    const [compute, , , , , fee] = baseLines();
    const committed: CanonicalCurLine = {
      ...compute,
      lineItemId: "committed",
      commitmentType: "savings_plan",
      commitmentId: "sp-1",
      amortizedMicros: null,
    };
    const unknown: CanonicalCurLine = {
      ...compute,
      lineItemId: "unknown",
      commitmentType: null,
      commitmentId: null,
    };
    const result = build(scoped([committed, unknown, fee]));
    assert.equal(result.ok, true);
    const summary = result.commitments[0];
    assert.equal(summary.coverage.status, "partial");
    assert.equal(summary.coverage.unknownClassificationLineCount, 1);
    assert.equal(summary.utilization.status, "partial");
    assert.ok(summary.utilization.incompleteReasons.includes(
      "no_explicit_unused_commitment_line",
    ));
    assert.equal(summary.trueUp.status, "partial");
    assert.equal(summary.trueUp.amortizedMinusUnblendedMicros, null);
  });

  it("creates service modules only from matching source evidence", () => {
    const [compute, storage] = baseLines();
    const result = build(scoped([compute, storage]));
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.modules.map(({ moduleId }) => moduleId),
      ["compute", "storage", "s3"],
    );
    assert.equal(
      result.modules.some(({ moduleId }) => moduleId === "security"),
      false,
    );
    assert.ok(result.modules.every(({ sourceLineIds }) =>
      sourceLineIds.length > 0));
  });

  it("projects Bedrock token usage and cache ratios from compatible raw units", () => {
    const [base] = baseLines();
    const bedrock = (
      lineItemId: string,
      usageType: string,
      usageAmountMicros: string,
    ): CanonicalCurLine => ({
      ...base,
      lineItemId,
      service: "Amazon Bedrock",
      productCode: "AmazonBedrock",
      productName: "Amazon Bedrock",
      usageType,
      usageUnit: "1M Tokens",
      usageAmountMicros,
    });
    const result = build(scoped([
      bedrock("bedrock-input", "USE1-Claude-InputTokens", "100000000"),
      bedrock("bedrock-output", "USE1-Claude-OutputTokens", "40000000"),
      bedrock("bedrock-read", "USE1-Claude-CacheReadInputTokens", "50000000"),
      bedrock("bedrock-write", "USE1-Claude-CacheWriteInputTokens", "25000000"),
    ]));
    assert.equal(result.ok, true);
    assert.equal(result.bedrockTokens.status, "complete");
    assert.equal(result.bedrockTokens.classifiedLineCount, 4);
    assert.equal(result.bedrockTokens.usableLineCount, 4);
    assert.equal(result.bedrockTokens.buckets.length, 1);
    const bucket = result.bedrockTokens.buckets[0];
    assert.equal(bucket.period, "2026-07");
    assert.equal(bucket.currency, "USD");
    assert.equal(bucket.usageUnit, "1M Tokens");
    assert.equal(bucket.usage.input.quantityMicros, "100000000");
    assert.equal(bucket.usage.output.quantityMicros, "40000000");
    assert.equal(bucket.usage.cache_read.quantityMicros, "50000000");
    assert.equal(bucket.usage.cache_write.quantityMicros, "25000000");
    assert.equal(bucket.cacheReadRatioBasisPoints, "2857");
    assert.equal(bucket.cacheWriteRatioBasisPoints, "1428");
    assert.equal(bucket.ratioUnavailableReason, null);
    assert.equal(
      result.bedrockTokens.cacheCostSavings.savingsBasisPoints,
      null,
    );
    assert.equal(result.bedrockTokens.cacheCostSavings.status, "unavailable");
  });

  it("keeps incompatible Bedrock units separate and withholds missing ratios", () => {
    const [base] = baseLines();
    const input: CanonicalCurLine = {
      ...base,
      lineItemId: "bedrock-input",
      service: "Amazon Bedrock",
      productCode: "AmazonBedrock",
      productName: "Amazon Bedrock",
      usageType: "USE1-Claude-InputTokens",
      usageUnit: "1M Tokens",
      usageAmountMicros: "100000000",
    };
    const cacheRead: CanonicalCurLine = {
      ...input,
      lineItemId: "bedrock-read",
      usageType: "USE1-Claude-CacheReadInputTokens",
      usageUnit: "1K Tokens",
      usageAmountMicros: "50000000",
    };
    const missingQuantity: CanonicalCurLine = {
      ...input,
      lineItemId: "bedrock-write-missing",
      usageType: "USE1-Claude-CacheWriteInputTokens",
      usageAmountMicros: null,
    };
    const result = build(scoped([cacheRead, input, missingQuantity]));
    assert.equal(result.ok, true);
    assert.equal(result.bedrockTokens.status, "partial");
    assert.equal(result.bedrockTokens.classifiedLineCount, 3);
    assert.equal(result.bedrockTokens.usableLineCount, 2);
    assert.equal(result.bedrockTokens.missingUsageEvidenceLineCount, 1);
    assert.equal(result.bedrockTokens.buckets.length, 2);
    assert.ok(result.bedrockTokens.buckets.every((bucket) =>
      bucket.cacheReadRatioBasisPoints === null
      && bucket.cacheWriteRatioBasisPoints === null));
    assert.deepEqual(
      result.bedrockTokens.buckets.map(({ usageUnit }) => usageUnit),
      ["1K Tokens", "1M Tokens"],
    );
  });

  it("is deterministic across input ordering with stable trends and rankings", () => {
    const rows = scoped(baseLines());
    const forward = build(rows);
    const reverse = build([...rows].reverse());
    assert.equal(forward.ok, true);
    assert.equal(reverse.ok, true);
    assert.equal(JSON.stringify(forward), JSON.stringify(reverse));
    assert.deepEqual(
      forward.trends.daily.map(({ currency, period }) => [currency, period]),
      [...forward.trends.daily]
        .map(({ currency, period }) => [currency, period])
        .sort(([leftCurrency, leftPeriod], [rightCurrency, rightPeriod]) =>
          String(leftCurrency).localeCompare(String(rightCurrency))
          || String(leftPeriod).localeCompare(String(rightPeriod))),
    );
  });

  it("uses deterministic UTC Monday weekly buckets and exposes FOCUS service categories", () => {
    const [compute] = baseLines();
    const sunday: CanonicalCurLine = {
      ...compute,
      lineItemId: "sunday",
      usageStartIso: "2026-07-05T23:59:59.000Z",
      usageEndIso: "2026-07-06T00:00:00.000Z",
      serviceCategory: "Compute",
    };
    const monday: CanonicalCurLine = {
      ...compute,
      lineItemId: "monday",
      usageStartIso: "2026-07-06T00:00:00.000Z",
      usageEndIso: "2026-07-06T01:00:00.000Z",
      amountMicros: "2000000",
      amortizedMicros: "2000000",
      serviceCategory: "Developer Services",
    };
    const missingCategory: CanonicalCurLine = {
      ...compute,
      lineItemId: "missing-category",
      usageStartIso: "2026-07-06T02:00:00.000Z",
      usageEndIso: "2026-07-06T03:00:00.000Z",
      amountMicros: "1000000",
      amortizedMicros: "1000000",
      serviceCategory: null,
    };
    const result = build(scoped([monday, missingCategory, sunday]));
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.trends.weekly.map((bucket) => [
        bucket.currency,
        bucket.period,
        bucket.costs.find(({ basis }) => basis === "amortized")?.totalMicros,
      ]),
      [
        ["USD", "2026-06-29", "9000000"],
        ["USD", "2026-07-06", "3000000"],
      ],
    );
    assert.deepEqual(
      result.rankings.serviceCategories.map((entry) => [
        entry.dimension,
        entry.value,
        entry.selectedTotalMicros,
      ]),
      [
        ["service_category", "Compute", "10000000"],
        ["service_category", "Developer Services", "2000000"],
        ["service_category", null, "1000000"],
      ],
    );
  });

  it("recognizes the official End User Computing and GameTech / Media families", () => {
    const [compute] = baseLines();
    const workspaces: CanonicalCurLine = {
      ...compute,
      lineItemId: "workspaces",
      service: "Amazon WorkSpaces",
      productCode: "AmazonWorkSpaces",
      productName: "Amazon WorkSpaces",
      resourceType: "Virtual Desktop",
      usageType: null,
    };
    const gamelift: CanonicalCurLine = {
      ...compute,
      lineItemId: "gamelift",
      service: "Amazon GameLift Servers",
      productCode: "AmazonGameLift",
      productName: "Amazon GameLift Servers",
      resourceType: "Game Server",
      usageType: null,
    };
    const result = build(scoped([gamelift, workspaces]));
    assert.equal(result.ok, true);
    assert.deepEqual(
      result.modules.map(({ moduleId }) => moduleId),
      ["end_user_computing", "gametech_media"],
    );
  });

  it("labels every estimate with bounded evidence and no savings/remediation claim", () => {
    const [onDemand, , , , , fee] = baseLines();
    const unused: CanonicalCurLine = {
      ...fee,
      lineItemId: "unused-sp",
      chargeCategory: "SavingsPlanUnusedCommitment",
      chargeDescription: "Unused commitment fee",
      commitmentStatus: "unused",
      commitmentType: "savings_plan",
      commitmentId: "sp-unused",
    };
    const result = build(scoped([onDemand, unused]));
    assert.equal(result.ok, true);
    assert.ok(result.opportunities.estimates.length >= 2);
    for (const estimate of result.opportunities.estimates) {
      assert.equal(estimate.classification, "cur_derived_review_candidate");
      assert.equal(estimate.ruleVersion, "1.0.0");
      assert.equal(estimate.estimate.isSavingsClaim, false);
      assert.equal(estimate.remediationClaim, null);
      assert.equal(estimate.reviewRequired, true);
      assert.ok(estimate.assumptions.length >= 3);
      assert.ok(estimate.sourceLineIds.length > 0);
      assert.equal(
        estimate.evidenceWindow.derivedFrom,
        "canonical_usage_intervals",
      );
    }
    assert.match(result.opportunities.disclaimer, /not telemetry/u);
  });
});
