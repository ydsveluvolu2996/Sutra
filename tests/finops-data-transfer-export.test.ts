import assert from "node:assert/strict";
import test from "node:test";
import { buildDataTransferEvidenceCsv } from "../lib/finops-data-transfer-export.ts";
import type { DataTransferSnapshot } from "../lib/finops-data-transfer.ts";

const report = {
  state: "COMPLETE",
  scope: {
    billingPeriod: "2026-07",
    generationId: `fbg_${"a".repeat(64)}`,
  },
  source: { manifestSha256: "b".repeat(64) },
  taxonomy: { version: "2026-08-01.v2", sha256: "c".repeat(64) },
} as unknown as DataTransferSnapshot;

const row = {
  currency: "USD",
  costs: [{ basis: "amortized", totalMicros: "-1250000" }],
  category: "GLOBAL_ACCELERATOR",
  direction: "OUTBOUND",
  usageAccountId: "123456789012",
  service: "AWS Global Accelerator",
  region: "us-east-1",
  availabilityZone: null,
  resourceId: '=HYPERLINK("https://invalid.example")',
  rowCount: 1,
  normalizedBytesMicros: "1000000",
  classificationRuleIds: ["GLOBAL_ACCELERATOR_TRANSFER_PREMIUM_V1"],
  usageTypes: ["NA-EU-OUT-Bytes-Internet"],
  sourceLineIds: ["line-1"],
} as unknown as DataTransferSnapshot["drilldowns"][number];

test("exports exact filtered transfer evidence and neutralizes formulas", () => {
  const csv = buildDataTransferEvidenceCsv(report, [row], "amortized");
  assert.match(csv, /"cost_micros"/u);
  assert.match(csv, /"taxonomy_sha256"/u);
  assert.match(csv, /"-1250000"/u);
  assert.match(csv, /"GLOBAL_ACCELERATOR_TRANSFER_PREMIUM_V1"/u);
  assert.match(csv, /"'=HYPERLINK\(""https:\/\/invalid\.example""\)"/u);
});
