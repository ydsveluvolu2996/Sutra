import assert from "node:assert/strict";
import test from "node:test";
import { parseCurCsv, type CanonicalCurLine } from "../lib/finops-cur.ts";
import {
  DataTransferAnalysisError,
  buildDataTransferAnalysis,
  type DataTransferCapture,
  type DataTransferTenantBoundary,
} from "../lib/finops-data-transfer.ts";
import type { FinopsReconciliationScope, ScopedCanonicalBillingRow } from "../lib/finops-reconciliation.ts";

const PAYER = "111111111111";
const MEMBER = "222222222222";
const NOW = new Date("2026-07-31T12:00:00.000Z");
const SCOPE: FinopsReconciliationScope = { organizationId: "org_provider",
  customerId: "customer_provider", connectionId: "conn_provider", exportName: "cur2",
  billingPeriod: "2026-07", generationId: `fbg_${"a".repeat(64)}` };
const BOUNDARY: DataTransferTenantBoundary = { scope: SCOPE, payerAccountIds: [PAYER],
  usageAccountIds: [MEMBER] };

const HEADER = ["line_item_id", "line_item_usage_account_id", "bill_payer_account_id",
  "product_servicecode", "product_servicename", "line_item_product_code",
  "product_product_name", "product_product_family", "line_item_line_item_type",
  "line_item_usage_start_date", "line_item_usage_end_date", "line_item_unblended_cost",
  "line_item_currency_code", "line_item_usage_type", "line_item_usage_amount", "pricing_unit",
  "product_from_location", "product_to_location", "product_from_location_type",
  "product_transfer_type", "line_item_operation", "line_item_resource_id"].join(",");

function parsedLine(id: string, from = "US East (N. Virginia)", to = "EU (Ireland)"):
CanonicalCurLine {
  const row = [id, MEMBER, PAYER, "AmazonEC2", "Amazon Elastic Compute Cloud",
    "AmazonEC2", "Amazon Elastic Compute Cloud", "Data Transfer", "Usage",
    "2026-07-31T10:00:00.000Z", "2026-07-31T11:00:00.000Z", "1.25", "USD",
    "USE1-EUW1-AWS-Out-Bytes", "2", "GB", from, to, "AWS Region", "InterRegion Out",
    "RunInstances", "i-0123456789abcdef0"].join(",");
  const result = parseCurCsv(`${HEADER}\n${row}`);
  assert.ok(!("error" in result));
  assert.equal(result.lines.length, 1);
  return result.lines[0]!;
}

function scoped(line: CanonicalCurLine): ScopedCanonicalBillingRow {
  return { ...SCOPE, line };
}

function capture(lines: readonly CanonicalCurLine[]): DataTransferCapture {
  const rows = lines.map(scoped);
  return { schemaVersion: "sutra.finops-data-transfer-capture.v1", scope: SCOPE, rows,
    evidence: { source: "AWS_CUR2_ACTIVE_GENERATION", sourceFormat: "aws-cur",
      sourceVersion: "2.0", sourceEvidenceId: "provider-contract", manifestSha256: "b".repeat(64),
      generationId: SCOPE.generationId, generationState: "ACTIVE",
      generatedAtIso: "2026-07-31T11:30:00.000Z", dataThroughAtIso: "2026-07-31T11:00:00.000Z",
      observedAtIso: "2026-07-31T11:35:00.000Z", payerAccountIds: [PAYER],
      usageAccountIds: [MEMBER], status: "SUCCEEDED", manifestObjectCount: 1,
      processedObjectCount: 1, sourceRowCount: rows.length, acceptedRowCount: rows.length,
      rejectedRowCount: 0, rowsExhausted: true, errorCode: null } };
}

test("CUR2 parser retains the official Data Transfer provider dimensions exactly", () => {
  const line = parsedLine("path-1");
  assert.equal(line.providerServiceCode, "AmazonEC2");
  assert.equal(line.providerServiceName, "Amazon Elastic Compute Cloud");
  assert.equal(line.fromLocation, "US East (N. Virginia)");
  assert.equal(line.toLocation, "EU (Ireland)");
  assert.equal(line.fromLocationType, "AWS Region");
  assert.equal(line.transferType, "InterRegion Out");
});

test("distinct provider-reported transfer paths cannot collapse into one drilldown", () => {
  const report = buildDataTransferAnalysis(BOUNDARY, capture([
    parsedLine("path-east", "US East (N. Virginia)", "EU (Ireland)"),
    parsedLine("path-west", "US West (Oregon)", "EU (Ireland)"),
  ]), NOW);
  assert.equal(report.drilldowns.length, 2);
  assert.deepEqual(report.drilldowns.map((item) => item.path.sourceLocation),
    ["US East (N. Virginia)", "US West (Oregon)"]);
  assert.equal(report.drilldowns.every((item) => item.path.evidence === "CUR2_PROVIDER_REPORTED"), true);
  assert.equal(report.coverage.dimensions.sourceLocation, "complete");
  assert.equal(report.coverage.dimensions.destinationLocation, "complete");
  assert.equal(report.coverage.dimensions.providerService, "complete");
  assert.equal(report.coverage.dimensions.transferType, "complete");
});

test("missing provider endpoints stay unavailable and are never inferred from usage type or Region", () => {
  const line = { ...parsedLine("path-missing"), region: "us-east-1", providerServiceCode: undefined,
    providerServiceName: undefined, fromLocation: undefined, toLocation: undefined,
    fromLocationType: undefined, transferType: undefined };
  const report = buildDataTransferAnalysis(BOUNDARY, capture([line]), NOW);
  const drilldown = report.drilldowns[0]!;
  assert.equal(drilldown.path.sourceLocation, null);
  assert.equal(drilldown.path.destinationLocation, null);
  assert.equal(drilldown.path.evidence, "UNAVAILABLE");
  assert.equal(drilldown.provider.transferType, null);
  assert.equal(report.coverage.dimensions.sourceLocation, "unavailable");
  assert.equal(drilldown.region, "us-east-1");
  assert.equal(drilldown.path.sourceLocation, null);
});

test("provider dimensions reject control-character payloads before aggregation", () => {
  assert.throws(() => buildDataTransferAnalysis(BOUNDARY,
    capture([{ ...parsedLine("path-hostile"), fromLocation: "EU\0secret" }]), NOW),
  (error: unknown) => error instanceof DataTransferAnalysisError && error.code === "SOURCE_MISMATCH");
});

test("provider path ordering remains deterministic when source rows are reversed", () => {
  const lines = [parsedLine("path-east", "US East (N. Virginia)"),
    parsedLine("path-west", "US West (Oregon)")];
  const forward = buildDataTransferAnalysis(BOUNDARY, capture(lines), NOW);
  const reverse = buildDataTransferAnalysis(BOUNDARY, capture([...lines].reverse()), NOW);
  assert.deepEqual(forward, reverse);
});
