import assert from "node:assert/strict";
import test from "node:test";
import { buildTrendsEvidenceCsv } from "../lib/finops-trends-export.ts";
import type {
  FinopsTrendsPeriodSummary,
  FinopsTrendsSeries,
} from "../lib/finops-trends-intelligence.ts";

const period: FinopsTrendsPeriodSummary = {
  period: "2026-06",
  state: "COMPLETE",
  stateReasons: ["COMPLETE"],
  loadKind: "ORIGINAL",
  generationId: `fbg_${"a".repeat(64)}`,
  collectionState: "COMPLETE",
  rowCount: 1,
  rejectedRowCount: 0,
  ageSeconds: 60,
  staleAfterSeconds: 129_600,
  lineage: {
    sourceEvidenceId: '=HYPERLINK("https://invalid.example")',
    manifestSha256: "b".repeat(64),
    generationId: `fbg_${"a".repeat(64)}`,
    sourceUpdatedAtIso: "2026-07-01T00:00:00.000Z",
    observedAtIso: "2026-07-01T00:01:00.000Z",
    committedAtIso: "2026-07-01T00:02:00.000Z",
    activatedAtIso: "2026-07-01T00:03:00.000Z",
    sourceRowCount: 1,
    sourceLineItemIdCount: 1,
    sourceLineItemIds: ["line-1"],
    sourceLineItemIdsTruncated: false,
  },
};

const series: FinopsTrendsSeries = {
  currency: "USD",
  costBasis: "unblended",
  points: [{
    period: "2026-06",
    periodState: "COMPLETE",
    totalMicros: "-1250000",
    contributingRowCount: 1,
    missingCostRowCount: 0,
    costCoverage: "complete",
    monthOverMonth: {
      available: true,
      baselineMicros: "1000000",
      currentMicros: "-1250000",
      deltaMicros: "-2250000",
      percent: { numerator: "-225", denominator: "1" },
      percentUnavailableReason: null,
    },
    trailingAverage: {
      available: false,
      reason: "INSUFFICIENT_CONTIGUOUS_HISTORY",
    },
    rollingComparison: {
      available: false,
      reason: "INSUFFICIENT_CONTIGUOUS_HISTORY",
    },
    contributors: [],
    signals: [],
  }],
};

test("exports exact micros, states and immutable lineage in deterministic CSV", () => {
  const csv = buildTrendsEvidenceCsv({ rollingWindowMonths: 3, periods: [period] }, series);
  const lines = csv.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? "", /"total_micros"/u);
  assert.match(lines[0] ?? "", /"manifest_sha256"/u);
  assert.match(lines[1] ?? "", /"-1250000"/u);
  assert.match(lines[1] ?? "", new RegExp(`"${"b".repeat(64)}"`, "u"));
  assert.match(lines[1] ?? "", /"'=HYPERLINK\(""https:\/\/invalid\.example""\)"/u);
});

test("keeps integer negatives numeric while neutralizing formula prefixes", () => {
  const csv = buildTrendsEvidenceCsv({ rollingWindowMonths: 3, periods: [{
    ...period,
    lineage: period.lineage === null ? null : {
      ...period.lineage,
      sourceEvidenceId: "-cmd|' /C calc'!A0",
    },
  }] }, series);
  const row = csv.split("\n")[1] ?? "";
  assert.match(row, /"-1250000"/u);
  assert.match(row, /"'-cmd\|' \/C calc'!A0"/u);
});
