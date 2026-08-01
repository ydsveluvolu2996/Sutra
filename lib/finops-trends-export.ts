import type {
  FinopsTrendsPeriodSummary,
  FinopsTrendsSeries,
} from "./finops-trends-intelligence.ts";

export interface FinopsTrendsEvidenceExportReport {
  readonly rollingWindowMonths: number;
  readonly periods: readonly FinopsTrendsPeriodSummary[];
}

function csvCell(value: string | number | null): string {
  const raw = String(value ?? "");
  // Quoting is not enough to stop spreadsheet formula execution. Integer
  // negatives remain numeric; every other formula/control prefix is escaped.
  const safe = /^(?:[=+@]|-(?!\d)|[\t\r])/u.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

/** A bounded, selected-series evidence export; all money remains integer micros. */
export function buildTrendsEvidenceCsv(
  report: FinopsTrendsEvidenceExportReport,
  series: FinopsTrendsSeries,
): string {
  const periodEvidence = new Map(report.periods.map((period) => [period.period, period]));
  const header = [
    "period",
    "period_state",
    "state_reasons",
    "currency",
    "cost_basis",
    "total_micros",
    "cost_coverage",
    "month_over_month_delta_micros",
    "month_over_month_percent_numerator",
    "month_over_month_percent_denominator",
    "rolling_window_months",
    "rolling_delta_micros",
    "signal_codes",
    "generation_id",
    "manifest_sha256",
    "source_evidence_id",
  ];
  const rows = series.points.map((point) => {
    const period = periodEvidence.get(point.period);
    const monthOverMonth = point.monthOverMonth.available
      ? point.monthOverMonth
      : null;
    const rolling = point.rollingComparison.available
      ? point.rollingComparison
      : null;
    return [
      point.period,
      point.periodState,
      period?.stateReasons.join("|") ?? "",
      series.currency,
      series.costBasis,
      point.totalMicros,
      point.costCoverage,
      monthOverMonth?.deltaMicros ?? null,
      monthOverMonth?.percent?.numerator ?? null,
      monthOverMonth?.percent?.denominator ?? null,
      rolling?.windowMonths ?? report.rollingWindowMonths,
      rolling?.deltaMicros ?? null,
      point.signals.map((signal) => signal.code).join("|"),
      period?.lineage?.generationId ?? null,
      period?.lineage?.manifestSha256 ?? null,
      period?.lineage?.sourceEvidenceId ?? null,
    ].map(csvCell).join(",");
  });
  return [header.map(csvCell).join(","), ...rows].join("\n");
}
