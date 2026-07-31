import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCurCsv, type CanonicalCurLine } from "../lib/finops-cur.ts";
import {
  FINOPS_TRENDS_ADDITIONAL_READ_OPERATIONS,
  FINOPS_TRENDS_SIGNAL_POLICY,
  buildFinopsTrendsIntelligence,
  type FinopsTrendsActivePeriodInput,
  type FinopsTrendsIntelligenceInput,
  type FinopsTrendsPeriodEvidenceInput,
} from "../lib/finops-trends-intelligence.ts";
import type {
  FinopsReconciliationScope,
  ScopedCanonicalBillingRow,
} from "../lib/finops-reconciliation.ts";

const TENANT = {
  organizationId: "org_trends",
  customerId: "customer_trends",
  connectionId: "conn_trends",
  exportName: "aws-cur2",
};
const EVALUATED_AT = "2026-08-01T12:00:00.000Z";

function generation(char: string): string {
  return `fbg_${char.repeat(64)}`;
}

function canonical(overrides: Partial<CanonicalCurLine> = {}): CanonicalCurLine {
  const parsed = parseCurCsv([
    "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_usage_end_date,line_item_unblended_cost,line_item_net_unblended_cost,line_item_currency_code,bill_billing_period_start_date,bill_billing_period_end_date,product_region",
    "line-default,111122223333,AmazonEC2,Usage,2026-01-01T00:00:00Z,2026-01-01T01:00:00Z,100,100,USD,2026-01-01T00:00:00Z,2026-02-01T00:00:00Z,us-east-1",
  ].join("\n"));
  if ("error" in parsed) throw new Error(parsed.error);
  assert.equal(parsed.rejected.length, 0);
  return { ...parsed.lines[0], ...overrides };
}

function scope(period: string, generationId: string): FinopsReconciliationScope {
  return { ...TENANT, billingPeriod: period, generationId };
}

function evidence(
  rowCount: number,
  overrides: Partial<FinopsTrendsPeriodEvidenceInput> = {},
): FinopsTrendsPeriodEvidenceInput {
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
    ...overrides,
  };
}

function activePeriod(
  period: string,
  generationChar: string,
  lines: readonly CanonicalCurLine[],
  evidenceOverrides: Partial<FinopsTrendsPeriodEvidenceInput> = {},
): FinopsTrendsActivePeriodInput {
  const periodScope = scope(period, generation(generationChar));
  const rows: ScopedCanonicalBillingRow[] = lines.map((line) => ({
    ...periodScope,
    line: {
      ...line,
      usageStartIso: `${period}-01T00:00:00.000Z`,
      usageEndIso: `${period}-01T01:00:00.000Z`,
      billingPeriodStartIso: `${period}-01T00:00:00.000Z`,
    },
  }));
  return {
    scope: periodScope,
    evidence: evidence(rows.length, evidenceOverrides),
    rows,
  };
}

function input(
  fromPeriod: string,
  toPeriod: string,
  periods: readonly FinopsTrendsActivePeriodInput[],
  overrides: Partial<FinopsTrendsIntelligenceInput> = {},
): FinopsTrendsIntelligenceInput {
  return {
    tenant: TENANT,
    window: { fromPeriod, toPeriod },
    expectedCurrencies: ["USD"],
    source: {
      state: "READY",
      evaluatedAtIso: EVALUATED_AT,
      errorCode: null,
    },
    periods,
    ...overrides,
  };
}

function moneyLine(
  id: string,
  amountMicros: string,
  overrides: Partial<CanonicalCurLine> = {},
): CanonicalCurLine {
  return canonical({
    lineItemId: id,
    amountMicros,
    netUnblendedCostMicros: amountMicros,
    ...overrides,
  });
}

describe("enterprise CUR2 trends intelligence", () => {
  it("uses exact BigInt/rational MoM and rolling comparisons without forecasting", () => {
    const huge = BigInt("90071992547409931234567890");
    const periods = [
      activePeriod("2026-01", "a", [moneyLine("jan", huge.toString())]),
      activePeriod("2026-02", "b", [moneyLine("feb", huge.toString())]),
      activePeriod("2026-03", "c", [moneyLine("mar", huge.toString())]),
      activePeriod("2026-04", "d", [moneyLine("apr", huge.toString())]),
      activePeriod("2026-05", "e", [moneyLine("may", huge.toString())]),
      activePeriod("2026-06", "f", [moneyLine("jun", (huge * BigInt(2)).toString())]),
    ];
    const result = buildFinopsTrendsIntelligence(input("2026-01", "2026-06", periods));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.state, "READY");
    const june = result.series[0]?.points[5];
    assert.equal(june?.monthOverMonth.available, true);
    if (june?.monthOverMonth.available) {
      assert.equal(june.monthOverMonth.deltaMicros, huge.toString());
      assert.deepEqual(june.monthOverMonth.percent, { numerator: "100", denominator: "1" });
    }
    assert.equal(june?.rollingComparison.available, true);
    if (june?.rollingComparison.available) {
      assert.equal(june.rollingComparison.priorWindowTotalMicros, (huge * BigInt(3)).toString());
      assert.equal(june.rollingComparison.currentWindowTotalMicros, (huge * BigInt(4)).toString());
      assert.deepEqual(june.rollingComparison.percent, { numerator: "100", denominator: "3" });
    }
    assert.equal(june?.trailingAverage.available, true);
    if (june?.trailingAverage.available) {
      assert.deepEqual(june.trailingAverage.exactAverageMicros, {
        numerator: ((huge * BigInt(4)) / BigInt(3)).toString(),
        denominator: "1",
      });
    }
    assert.deepEqual(result.forecast, {
      available: false,
      reason: "NOT_PRODUCED_EVIDENCE_HONEST_TRENDS_ONLY",
    });
    assert.deepEqual(FINOPS_TRENDS_ADDITIONAL_READ_OPERATIONS, []);
  });

  it("emits account, service, region and charge-category contributors with exact shares", () => {
    const may = activePeriod("2026-05", "a", [
      moneyLine("may-a", "60000000", {
        usageAccountId: "111122223333",
        service: "AmazonEC2",
        region: "us-east-1",
        chargeCategory: "Usage",
      }),
      moneyLine("may-b", "40000000", {
        usageAccountId: "444455556666",
        service: "AmazonS3",
        region: "us-west-2",
        chargeCategory: "Tax",
      }),
    ]);
    const june = activePeriod("2026-06", "b", [
      moneyLine("jun-a", "120000000", {
        usageAccountId: "111122223333",
        service: "AmazonEC2",
        region: "us-east-1",
        chargeCategory: "Usage",
      }),
      moneyLine("jun-b", "80000000", {
        usageAccountId: "444455556666",
        service: "AmazonS3",
        region: "us-west-2",
        chargeCategory: "Tax",
      }),
    ]);
    const result = buildFinopsTrendsIntelligence(input("2026-05", "2026-06", [may, june]));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const groups = result.series[0]?.points[1]?.contributors ?? [];
    assert.deepEqual(groups.map(({ dimension }) => dimension), [
      "account",
      "service",
      "region",
      "charge_category",
    ]);
    for (const group of groups) {
      assert.equal(group.available, true);
      assert.equal(group.contributors.length, 2);
      assert.deepEqual(group.contributors[0]?.absoluteMovementShare, {
        numerator: "3",
        denominator: "5",
      });
      assert.deepEqual(group.contributors[1]?.absoluteMovementShare, {
        numerator: "2",
        denominator: "5",
      });
    }
  });

  it("raises only pinned, explainable signals over complete evidence", () => {
    const values = [100, 100, 100, 200];
    const periods = values.map((value, index) =>
      activePeriod(`2026-0${index + 1}`, String.fromCharCode(97 + index), [
        moneyLine(`line-${index}`, String(value * 1_000_000)),
      ]));
    const result = buildFinopsTrendsIntelligence(input("2026-01", "2026-04", periods));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const aprilSignals = result.series[0]?.points[3]?.signals ?? [];
    assert.deepEqual(aprilSignals.map(({ code }) => code), [
      "MOM_ABSOLUTE_PERCENT_CHANGE",
      "TRAILING_BASELINE_DEVIATION",
    ]);
    assert.deepEqual(aprilSignals.map(({ observedPercent }) => observedPercent), [
      { numerator: "100", denominator: "1" },
      { numerator: "100", denominator: "1" },
    ]);
    assert.equal(aprilSignals[0]?.formula, FINOPS_TRENDS_SIGNAL_POLICY.formulas.momAbsolutePercentChange);
    assert.equal(aprilSignals[1]?.formula, FINOPS_TRENDS_SIGNAL_POLICY.formulas.trailingBaselineDeviation);
    assert.ok(aprilSignals.every(({ severity }) => severity === "INFORMATIONAL"));
  });

  it("keeps currencies and cost bases isolated and discloses unavailable basis coverage", () => {
    const usd = moneyLine("usd", "100000000", {
      currency: "USD",
      netUnblendedCostMicros: null,
    });
    const period = activePeriod("2026-01", "a", [usd], {
      availableCostBases: ["unblended"],
    });
    const result = buildFinopsTrendsIntelligence(input("2026-01", "2026-01", [period], {
      expectedCurrencies: ["EUR", "USD"],
      options: { costBases: ["unblended", "net"] },
    }));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.state, "PARTIAL");
    assert.deepEqual(result.series.map(({ currency, costBasis }) => ({ currency, costBasis })), [
      { currency: "EUR", costBasis: "unblended" },
      { currency: "EUR", costBasis: "net" },
      { currency: "USD", costBasis: "unblended" },
      { currency: "USD", costBasis: "net" },
    ]);
    const eurUnblended = result.series[0]?.points[0];
    const eurNet = result.series[1]?.points[0];
    const usdNet = result.series[3]?.points[0];
    assert.equal(eurUnblended?.totalMicros, "0");
    assert.equal(eurUnblended?.costCoverage, "complete");
    assert.equal(eurNet?.totalMicros, null);
    assert.equal(eurNet?.costCoverage, "unavailable");
    assert.equal(usdNet?.totalMicros, null);
    assert.equal(usdNet?.missingCostRowCount, 1);
  });

  it("surfaces missing, current-partial, correction, backfill, stale, partial and empty period states", () => {
    const original = (period: string, char: string) =>
      activePeriod(period, char, [moneyLine(`line-${period}`, "1000000")]);
    const correction = activePeriod("2026-03", "c", [moneyLine("correction", "1000000")], {
      loadKind: "CORRECTION",
      supersededGenerationId: generation("9"),
    });
    const backfill = activePeriod("2026-04", "d", [moneyLine("backfill", "1000000")], {
      loadKind: "BACKFILL",
    });
    const stale = activePeriod("2026-05", "e", [moneyLine("stale", "1000000")], {
      sourceUpdatedAtIso: "2026-01-01T00:00:00.000Z",
    });
    const partial = activePeriod("2026-06", "f", [moneyLine("partial", "1000000")], {
      collectionState: "PARTIAL",
      rowsExhausted: false,
      rejectedRowCount: 1,
    });
    const empty = activePeriod("2026-07", "1", []);
    const complete = original("2026-08", "2");
    const current = original("2026-09", "3");
    const result = buildFinopsTrendsIntelligence(input(
      "2026-01",
      "2026-09",
      [original("2026-01", "a"), correction, backfill, stale, partial, empty, complete, current],
      {
        source: {
          state: "READY",
          evaluatedAtIso: "2026-09-15T12:00:00.000Z",
          errorCode: null,
        },
      },
    ));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.state, "PARTIAL");
    const states = Object.fromEntries(result.periods.map(({ period, state }) => [period, state]));
    assert.equal(states["2026-01"], "STALE");
    assert.equal(states["2026-02"], "MISSING");
    assert.equal(states["2026-03"], "STALE");
    assert.ok(result.periods[2]?.stateReasons.includes("CORRECTION"));
    assert.ok(result.periods[3]?.stateReasons.includes("BACKFILL"));
    assert.equal(states["2026-05"], "STALE");
    assert.equal(states["2026-06"], "PARTIAL");
    assert.equal(states["2026-07"], "STALE");
    assert.ok(result.periods[6]?.stateReasons.includes("EMPTY"));
    assert.equal(states["2026-09"], "CURRENT_PARTIAL");
    assert.equal(result.summary.missingPeriodCount, 1);
    assert.equal(result.summary.correctionPeriodCount, 1);
    assert.equal(result.summary.backfillPeriodCount, 1);
    assert.equal(result.summary.partialPeriodCount, 1);
    assert.equal(result.summary.emptyPeriodCount, 1);
  });

  it("reports correction, backfill and empty as primary states when evidence is fresh", () => {
    const sourceUpdatedAtIso = "2026-10-01T10:00:00.000Z";
    const correction = activePeriod("2026-01", "a", [moneyLine("correction", "1")], {
      sourceUpdatedAtIso,
      loadKind: "CORRECTION",
      supersededGenerationId: generation("9"),
    });
    const backfill = activePeriod("2026-02", "b", [moneyLine("backfill", "1")], {
      sourceUpdatedAtIso,
      loadKind: "BACKFILL",
    });
    const empty = activePeriod("2026-03", "c", [], { sourceUpdatedAtIso });
    const result = buildFinopsTrendsIntelligence(input("2026-01", "2026-03", [correction, backfill, empty], {
      source: {
        state: "READY",
        evaluatedAtIso: "2026-10-01T12:00:00.000Z",
        errorCode: null,
      },
    }));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.periods.map(({ state }) => state), ["CORRECTION", "BACKFILL", "EMPTY"]);
  });

  it("represents configuration-required and provider error without inventing data", () => {
    const configurationRequired = buildFinopsTrendsIntelligence(input("2026-01", "2026-02", [], {
      source: {
        state: "CONFIGURATION_REQUIRED",
        evaluatedAtIso: EVALUATED_AT,
        errorCode: null,
      },
    }));
    assert.equal(configurationRequired.ok, true);
    if (configurationRequired.ok) {
      assert.equal(configurationRequired.state, "CONFIGURATION_REQUIRED");
      assert.deepEqual(configurationRequired.periods.map(({ state }) => state), [
        "CONFIGURATION_REQUIRED",
        "CONFIGURATION_REQUIRED",
      ]);
      assert.ok(configurationRequired.series.every(({ points }) =>
        points.every(({ totalMicros }) => totalMicros === null)));
    }

    const providerError = buildFinopsTrendsIntelligence(input("2026-01", "2026-01", [], {
      source: {
        state: "ERROR",
        evaluatedAtIso: EVALUATED_AT,
        errorCode: "CUR2_MANIFEST_UNAVAILABLE",
      },
    }));
    assert.equal(providerError.ok, true);
    if (providerError.ok) {
      assert.equal(providerError.state, "ERROR");
      assert.equal(providerError.periods[0]?.state, "ERROR");
    }
  });

  it("blocks cross-tenant rows, duplicate line items and false cost-basis completeness", () => {
    const valid = activePeriod("2026-01", "a", [moneyLine("line", "100")]);
    const crossTenant = {
      ...valid,
      rows: valid.rows.map((row) => ({ ...row, customerId: "customer_other" })),
    };
    const crossTenantResult = buildFinopsTrendsIntelligence(input("2026-01", "2026-01", [crossTenant]));
    assert.equal(crossTenantResult.ok, false);
    if (!crossTenantResult.ok) assert.equal(crossTenantResult.failures[0]?.code, "ROW_SCOPE_MISMATCH");

    const duplicated = activePeriod("2026-01", "a", [
      moneyLine("same", "100"),
      moneyLine("same", "200"),
    ]);
    const duplicateResult = buildFinopsTrendsIntelligence(input("2026-01", "2026-01", [duplicated]));
    assert.equal(duplicateResult.ok, false);
    if (!duplicateResult.ok) assert.equal(duplicateResult.failures[0]?.code, "DUPLICATE_LINE_ITEM");

    const falseCompleteness = activePeriod("2026-01", "a", [
      moneyLine("missing-net", "100", { netUnblendedCostMicros: null }),
    ], { availableCostBases: ["unblended", "net"] });
    const completenessResult = buildFinopsTrendsIntelligence(input("2026-01", "2026-01", [falseCompleteness]));
    assert.equal(completenessResult.ok, false);
    if (!completenessResult.ok) {
      assert.equal(completenessResult.failures[0]?.code, "COST_BASIS_EVIDENCE_MISMATCH");
    }
  });

  it("enforces bounded windows/options and deterministic lineage ordering", () => {
    const overlong = buildFinopsTrendsIntelligence(input("2010-01", "2026-01", []));
    assert.equal(overlong.ok, false);
    if (!overlong.ok) assert.equal(overlong.failures[0]?.code, "PERIOD_LIMIT_EXCEEDED");

    const badOptions = buildFinopsTrendsIntelligence(input("2026-01", "2026-01", [], {
      options: { rollingWindowMonths: 13 },
    }));
    assert.equal(badOptions.ok, false);
    if (!badOptions.ok) assert.equal(badOptions.failures[0]?.code, "INVALID_OPTIONS");

    const period = activePeriod("2026-01", "a", [
      moneyLine("z-line", "1"),
      moneyLine("a-line", "2"),
    ]);
    const first = buildFinopsTrendsIntelligence(input("2026-01", "2026-01", [period]));
    const second = buildFinopsTrendsIntelligence(input("2026-01", "2026-01", [period]));
    assert.equal(JSON.stringify(first), JSON.stringify(second));
    assert.equal(first.ok, true);
    if (first.ok) {
      assert.deepEqual(first.periods[0]?.lineage?.sourceLineItemIds, ["a-line", "z-line"]);
      assert.equal(first.periods[0]?.lineage?.generationId, generation("a"));
      assert.equal(first.periods[0]?.lineage?.manifestSha256, "a".repeat(64));
    }
  });

  it("does not emit comparisons, contributors, or signals across a missing month", () => {
    const january = activePeriod("2026-01", "a", [moneyLine("jan", "100000000")]);
    const march = activePeriod("2026-03", "c", [moneyLine("mar", "300000000")]);
    const result = buildFinopsTrendsIntelligence(input("2026-01", "2026-03", [january, march]));

    assert.equal(result.ok, true);
    if (!result.ok) return;
    const marchPoint = result.series[0]?.points[2];
    assert.deepEqual(marchPoint?.monthOverMonth, {
      available: false,
      reason: "MISSING_PERIOD",
    });
    assert.ok(marchPoint?.contributors.every(({ available, unavailableReason }) =>
      !available && unavailableReason === "MISSING_PERIOD"));
    assert.deepEqual(marchPoint?.signals, []);
  });
});
