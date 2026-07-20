// Pure, deterministic cadence math for scheduled FinOps cost reports. It reads
// no wall clock — the caller supplies the epoch it is advancing FROM, so the
// same inputs always yield the same next-run instant. Two cadences only:
//   * weekly  — exactly seven days later.
//   * monthly — the same calendar day one month later, in UTC, clamped to the
//     last day of the target month (so 2026-01-31 -> 2026-02-28, never a
//     rolled-over 2026-03-03).
// Nothing is synthesized beyond that arithmetic; there is no hidden clock and no
// timezone drift (all math is UTC).

export type ReportCadence = "weekly" | "monthly";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function isReportCadence(value: unknown): value is ReportCadence {
  return value === "weekly" || value === "monthly";
}

/**
 * Compute the next run instant (ISO 8601, UTC) for a cadence, advancing from
 * `fromMs`. Weekly adds seven days; monthly adds one calendar month with a
 * clamp to the last valid day of the target month.
 */
export function nextRunAtIso(cadence: ReportCadence, fromMs: number): string {
  if (!Number.isFinite(fromMs)) {
    throw Object.assign(new Error("The schedule clock is invalid"), { code: "INVALID_INPUT" });
  }
  if (cadence === "weekly") {
    return new Date(fromMs + WEEK_MS).toISOString();
  }
  const from = new Date(fromMs);
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth();
  const day = from.getUTCDate();
  // Last day of the NEXT month (day 0 of the month after next), used to clamp.
  const lastDayOfNextMonth = new Date(Date.UTC(year, month + 2, 0)).getUTCDate();
  const clampedDay = Math.min(day, lastDayOfNextMonth);
  const next = new Date(Date.UTC(
    year,
    month + 1,
    clampedDay,
    from.getUTCHours(),
    from.getUTCMinutes(),
    from.getUTCSeconds(),
    from.getUTCMilliseconds(),
  ));
  return next.toISOString();
}
