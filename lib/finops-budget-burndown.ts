import type { NormalizedCurLine } from "./finops-cur.ts";
import type { BudgetDefinition } from "./finops-insights.ts";

/**
 * Budget burn-down + forecast-breach engine over ingested CUR billing lines.
 * Pure and deterministic — every value is derived from the supplied lines and
 * the caller-provided calendar facts, never from the wall clock. Honesty rules:
 * - "As of" is the latest usage day PRESENT in the ingested file, passed in as
 *   `asOfDayIndex` (a 1-based day-of-month). Elapsed days and days-in-month are
 *   likewise passed in — the engine reads no clock, so it matches the billing
 *   file rather than "today".
 * - A budget only counts lines that match its currency and optional filter,
 *   mirroring evaluateBudgets. Currency is single per budget; sums use BigInt to
 *   avoid float drift, then exposed as numbers for JSON (as buildDailyCost does).
 * - Month-to-date spend is the cumulative matched spend through the latest
 *   present usage day — not an extrapolation.
 * - The run-rate projection is a disclosed straight-line forecast (MTD divided
 *   by elapsed days, scaled to the full month). It is a signal, not a bill, and
 *   never a savings claim.
 * - `daysToBreach` is null when the straight-line run-rate never crosses the
 *   budget within the month; a divide-by-zero or zero-budget never fabricates a
 *   percent (a null is reported instead).
 */

export interface BudgetBurndownPoint {
  /** 1-based day-of-month index with matched spend. */
  readonly day: number;
  /** Cumulative matched micros through this day (as a number). */
  readonly cumulative: number;
  /** Ideal linear pace at this day: budget * (day / daysInMonth). */
  readonly budgetPace: number;
}

export interface BudgetBurndown {
  readonly id: string;
  readonly name: string;
  readonly currency: string;
  readonly budgetMicros: number;
  readonly mtdMicros: number;
  readonly consumedPercent: number | null;
  readonly projectedMonthEndMicros: number | null;
  readonly projectedOverspendMicros: number;
  readonly daysToBreach: number | null;
  readonly status: "ok" | "at_risk" | "breached";
  readonly matchedLineCount: number;
  readonly series: readonly BudgetBurndownPoint[];
}

export interface BudgetBurndownResult {
  readonly period: string;
  readonly asOfDayIndex: number;
  readonly daysInMonth: number;
  readonly budgets: readonly BudgetBurndown[];
  readonly note: string;
}

export interface BudgetBurndownInput {
  readonly budgets: readonly BudgetDefinition[];
  readonly dailyLines: readonly NormalizedCurLine[];
  readonly period: string;
  /** 1-based day-of-month of the latest usage day present in the data. */
  readonly asOfDayIndex: number;
  readonly daysInMonth: number;
}

export const BUDGET_BURNDOWN_NOTE =
  "Burn-down and forecast are computed as of the latest usage day present in the ingested billing " +
  "file — not the current calendar day. The projected month-end is a disclosed straight-line run-rate " +
  "(month-to-date spend divided by elapsed days, scaled to the full month), not a bill or a savings claim.";

/** Mirror of evaluateBudgets line matching: currency + optional filter. */
function matchesBudget(line: NormalizedCurLine, budget: BudgetDefinition): boolean {
  if (line.currency !== budget.currency) return false;
  if (budget.filter === undefined) return true;
  if (budget.filter.dimension === "account") return line.usageAccountId === budget.filter.value;
  if (budget.filter.dimension === "service") return line.service === budget.filter.value;
  const tagKey = budget.filter.tagKey ?? "";
  return Object.prototype.hasOwnProperty.call(line.tags, tagKey) && line.tags[tagKey] === budget.filter.value;
}

function buildOne(
  budget: BudgetDefinition,
  lines: readonly NormalizedCurLine[],
  period: string,
  asOfDayIndex: number,
  daysInMonth: number,
): BudgetBurndown {
  const budgetBig = BigInt(budget.limitMicros);
  const budgetNum = Number(budgetBig);

  // Group matched, in-period lines by their 1-based day-of-month, summing with
  // BigInt so micro totals never drift. Days outside the period are ignored.
  const byDay = new Map<number, bigint>();
  let matchedLineCount = 0;
  for (const line of lines) {
    if (line.usageStartIso.slice(0, 7) !== period) continue;
    if (!matchesBudget(line, budget)) continue;
    matchedLineCount += 1;
    const day = Number(line.usageStartIso.slice(8, 10));
    if (!Number.isInteger(day) || day < 1) continue;
    byDay.set(day, (byDay.get(day) ?? BigInt(0)) + BigInt(line.amountMicros));
  }

  const days = [...byDay.keys()].sort((a, b) => a - b);
  let running = BigInt(0);
  const series: BudgetBurndownPoint[] = [];
  for (const day of days) {
    running += byDay.get(day) ?? BigInt(0);
    const budgetPace = daysInMonth > 0 ? budgetNum * (day / daysInMonth) : 0;
    series.push({ day, cumulative: Number(running), budgetPace });
  }

  // Month-to-date is the cumulative matched spend through the latest present day.
  const mtdMicros = Number(running);
  const elapsedDays = asOfDayIndex;
  const consumedPercent = budgetNum > 0 ? (mtdMicros / budgetNum) * 100 : null;

  // Straight-line run-rate projection to month end.
  const projectedMonthEndMicros = elapsedDays > 0 ? (mtdMicros / elapsedDays) * daysInMonth : null;
  const projectedOverspendMicros =
    projectedMonthEndMicros !== null ? Math.max(0, projectedMonthEndMicros - budgetNum) : 0;

  // Days until the run-rate line crosses the budget, relative to as-of. Null if
  // it never crosses within the month (or with no spend / no positive budget).
  const perDay = elapsedDays > 0 ? mtdMicros / elapsedDays : 0;
  let daysToBreach: number | null = null;
  if (perDay > 0 && budgetNum > 0) {
    const crossDay = budgetNum / perDay;
    if (crossDay <= daysInMonth) daysToBreach = Math.max(0, Math.ceil(crossDay - elapsedDays));
  }

  let status: BudgetBurndown["status"];
  if (budgetNum > 0 && mtdMicros >= budgetNum) status = "breached";
  else if (projectedMonthEndMicros !== null && projectedMonthEndMicros > budgetNum) status = "at_risk";
  else status = "ok";

  return {
    id: budget.id,
    name: budget.name,
    currency: budget.currency,
    budgetMicros: budgetNum,
    mtdMicros,
    consumedPercent,
    projectedMonthEndMicros,
    projectedOverspendMicros,
    daysToBreach,
    status,
    matchedLineCount,
    series,
  };
}

/**
 * Build a per-budget burn-down + forecast-breach report. Pure: calendar facts
 * (elapsed/as-of day, days in the month) are supplied by the caller.
 */
export function buildBudgetBurndown(input: BudgetBurndownInput): BudgetBurndownResult {
  const { budgets, dailyLines, period, asOfDayIndex, daysInMonth } = input;
  return {
    period,
    asOfDayIndex,
    daysInMonth,
    budgets: budgets.map((budget) => buildOne(budget, dailyLines, period, asOfDayIndex, daysInMonth)),
    note: BUDGET_BURNDOWN_NOTE,
  };
}
