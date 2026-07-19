import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCsv, parseCurCsv, toMicros } from "../lib/finops-cur.ts";
import { buildAllocation, detectAnomalies, evaluateBudgets } from "../lib/finops-insights.ts";

const CUR_HEADER = "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_unblended_cost,line_item_currency_code,resource_tags_user_env";

function curFile(rows: readonly string[]): string {
  return [CUR_HEADER, ...rows].join("\n");
}

describe("toMicros", () => {
  it("parses decimals into integer micro-units without float drift", () => {
    assert.equal(toMicros("0.1"), "100000");
    assert.equal(toMicros("12.345678"), "12345678");
    assert.equal(toMicros("-3.5"), "-3500000");
    assert.equal(toMicros("1e5"), null);
    assert.equal(toMicros("NaN"), null);
  });
});

describe("parseCsv", () => {
  it("handles quoted fields, escaped quotes and CRLF", () => {
    const rows = parseCsv('a,"b,1","say ""hi"""\r\nc,d,e');
    assert.deepEqual(rows, [["a", "b,1", 'say "hi"'], ["c", "d", "e"]]);
  });
});

describe("parseCurCsv", () => {
  it("normalizes CUR 2.0 rows and keeps line-item identity", () => {
    const result = parseCurCsv(curFile([
      "li-1,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,10.50,USD,prod",
      "li-2,111111111111,AmazonS3,Usage,2026-07-01T00:00:00Z,0.25,USD,",
    ]));
    assert.equal("error" in result, false);
    if ("error" in result) return;
    assert.equal(result.dialect, "cur-2.0");
    assert.equal(result.lines.length, 2);
    assert.equal(result.lines[0].amountMicros, "10500000");
    assert.deepEqual(result.lines[0].tags, { env: "prod" });
    assert.deepEqual(result.lines[1].tags, {});
    assert.deepEqual(result.currencies, ["USD"]);
  });

  it("rejects malformed rows with row numbers and reasons — never silently drops", () => {
    const result = parseCurCsv(curFile([
      "li-1,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,not-a-number,USD,",
      "li-2,111111111111,AmazonEC2,Usage,not-a-date,1.00,USD,",
      "li-3,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,US,",
      "li-4,,AmazonEC2,Usage,2026-07-01T00:00:00Z,1.00,USD,",
      "li-5,111111111111,AmazonEC2,Usage,2026-07-02T00:00:00Z,2.00,USD,",
    ]));
    if ("error" in result) throw new Error(result.error);
    assert.equal(result.lines.length, 1);
    assert.equal(result.rejected.length, 4);
    assert.equal(result.totalRows, 5);
    assert.match(result.rejected[0].reason, /not a decimal/);
    assert.match(result.rejected[1].reason, /not parseable/);
    assert.match(result.disclaimer, /never estimated/);
  });

  it("parses FOCUS 1.0 headers and refuses unknown formats explicitly", () => {
    const focus = [
      "BillingAccountId,SubAccountId,ServiceName,ChargeCategory,ChargePeriodStart,BilledCost,BillingCurrency,ChargeDescription",
      "1,2,Amazon EC2,Usage,2026-07-01T00:00:00Z,5.00,USD,compute",
    ].join("\n");
    const result = parseCurCsv(focus);
    if ("error" in result) throw new Error(result.error);
    assert.equal(result.dialect, "focus-1.0");
    assert.equal(result.lines[0].usageAccountId, "2");
    const unknown = parseCurCsv("foo,bar\n1,2");
    assert.equal("error" in unknown && unknown.error.includes("neither"), true);
  });
});

describe("finops insights", () => {
  const parsed = parseCurCsv(curFile([
    "li-1,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,10.00,USD,prod",
    "li-2,222222222222,AmazonS3,Usage,2026-07-01T00:00:00Z,4.00,USD,prod",
    "li-3,111111111111,AmazonEC2,Usage,2026-07-01T02:00:00Z,6.00,USD,",
    "li-4,111111111111,AmazonEC2,Usage,2026-07-01T00:00:00Z,3.00,EUR,prod",
  ]));
  if ("error" in parsed) throw new Error(parsed.error);
  const lines = parsed.lines;

  it("allocates by tag per currency and discloses the unallocated remainder", () => {
    const results = buildAllocation(lines, "tag", "env");
    assert.equal(results.length, 2); // EUR and USD, never mixed
    const usd = results.find((entry) => entry.currency === "USD")!;
    assert.equal(usd.buckets[0].key, "prod");
    assert.equal(usd.buckets[0].amountMicros, "14000000");
    assert.equal(usd.unallocatedMicros, "6000000");
    assert.equal(usd.totalMicros, "20000000");
  });

  it("evaluates budgets with warning/breach thresholds and honest no-data", () => {
    const evaluations = evaluateBudgets(lines, [
      { id: "b1", name: "EC2 USD", currency: "USD", limitMicros: "20000000", filter: { dimension: "service", value: "AmazonEC2" } },
      { id: "b2", name: "GBP budget", currency: "GBP", limitMicros: "1000000" },
    ]);
    assert.equal(evaluations[0].state, "warning"); // 16 of 20 = 80%
    assert.equal(evaluations[0].spentMicros, "16000000");
    assert.equal(evaluations[1].state, "no-data");
    assert.equal(evaluations[1].utilizationPercent, null);
  });

  it("flags spikes only with enough history, above the noise floor", () => {
    const spikeLines = [
      ...["01", "02", "03", "04"].map((day, index) => ({
        lineItemId: `d${index}`, usageAccountId: "1", service: "AmazonEC2", chargeCategory: "Usage",
        usageStartIso: `2026-07-${day}T00:00:00.000Z`, amountMicros: "2000000", currency: "USD", tags: {},
      })),
      { lineItemId: "spike", usageAccountId: "1", service: "AmazonEC2", chargeCategory: "Usage", usageStartIso: "2026-07-05T00:00:00.000Z", amountMicros: "9000000", currency: "USD", tags: {} },
    ];
    const result = detectAnomalies(spikeLines);
    assert.equal(result.anomalies.length, 1);
    assert.equal(result.anomalies[0].dateIso, "2026-07-05");
    assert.equal(result.anomalies[0].ratio, 4.5);
    assert.match(result.disclaimer, /not billing truth/);
    // Two days of history is not enough to call anything anomalous.
    assert.equal(detectAnomalies(spikeLines.slice(2)).anomalies.length, 0);
  });
});
