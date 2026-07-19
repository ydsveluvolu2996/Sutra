/**
 * Compliance readiness trend: a pure transform over per-snapshot framework
 * readiness counts recorded at evaluation time. The trend only ever reflects
 * evaluations that actually happened — it starts accumulating when the
 * feature ships and never back-fills or interpolates missing snapshots.
 * A score is null (not zero) when a point evaluated no controls.
 */

export interface ComplianceTrendPoint {
  readonly snapshotId: string;
  readonly collectedAtMs: number;
  readonly passCount: number;
  readonly failCount: number;
  readonly unknownCount: number;
  readonly notCollectedCount: number;
}

export interface ScoredComplianceTrendPoint extends ComplianceTrendPoint {
  readonly score: number | null;
}

export type ComplianceTrendDirection = "improving" | "regressing" | "stable" | "insufficient-data";

export interface ComplianceTrend {
  readonly series: readonly ScoredComplianceTrendPoint[];
  readonly current: ScoredComplianceTrendPoint | null;
  readonly previous: ScoredComplianceTrendPoint | null;
  readonly delta: number | null;
  readonly direction: ComplianceTrendDirection;
  readonly regression: boolean;
  readonly disclaimer: string;
}

export const COMPLIANCE_TREND_DISCLAIMER =
  "Trend points are recorded when framework readiness is evaluated against a published snapshot. " +
  "The series reflects only evaluations that ran; gaps are gaps, not interpolated data.";

/** Share of framework controls that PASSed, out of everything evaluated. */
export function complianceScore(point: ComplianceTrendPoint): number | null {
  const total = point.passCount + point.failCount + point.unknownCount + point.notCollectedCount;
  if (total === 0) return null;
  return Math.round((point.passCount / total) * 100);
}

/** Build the trend from recorded points. Deterministic; sorts by collection time. */
export function buildComplianceTrend(points: readonly ComplianceTrendPoint[]): ComplianceTrend {
  const series: ScoredComplianceTrendPoint[] = [...points]
    .sort((a, b) => a.collectedAtMs - b.collectedAtMs || a.snapshotId.localeCompare(b.snapshotId))
    .map((point) => ({ ...point, score: complianceScore(point) }));
  const scored = series.filter((point) => point.score !== null);
  const current = scored.length > 0 ? scored[scored.length - 1] : null;
  const previous = scored.length > 1 ? scored[scored.length - 2] : null;
  if (current === null || previous === null) {
    return {
      series,
      current,
      previous: null,
      delta: null,
      direction: "insufficient-data",
      regression: false,
      disclaimer: COMPLIANCE_TREND_DISCLAIMER,
    };
  }
  const delta = (current.score as number) - (previous.score as number);
  return {
    series,
    current,
    previous,
    delta,
    direction: delta > 0 ? "improving" : delta < 0 ? "regressing" : "stable",
    regression: delta < 0,
    disclaimer: COMPLIANCE_TREND_DISCLAIMER,
  };
}
