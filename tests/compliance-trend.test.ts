import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildComplianceTrend, complianceScore, type ComplianceTrendPoint } from "../lib/compliance-trend.ts";

function point(overrides: Partial<ComplianceTrendPoint>): ComplianceTrendPoint {
  return { snapshotId: "snap-1", collectedAtMs: 1_000, passCount: 8, failCount: 2, unknownCount: 0, notCollectedCount: 0, ...overrides };
}

describe("complianceScore", () => {
  it("scores the passed share of everything evaluated, and is null when nothing was", () => {
    assert.equal(complianceScore(point({})), 80);
    assert.equal(complianceScore(point({ passCount: 0, failCount: 0, unknownCount: 0, notCollectedCount: 0 })), null);
    // NOT_COLLECTED drags the score down — absence is never free.
    assert.equal(complianceScore(point({ passCount: 5, failCount: 0, unknownCount: 0, notCollectedCount: 5 })), 50);
  });
});

describe("buildComplianceTrend", () => {
  it("reports insufficient data below two scored points", () => {
    assert.equal(buildComplianceTrend([]).direction, "insufficient-data");
    const single = buildComplianceTrend([point({})]);
    assert.equal(single.direction, "insufficient-data");
    assert.equal(single.current?.score, 80);
    assert.equal(single.delta, null);
  });

  it("orders by collection time and computes delta, direction and regression", () => {
    const trend = buildComplianceTrend([
      point({ snapshotId: "snap-3", collectedAtMs: 3_000, passCount: 6, failCount: 4 }),
      point({ snapshotId: "snap-1", collectedAtMs: 1_000, passCount: 9, failCount: 1 }),
      point({ snapshotId: "snap-2", collectedAtMs: 2_000, passCount: 8, failCount: 2 }),
    ]);
    assert.deepEqual(trend.series.map((p) => p.snapshotId), ["snap-1", "snap-2", "snap-3"]);
    assert.equal(trend.current?.snapshotId, "snap-3");
    assert.equal(trend.delta, -20);
    assert.equal(trend.direction, "regressing");
    assert.equal(trend.regression, true);
    assert.match(trend.disclaimer, /gaps are gaps/);
  });

  it("skips null-score points for delta but keeps them in the series", () => {
    const trend = buildComplianceTrend([
      point({ snapshotId: "snap-1", collectedAtMs: 1_000, passCount: 8, failCount: 2 }),
      point({ snapshotId: "snap-empty", collectedAtMs: 2_000, passCount: 0, failCount: 0 }),
      point({ snapshotId: "snap-3", collectedAtMs: 3_000, passCount: 9, failCount: 1 }),
    ]);
    assert.equal(trend.series.length, 3);
    assert.equal(trend.current?.snapshotId, "snap-3");
    assert.equal(trend.previous?.snapshotId, "snap-1");
    assert.equal(trend.delta, 10);
    assert.equal(trend.direction, "improving");
  });
});
