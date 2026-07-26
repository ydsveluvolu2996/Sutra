import type { NormalizedCurLine } from "./finops-cur.ts";

/**
 * Day-over-day FinOps cost from ingested CUR billing lines. Pure and
 * deterministic — every value is derived from the supplied lines, never from
 * the wall clock. Honesty rules:
 * - Days are grouped by the UTC calendar day of each line's usageStartIso.
 * - amountMicros are integer micro-units summed with BigInt to avoid float
 *   drift; the exposed `amount` is that per-day micro total as a number.
 * - The "latest" day is simply the last day present in the ingested file, not
 *   the current calendar day — AWS finalizes cost with a delay. This is stated
 *   in `note` so the number is never mistaken for live spend.
 * - A percent change is only reported when a non-zero prior day exists; an
 *   absent or zero prior yields a null percent (never a divide-by-zero).
 */

export interface DailyCostPoint {
  readonly date: string;
  readonly amount: number;
}

export interface DailyCostResult {
  readonly series: readonly DailyCostPoint[];
  readonly latestDay: DailyCostPoint | null;
  readonly priorDay: DailyCostPoint | null;
  readonly deltaAmount: number | null;
  readonly deltaPercent: number | null;
  readonly currency: string;
  readonly note: string;
}

export const DAILY_COST_NOTE =
  "Reflects the latest usage day present in the ingested billing file; AWS finalizes cost " +
  "with a delay, so this is not necessarily the current calendar day.";

/**
 * Group CUR lines into a day-over-day cost series and report the change from
 * the prior present day to the latest present day.
 */
export function buildDailyCost(lines: readonly NormalizedCurLine[], currency: string): DailyCostResult {
  const byDay = new Map<string, bigint>();
  for (const line of lines) {
    const day = line.usageStartIso.slice(0, 10);
    byDay.set(day, (byDay.get(day) ?? BigInt(0)) + BigInt(line.amountMicros));
  }
  const series: DailyCostPoint[] = [...byDay.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([date, amount]) => ({ date, amount: Number(amount) }));

  const latestDay = series.length > 0 ? series[series.length - 1] : null;
  const priorDay = series.length > 1 ? series[series.length - 2] : null;

  const deltaAmount = latestDay !== null && priorDay !== null ? latestDay.amount - priorDay.amount : null;
  const deltaPercent =
    latestDay !== null && priorDay !== null && priorDay.amount !== 0
      ? ((latestDay.amount - priorDay.amount) / priorDay.amount) * 100
      : null;

  return {
    series,
    latestDay,
    priorDay,
    deltaAmount,
    deltaPercent,
    currency,
    note: DAILY_COST_NOTE,
  };
}
