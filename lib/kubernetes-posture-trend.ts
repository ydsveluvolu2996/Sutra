// Posture trend + MSP scorecard: turns the retained scan-run history into a
// score-over-time series per cluster and a per-customer rollup an MSP can
// resell. The per-point score uses the same deterministic formula as the
// dashboard (100 minus a bounded penalty from the failing-control severity
// mix), so a number means the same thing everywhere. Nothing is extrapolated
// beyond the scans actually collected.

export type TrendDirection = "improving" | "regressing" | "stable";

export interface PostureSeverityCounts {
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
}

export interface PostureTrendPoint {
  readonly scanId: string;
  readonly collectedAt: string;
  readonly status: "complete" | "partial" | "failed";
  readonly resourceCount: number;
  readonly findingCount: number;
  readonly coverageCount: number;
  readonly severity: PostureSeverityCounts;
}

export interface ScoredTrendPoint extends PostureTrendPoint {
  readonly score: number;
}

export interface PostureTrend {
  readonly series: readonly ScoredTrendPoint[];
  readonly current: number | null;
  readonly previous: number | null;
  readonly delta: number | null;
  readonly direction: TrendDirection;
  readonly regression: boolean;
  readonly bestScore: number | null;
  readonly worstScore: number | null;
}

export interface ClusterScorecardRow {
  readonly clusterId: string;
  readonly clusterName: string;
  readonly score: number | null;
  readonly delta: number | null;
  readonly direction: TrendDirection;
  readonly regression: boolean;
  readonly openFindings: number;
  readonly criticalHigh: number;
  readonly resourceCount: number;
  readonly lastScanAt: string | null;
  readonly scanCount: number;
  readonly trend: PostureTrend;
}

export interface MspScorecard {
  readonly schema: "sutra.kubernetes-posture-scorecard.v1";
  readonly clusters: readonly ClusterScorecardRow[];
  readonly fleet: {
    readonly averageScore: number | null;
    readonly improving: number;
    readonly regressing: number;
    readonly stable: number;
    readonly unscored: number;
  };
  readonly disclaimer: string;
}

const IMPROVE_THRESHOLD = 3;
const REGRESS_THRESHOLD = 5;

const SCORECARD_DISCLAIMER =
  "Scores are computed only from the scans actually collected; a short history " +
  "shows fewer points and no trend is extrapolated. The per-point score matches " +
  "the dashboard formula (100 minus a bounded severity penalty).";

// Same penalty weights as the dashboard security score, kept in sync here.
export function postureScore(severity: PostureSeverityCounts): number {
  const penalty = severity.critical * 14 + severity.high * 6 + severity.medium * 2 + severity.low * 0.5;
  return Math.max(2, Math.round(100 - Math.min(98, penalty)));
}

function directionOf(delta: number | null): TrendDirection {
  if (delta === null) return "stable";
  if (delta >= IMPROVE_THRESHOLD) return "improving";
  if (delta <= -IMPROVE_THRESHOLD) return "regressing";
  return "stable";
}

export function buildPostureTrend(points: readonly PostureTrendPoint[]): PostureTrend {
  const series = [...points]
    .sort((left, right) => Date.parse(left.collectedAt) - Date.parse(right.collectedAt))
    .map((point) => ({ ...point, score: postureScore(point.severity) }));
  const scores = series.map((point) => point.score);
  const current = scores.length > 0 ? scores[scores.length - 1] ?? null : null;
  const previous = scores.length > 1 ? scores[scores.length - 2] ?? null : null;
  const delta = current !== null && previous !== null ? current - previous : null;
  return {
    series,
    current,
    previous,
    delta,
    direction: directionOf(delta),
    regression: delta !== null && delta <= -REGRESS_THRESHOLD,
    bestScore: scores.length > 0 ? Math.max(...scores) : null,
    worstScore: scores.length > 0 ? Math.min(...scores) : null,
  };
}

export function buildMspScorecard(input: {
  readonly clusters: readonly {
    readonly clusterId: string;
    readonly clusterName: string;
    readonly points: readonly PostureTrendPoint[];
  }[];
}): MspScorecard {
  const rows = input.clusters.map((cluster): ClusterScorecardRow => {
    const trend = buildPostureTrend(cluster.points);
    const latest = trend.series[trend.series.length - 1] ?? null;
    return {
      clusterId: cluster.clusterId,
      clusterName: cluster.clusterName,
      score: trend.current,
      delta: trend.delta,
      direction: trend.direction,
      regression: trend.regression,
      openFindings: latest?.findingCount ?? 0,
      criticalHigh: latest ? latest.severity.critical + latest.severity.high : 0,
      resourceCount: latest?.resourceCount ?? 0,
      lastScanAt: latest?.collectedAt ?? null,
      scanCount: trend.series.length,
      trend,
    };
  }).sort((left, right) => {
    // Worst posture first: regressions, then lowest score, then most critical/high.
    if (left.regression !== right.regression) return left.regression ? -1 : 1;
    const leftScore = left.score ?? 101;
    const rightScore = right.score ?? 101;
    return leftScore - rightScore ||
      right.criticalHigh - left.criticalHigh ||
      left.clusterName.localeCompare(right.clusterName, "en-US");
  });

  const scored = rows.filter((row) => row.score !== null);
  return {
    schema: "sutra.kubernetes-posture-scorecard.v1",
    clusters: rows,
    fleet: {
      averageScore: scored.length > 0
        ? Math.round(scored.reduce((sum, row) => sum + (row.score ?? 0), 0) / scored.length)
        : null,
      improving: rows.filter((row) => row.direction === "improving").length,
      regressing: rows.filter((row) => row.direction === "regressing").length,
      stable: rows.filter((row) => row.direction === "stable" && row.score !== null).length,
      unscored: rows.filter((row) => row.score === null).length,
    },
    disclaimer: SCORECARD_DISCLAIMER,
  };
}
