import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import type { BudgetDefinition } from "../lib/finops-insights.ts";
import { buildBudgetBurndown, BUDGET_BURNDOWN_NOTE } from "../lib/finops-budget-burndown.ts";

const PERIOD = "2026-07";
const DAYS_IN_MONTH = 30;

/** Minimal CUR line — the engine reads usageStartIso + amountMicros + currency + matchers. */
function line(dayOfMonth: number, amountMicros: string): NormalizedCurLine {
  const dd = String(dayOfMonth).padStart(2, "0");
  return {
    lineItemId: `li-${dd}-${amountMicros}`,
    usageAccountId: "111111111111",
    service: "AmazonEC2",
    chargeCategory: "Usage",
    usageStartIso: `${PERIOD}-${dd}T00:00:00.000Z`,
    amountMicros,
    currency: "USD",
    region: null,
    tags: {},
  };
}

function budget(limitMicros: string): BudgetDefinition {
  return { id: "fb_1", name: "Platform", currency: "USD", limitMicros };
}

describe("buildBudgetBurndown", () => {
  it("reports ok with no forecast breach when comfortably under budget", () => {
    // Budget 1000; MTD 200 over 10 elapsed days -> run-rate 20/day -> month-end 600 < 1000.
    const result = buildBudgetBurndown({
      budgets: [budget("1000000000")],
      dailyLines: [line(5, "100000000"), line(10, "100000000")],
      period: PERIOD,
      asOfDayIndex: 10,
      daysInMonth: DAYS_IN_MONTH,
    });

    assert.equal(result.note, BUDGET_BURNDOWN_NOTE);
    assert.equal(result.budgets.length, 1);
    const b = result.budgets[0];
    assert.equal(b.status, "ok");
    assert.equal(b.mtdMicros, 200000000);
    assert.equal(b.budgetMicros, 1000000000);
    assert.equal(b.consumedPercent, 20);
    assert.equal(b.projectedMonthEndMicros, 600000000);
    assert.equal(b.projectedOverspendMicros, 0);
    // Run-rate crosses 1000 only at day 50 (> 30), so it never breaches this month.
    assert.equal(b.daysToBreach, null);
    assert.equal(b.matchedLineCount, 2);
  });

  it("reports at_risk with days-to-breach and projected overspend when on track to exceed", () => {
    // Budget 300; MTD 150 over 10 days -> 15/day -> month-end 450 > 300, but MTD 150 < 300.
    const result = buildBudgetBurndown({
      budgets: [budget("300000000")],
      dailyLines: [line(5, "75000000"), line(10, "75000000")],
      period: PERIOD,
      asOfDayIndex: 10,
      daysInMonth: DAYS_IN_MONTH,
    });

    const b = result.budgets[0];
    assert.equal(b.status, "at_risk");
    assert.equal(b.mtdMicros, 150000000);
    assert.equal(b.consumedPercent, 50);
    assert.equal(b.projectedMonthEndMicros, 450000000);
    assert.equal(b.projectedOverspendMicros, 150000000);
    // Crosses 300 at day 20 (300 / 15); 20 - 10 elapsed = 10 more days.
    assert.equal(b.daysToBreach, 10);

    // Burn-down series: cumulative actual vs ideal linear pace (budget * day / daysInMonth).
    assert.deepEqual(b.series, [
      { day: 5, cumulative: 75000000, budgetPace: 300000000 * (5 / 30) },
      { day: 10, cumulative: 150000000, budgetPace: 300000000 * (10 / 30) },
    ]);
  });

  it("reports breached when month-to-date is already over budget", () => {
    // Budget 100; MTD 150 already exceeds it. Latest usage day is 3.
    const result = buildBudgetBurndown({
      budgets: [budget("100000000")],
      dailyLines: [line(1, "50000000"), line(2, "50000000"), line(3, "50000000")],
      period: PERIOD,
      asOfDayIndex: 3,
      daysInMonth: DAYS_IN_MONTH,
    });

    const b = result.budgets[0];
    assert.equal(b.status, "breached");
    assert.equal(b.mtdMicros, 150000000);
    assert.equal(b.consumedPercent, 150);
    assert.equal(b.projectedMonthEndMicros, 1500000000); // 150/3*30
    assert.equal(b.projectedOverspendMicros, 1400000000);
    // Already over, so it crossed on/before as-of -> zero days to breach.
    assert.equal(b.daysToBreach, 0);
  });

  it("returns an empty budget list when no budgets are configured", () => {
    const result = buildBudgetBurndown({
      budgets: [],
      dailyLines: [line(5, "100000000")],
      period: PERIOD,
      asOfDayIndex: 5,
      daysInMonth: DAYS_IN_MONTH,
    });

    assert.deepEqual(result.budgets, []);
    assert.equal(result.period, PERIOD);
    assert.equal(result.asOfDayIndex, 5);
    assert.equal(result.daysInMonth, DAYS_IN_MONTH);
  });

  it("builds a cumulative burn-down series with an ideal pace per day", () => {
    // Out-of-order, multi-line days prove grouping + ascending sort + running total.
    const result = buildBudgetBurndown({
      budgets: [budget("300000000")],
      dailyLines: [
        line(3, "30000000"),
        line(1, "40000000"),
        line(1, "20000000"), // day 1 total = 60
        line(3, "50000000"), // day 3 total = 80
      ],
      period: PERIOD,
      asOfDayIndex: 3,
      daysInMonth: DAYS_IN_MONTH,
    });

    const b = result.budgets[0];
    assert.equal(b.matchedLineCount, 4);
    assert.deepEqual(b.series, [
      { day: 1, cumulative: 60000000, budgetPace: 300000000 * (1 / 30) },
      { day: 3, cumulative: 140000000, budgetPace: 300000000 * (3 / 30) },
    ]);
    assert.equal(b.mtdMicros, 140000000);
  });

  it("only counts lines matching the budget currency and filter", () => {
    const scoped: BudgetDefinition = {
      id: "fb_2",
      name: "EC2 only",
      currency: "USD",
      limitMicros: "1000000000",
      filter: { dimension: "service", value: "AmazonEC2" },
    };
    const s3Line: NormalizedCurLine = { ...line(5, "500000000"), service: "AmazonS3", lineItemId: "s3" };
    const eurLine: NormalizedCurLine = { ...line(5, "500000000"), currency: "EUR", lineItemId: "eur" };

    const result = buildBudgetBurndown({
      budgets: [scoped],
      dailyLines: [line(5, "100000000"), s3Line, eurLine],
      period: PERIOD,
      asOfDayIndex: 5,
      daysInMonth: DAYS_IN_MONTH,
    });

    const b = result.budgets[0];
    assert.equal(b.matchedLineCount, 1); // S3 (wrong service) + EUR (wrong currency) excluded
    assert.equal(b.mtdMicros, 100000000);
  });
});
