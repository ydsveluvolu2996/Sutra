import assert from "node:assert/strict";
import test from "node:test";
import {
  buildMspScorecard,
  buildPostureTrend,
  postureScore,
  type PostureTrendPoint,
} from "../lib/kubernetes-posture-trend.ts";

function point(over: Partial<PostureTrendPoint> & { collectedAt: string; severity: PostureTrendPoint["severity"] }): PostureTrendPoint {
  return {
    scanId: `scan-${over.collectedAt}`,
    status: "complete",
    resourceCount: 100,
    findingCount: over.severity.critical + over.severity.high + over.severity.medium + over.severity.low,
    coverageCount: 20,
    ...over,
  };
}
const sev = (critical: number, high: number, medium = 0, low = 0) => ({ critical, high, medium, low });

test("score matches the dashboard formula and is bounded", () => {
  assert.equal(postureScore(sev(0, 0, 0, 0)), 100);
  assert.equal(postureScore(sev(1, 0)), 86);
  assert.ok(postureScore(sev(50, 50)) >= 2);
});

test("series is sorted chronologically and delta/direction reflect the latest two points", () => {
  const trend = buildPostureTrend([
    point({ collectedAt: "2026-07-16T00:00:00.000Z", severity: sev(2, 2) }),
    point({ collectedAt: "2026-07-18T00:00:00.000Z", severity: sev(0, 1) }),
    point({ collectedAt: "2026-07-17T00:00:00.000Z", severity: sev(1, 2) }),
  ]);
  assert.deepEqual(trend.series.map((p) => p.collectedAt), [
    "2026-07-16T00:00:00.000Z", "2026-07-17T00:00:00.000Z", "2026-07-18T00:00:00.000Z",
  ]);
  // latest (0c,1h -> 94) vs previous (1c,2h -> 74) => +20, improving.
  assert.equal(trend.current, 94);
  assert.equal(trend.previous, 74);
  assert.equal(trend.delta, 20);
  assert.equal(trend.direction, "improving");
  assert.equal(trend.regression, false);
});

test("a meaningful score drop flags a regression", () => {
  const trend = buildPostureTrend([
    point({ collectedAt: "2026-07-17T00:00:00.000Z", severity: sev(0, 0) }),
    point({ collectedAt: "2026-07-18T00:00:00.000Z", severity: sev(2, 1) }),
  ]);
  assert.equal(trend.current, 66);
  assert.equal(trend.delta, -34);
  assert.equal(trend.direction, "regressing");
  assert.equal(trend.regression, true);
});

test("a single scan has a score but no delta or direction", () => {
  const trend = buildPostureTrend([point({ collectedAt: "2026-07-18T00:00:00.000Z", severity: sev(1, 0) })]);
  assert.equal(trend.current, 86);
  assert.equal(trend.previous, null);
  assert.equal(trend.delta, null);
  assert.equal(trend.direction, "stable");
  assert.equal(trend.regression, false);
});

test("empty history yields a null score and stable direction", () => {
  const trend = buildPostureTrend([]);
  assert.equal(trend.current, null);
  assert.equal(trend.series.length, 0);
  assert.equal(trend.direction, "stable");
});

test("MSP scorecard ranks regressions and worst scores first with a fleet rollup", () => {
  const scorecard = buildMspScorecard({
    clusters: [
      { clusterId: "c-healthy", clusterName: "healthy", points: [point({ collectedAt: "2026-07-18T00:00:00.000Z", severity: sev(0, 0) })] },
      { clusterId: "c-regressed", clusterName: "regressed", points: [
        point({ collectedAt: "2026-07-17T00:00:00.000Z", severity: sev(0, 0) }),
        point({ collectedAt: "2026-07-18T00:00:00.000Z", severity: sev(3, 0) }),
      ] },
      { clusterId: "c-lowest", clusterName: "lowest", points: [point({ collectedAt: "2026-07-18T00:00:00.000Z", severity: sev(6, 4) })] },
    ],
  });
  assert.equal(scorecard.clusters[0]?.clusterId, "c-regressed", "regressions rank first");
  assert.equal(scorecard.clusters[0]?.regression, true);
  assert.equal(scorecard.clusters[1]?.clusterId, "c-lowest", "then the lowest score");
  assert.equal(scorecard.clusters[2]?.clusterId, "c-healthy");
  assert.equal(scorecard.fleet.regressing, 1);
  assert.ok(scorecard.fleet.averageScore !== null && scorecard.fleet.averageScore > 0);
  assert.match(scorecard.disclaimer, /no trend is extrapolated/u);
});

test("clusters with no scans are counted as unscored, not zero", () => {
  const scorecard = buildMspScorecard({ clusters: [{ clusterId: "c", clusterName: "new", points: [] }] });
  assert.equal(scorecard.clusters[0]?.score, null);
  assert.equal(scorecard.fleet.unscored, 1);
  assert.equal(scorecard.fleet.averageScore, null);
});
