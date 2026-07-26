import assert from "node:assert/strict";
import test from "node:test";
import { buildCostTrendsInput } from "../lib/finops-trends-inputs.ts";
import { buildCostTrends } from "../lib/finops-trends.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function line(over: Partial<NormalizedCurLine> & { usageStartIso: string; amountUnits: number }): NormalizedCurLine {
  return {
    lineItemId: over.lineItemId ?? `${over.usageStartIso}-${over.amountUnits}`,
    usageAccountId: over.usageAccountId ?? "111122223333",
    service: over.service ?? "AmazonEC2",
    chargeCategory: over.chargeCategory ?? "Usage",
    usageStartIso: over.usageStartIso,
    amountMicros: over.amountMicros ?? units(over.amountUnits),
    currency: over.currency ?? "USD",
    region: over.region ?? null,
    tags: over.tags ?? {},
  };
}

test("buckets lines into calendar-month periods and sums within a bucket", () => {
  const built = buildCostTrendsInput({
    curLines: [
      line({ usageStartIso: "2026-01-03T00:00:00.000Z", amountUnits: 40 }),
      line({ usageStartIso: "2026-01-28T00:00:00.000Z", amountUnits: 60 }),
      line({ usageStartIso: "2026-02-15T00:00:00.000Z", amountUnits: 200 }),
    ],
  });
  // Two Jan EC2 lines collapse into one (period, currency, service) bucket.
  const jan = built.entries.find((e) => e.period === "2026-01");
  assert.equal(jan?.amountMicros, units(100));
  assert.equal(jan?.lineCount, 2);
  const feb = built.entries.find((e) => e.period === "2026-02");
  assert.equal(feb?.amountMicros, units(200));
});

test("groups per currency without merging and keeps them separable downstream", () => {
  const built = buildCostTrendsInput({
    curLines: [
      line({ usageStartIso: "2026-01-01T00:00:00.000Z", amountUnits: 100, currency: "USD" }),
      line({ usageStartIso: "2026-01-01T00:00:00.000Z", amountUnits: 10, currency: "EUR" }),
    ],
  });
  const currencies = new Set(built.entries.map((e) => e.currency));
  assert.deepEqual([...currencies].sort(), ["EUR", "USD"]);
  const report = buildCostTrends(built);
  assert.deepEqual(report.series.map((s) => s.currency), ["EUR", "USD"]);
});

test("splits buckets by service so a per-service breakdown is possible", () => {
  const built = buildCostTrendsInput({
    curLines: [
      line({ usageStartIso: "2026-01-01T00:00:00.000Z", amountUnits: 60, service: "AmazonEC2" }),
      line({ usageStartIso: "2026-01-01T00:00:00.000Z", amountUnits: 40, service: "AmazonS3" }),
    ],
  });
  const services = built.entries.map((e) => e.service).sort();
  assert.deepEqual(services, ["AmazonEC2", "AmazonS3"]);
});

test("skips and discloses an unattributable/edge line instead of guessing", () => {
  const built = buildCostTrendsInput({
    curLines: [
      line({ usageStartIso: "2026-01-01T00:00:00.000Z", amountUnits: 100 }),
      // Edge line: usage-start has no parseable month.
      line({ usageStartIso: "", amountUnits: 999 }),
    ],
  });
  assert.equal(built.entries.length, 1);
  assert.equal(built.entries[0].amountMicros, units(100));
  assert.ok((built.skipped ?? []).length === 1);
  assert.match((built.skipped ?? [])[0].reason, /calendar month/);
});

test("empty input yields empty entries and no skips", () => {
  const built = buildCostTrendsInput({ curLines: [] });
  assert.deepEqual(built.entries, []);
  assert.deepEqual(built.skipped, []);
});
