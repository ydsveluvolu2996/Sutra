import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCurCsv, type CanonicalCurLine } from "../lib/finops-cur.ts";
import {
  FinopsTrendsCapabilityClosureError,
  buildFinopsTrendsCapabilityClosure,
} from "../lib/finops-trends-capability-closure.ts";
import {
  buildFinopsTrendsIntelligence,
  type FinopsTrendsActivePeriodInput,
  type FinopsTrendsPeriodEvidenceInput,
} from "../lib/finops-trends-intelligence.ts";
import type { ScopedCanonicalBillingRow } from "../lib/finops-reconciliation.ts";

const TENANT = {
  organizationId: "org_trends",
  customerId: "customer_trends",
  connectionId: "conn_trends",
  exportName: "aws-cur2",
};

function generation(character: string): string {
  return `fbg_${character.repeat(64)}`;
}

function canonical(overrides: Partial<CanonicalCurLine> = {}): CanonicalCurLine {
  const parsed = parseCurCsv([
    "line_item_id,bill_payer_account_id,bill_payer_account_name,line_item_usage_account_id,line_item_usage_account_name,product_servicecode,product_service_category,product_service_subcategory,line_item_usage_type,line_item_usage_amount,pricing_unit,line_item_line_item_type,line_item_usage_start_date,line_item_usage_end_date,line_item_unblended_cost,line_item_net_unblended_cost,line_item_currency_code,bill_billing_period_start_date,bill_billing_period_end_date,product_region_code",
    "line-default,999900001111,Management,111122223333,Workload,AmazonEC2,Compute,Elastic Compute,BoxUsage,10,Hrs,Usage,2026-01-01T00:00:00Z,2026-01-01T01:00:00Z,100,100,USD,2026-01-01T00:00:00Z,2026-02-01T00:00:00Z,us-east-1",
  ].join("\n"));
  if ("error" in parsed) throw new Error(parsed.error);
  assert.equal(parsed.rejected.length, 0);
  return { ...parsed.lines[0], ...overrides };
}

function evidence(rowCount: number): FinopsTrendsPeriodEvidenceInput {
  return {
    sourceEvidenceId: "s3://billing/cur2/manifest.json#version-1",
    manifestSha256: "a".repeat(64),
    sourceUpdatedAtIso: "2026-08-01T10:00:00.000Z",
    observedAtIso: "2026-08-01T10:05:00.000Z",
    committedAtIso: "2026-08-01T10:10:00.000Z",
    activatedAtIso: "2026-08-01T10:11:00.000Z",
    active: true,
    immutable: true,
    reconciliationState: "RECONCILED",
    collectionState: "COMPLETE",
    rowsExhausted: true,
    reconciledRowCount: rowCount,
    rejectedRowCount: 0,
    availableCostBases: ["unblended", "net"],
    loadKind: "ORIGINAL",
    supersededGenerationId: null,
  };
}

function period(month: string, character: string, lines: readonly CanonicalCurLine[]): FinopsTrendsActivePeriodInput {
  const scope = { ...TENANT, billingPeriod: month, generationId: generation(character) };
  const rows: ScopedCanonicalBillingRow[] = lines.map((line) => ({
    ...scope,
    line: {
      ...line,
      usageStartIso: `${month}-01T00:00:00.000Z`,
      usageEndIso: `${month}-01T01:00:00.000Z`,
      billingPeriodStartIso: `${month}-01T00:00:00.000Z`,
    },
  }));
  return { scope, evidence: evidence(rows.length), rows };
}

function build(periods: readonly FinopsTrendsActivePeriodInput[], from: string, to: string) {
  const report = buildFinopsTrendsIntelligence({
    tenant: TENANT,
    window: { fromPeriod: from, toPeriod: to },
    expectedCurrencies: ["USD"],
    source: { state: "READY", evaluatedAtIso: "2026-08-01T12:00:00.000Z", errorCode: null },
    periods,
    options: { costBases: ["unblended", "net"] },
  });
  assert.equal(report.ok, true);
  if (!report.ok) throw new Error("Trends fixture was rejected");
  return report;
}

describe("Trends official-capability closure", () => {
  it("uses only canonical CUR2 taxonomy, usage, account and Region evidence", () => {
    const periods = [100, 200, 300, 400].map((amount, index) => period(
      `2026-0${index + 1}`,
      String.fromCharCode(97 + index),
      [canonical({ lineItemId: `line-${index}`, amountMicros: String(amount * 1_000_000),
        netUnblendedCostMicros: String(amount * 1_000_000), usageAmountMicros: String((index + 1) * 1_000_000) })],
    ));
    const capabilities = buildFinopsTrendsCapabilityClosure({
      report: build(periods, "2026-01", "2026-04"),
      periods,
      automation: {
        alertRules: { available: true, configuredCount: 3, enabledCount: 2,
          reason: "SUTRA_TENANT_SCOPED_RUNTIME" },
        scheduledReports: { available: true, configuredCount: 2, enabledCount: 1,
          reason: "SUTRA_TENANT_SCOPED_RUNTIME" },
      },
    });

    assert.equal(capabilities.serviceTaxonomy.state, "COMPLETE");
    assert.deepEqual(capabilities.serviceTaxonomy.groups, [{
      category: "Compute", subcategory: "Elastic Compute", services: ["AmazonEC2"],
    }]);
    assert.equal(capabilities.serviceTaxonomy.costTrends.length, 8);
    assert.equal(capabilities.serviceUsage.state, "COMPLETE");
    assert.equal(capabilities.serviceUsage.groups[3]?.usageAmountMicros, "4000000");
    assert.deepEqual(capabilities.accounts.entries.map((entry) =>
      [entry.role, entry.accountId, entry.friendlyName, entry.nameState]), [
      ["PAYER", "999900001111", "Management", "CUR2_FIELD"],
      ["USAGE", "111122223333", "Workload", "CUR2_FIELD"],
    ]);
    assert.equal(capabilities.accounts.organizationsApiEvidenceAvailable, false);
    assert.equal(capabilities.geography.regions[0]?.region, "us-east-1");
    assert.equal(capabilities.geography.map.available, false);
    assert.equal(capabilities.automation.sutraAlertRules.enabledCount, 2);
    assert.equal(capabilities.automation.sutraScheduledCostReports.enabledCount, 1);
    assert.equal(capabilities.automation.quickSightThresholdAlerts.available, false);

    const forecast = capabilities.forecast.sutra.find((entry) =>
      entry.currency === "USD" && entry.costBasis === "unblended");
    assert.equal(forecast?.available, true);
    if (forecast?.available) {
      assert.equal(forecast.model, "sutra_integer_linear_trend_v1");
      assert.deepEqual(forecast.points.map((point) => point.forecastMicros),
        ["500000000", "600000000", "700000000"]);
      assert.equal(forecast.errorBand.statisticalConfidence, false);
      assert.equal(forecast.trainingWindow.generationIds.length, 4);
    }
    assert.equal(capabilities.forecast.provider.available, false);
  });

  it("keeps unlike usage units separate and exposes missing evidence as partial", () => {
    const lines = [
      canonical({ lineItemId: "hours", usageUnit: "Hrs", usageAmountMicros: "1000000" }),
      canonical({ lineItemId: "storage", usageType: "TimedStorage", usageUnit: "GB-Mo",
        usageAmountMicros: "2000000", serviceCategory: null, payerAccountId: null,
        payerAccountName: null, usageAccountName: null, region: null }),
      canonical({ lineItemId: "missing", usageAmountMicros: null, usageUnit: null }),
    ];
    const periods = [period("2026-01", "a", lines)];
    const capabilities = buildFinopsTrendsCapabilityClosure({
      report: build(periods, "2026-01", "2026-01"), periods,
    });

    assert.deepEqual(capabilities.serviceUsage.groups.map((group) => group.unit), ["GB-Mo", "Hrs"]);
    assert.equal(capabilities.serviceUsage.missingQuantityRowCount, 1);
    assert.equal(capabilities.serviceUsage.state, "PARTIAL");
    assert.equal(capabilities.serviceTaxonomy.state, "PARTIAL");
    assert.equal(capabilities.accounts.state, "PARTIAL");
    assert.equal(capabilities.geography.state, "PARTIAL");
    assert.equal(capabilities.automation.sutraAlertRules.available, false);
    assert.equal(capabilities.automation.sutraScheduledCostReports.available, false);
  });

  it("suppresses forecasts across missing months instead of interpolating", () => {
    const periods = [
      period("2026-01", "a", [canonical({ lineItemId: "jan" })]),
      period("2026-03", "c", [canonical({ lineItemId: "mar" })]),
      period("2026-04", "d", [canonical({ lineItemId: "apr" })]),
    ];
    const capabilities = buildFinopsTrendsCapabilityClosure({
      report: build(periods, "2026-01", "2026-04"), periods,
    });
    assert.ok(capabilities.forecast.sutra.every((entry) => !entry.available));
    assert.ok(capabilities.forecast.sutra.every((entry) =>
      entry.observedCompletePeriods === 2));
  });

  it("rejects cross-tenant and generation-substituted capability inputs", () => {
    const periods = [period("2026-01", "a", [canonical()])];
    const report = build(periods, "2026-01", "2026-01");
    for (const substituted of [
      [{ ...periods[0]!, scope: { ...periods[0]!.scope, customerId: "customer_attacker" } }],
      [{ ...periods[0]!, scope: { ...periods[0]!.scope, generationId: generation("f") } }],
    ]) {
      assert.throws(() => buildFinopsTrendsCapabilityClosure({ report, periods: substituted }),
        (error) => error instanceof FinopsTrendsCapabilityClosureError
          && error.code === "SCOPE_MISMATCH" && !error.message.includes("attacker"));
    }
  });

  it("never chooses between conflicting CUR2 account names", () => {
    const periods = [period("2026-01", "a", [
      canonical({ lineItemId: "one", usageAccountName: "Workload A" }),
      canonical({ lineItemId: "two", usageAccountName: "Workload B" }),
    ])];
    const capabilities = buildFinopsTrendsCapabilityClosure({
      report: build(periods, "2026-01", "2026-01"), periods,
    });
    const usage = capabilities.accounts.entries.find((entry) => entry.role === "USAGE");
    assert.equal(usage?.nameState, "CONFLICT");
    assert.equal(usage?.friendlyName, null);
    assert.equal(capabilities.accounts.state, "PARTIAL");
  });
});
