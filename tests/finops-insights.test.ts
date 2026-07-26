import assert from "node:assert/strict";
import test from "node:test";
import {
  ANOMALY_DISCLAIMER,
  detectAnomalies,
} from "../lib/finops-insights.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function line(
  overrides: Partial<NormalizedCurLine> & { amountMicros: string },
): NormalizedCurLine {
  return {
    lineItemId: overrides.lineItemId ?? "li-1",
    usageAccountId: overrides.usageAccountId ?? "111111111111",
    service: overrides.service ?? "AmazonEC2",
    chargeCategory: overrides.chargeCategory ?? "Usage",
    usageStartIso: overrides.usageStartIso ?? "2026-06-01T00:00:00.000Z",
    amountMicros: overrides.amountMicros,
    currency: overrides.currency ?? "USD",
    region: overrides.region ?? "us-east-1",
    amortizedMicros: overrides.amortizedMicros ?? null,
    commitmentType: overrides.commitmentType ?? null,
    commitmentId: overrides.commitmentId ?? null,
    commitmentExpiry: overrides.commitmentExpiry ?? null,
    tags: overrides.tags ?? {},
  };
}

/** Build one line per day of June starting at `startDay`, all same service/currency. */
function daily(
  service: string,
  amountsByDay: readonly number[],
  startDay = 1,
  currency = "USD",
): NormalizedCurLine[] {
  return amountsByDay.map((amount, index) => {
    const day = String(startDay + index).padStart(2, "0");
    return line({
      lineItemId: `${currency}-${service}-${day}`,
      service,
      currency,
      usageStartIso: `2026-06-${day}T00:00:00.000Z`,
      amountMicros: units(amount),
    });
  });
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

test("FOCUS service names containing spaces keep their full name and a real ISO date", () => {
  const lines = [
    ...daily("Amazon Elastic Compute Cloud - Compute", [10, 10, 10, 90]),
    ...daily("Amazon Simple Storage Service", [2, 2, 2, 2]),
  ];
  const result = detectAnomalies(lines);
  assert.equal(result.disclaimer, ANOMALY_DISCLAIMER);
  assert.equal(result.anomalies.length, 1);
  const anomaly = result.anomalies[0]!;
  assert.equal(anomaly.service, "Amazon Elastic Compute Cloud - Compute");
  assert.equal(anomaly.currency, "USD");
  assert.match(anomaly.dateIso, ISO_DAY);
  assert.equal(anomaly.dateIso, "2026-06-04");
  assert.equal(anomaly.amountMicros, units(90));
  assert.equal(anomaly.baselineMicros, units(10));
  assert.equal(anomaly.ratio, 9);
  // Both services are evaluated as their own 4-day series; they never merge
  // into a single "USD Amazon" series (which would evaluate 4 days total).
  assert.equal(result.evaluatedDays, 8);
});

test("services sharing a first token keep separate trailing medians", () => {
  // If these merged, the storage volume (1000/day) would swamp the compute
  // baseline (10/day) and the 4x compute spike would be invisible.
  const lines = [
    ...daily("Amazon Elastic Compute Cloud - Compute", [10, 10, 10, 40]),
    ...daily("Amazon Simple Storage Service", [1000, 1000, 1000, 1000]),
  ];
  const result = detectAnomalies(lines);
  assert.deepEqual(
    result.anomalies.map((a) => ({ service: a.service, dateIso: a.dateIso, ratio: a.ratio })),
    [{ service: "Amazon Elastic Compute Cloud - Compute", dateIso: "2026-06-04", ratio: 4 }],
  );
  assert.equal(result.anomalies[0]!.baselineMicros, units(10));
  assert.equal(result.evaluatedDays, 8);
});

test("a day belonging to a space-containing service is never parsed out of the name", () => {
  // The old delimiter round-trip produced dateIso values like "Elastic".
  const lines = daily("Amazon Elastic Compute Cloud - Compute", [10, 10, 10, 10, 10, 10, 10, 200]);
  const result = detectAnomalies(lines);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0]!.dateIso, "2026-06-08");
  assert.equal(result.anomalies[0]!.service, "Amazon Elastic Compute Cloud - Compute");
  assert.equal(result.evaluatedDays, 8);
});

test("regression: space-free CUR 2.0 service names detect the same anomalies", () => {
  const lines = [
    ...daily("AmazonEC2", [10, 10, 10, 100]),
    ...daily("AmazonS3", [5, 5, 5, 5]),
  ];
  const result = detectAnomalies(lines);
  assert.deepEqual(result.anomalies, [
    {
      dateIso: "2026-06-04",
      service: "AmazonEC2",
      currency: "USD",
      amountMicros: units(100),
      baselineMicros: units(10),
      ratio: 10,
    },
  ]);
  assert.equal(result.evaluatedDays, 8);
  assert.equal(result.disclaimer, ANOMALY_DISCLAIMER);
});

test("multiple lines on the same day for the same service are summed", () => {
  const lines = [
    ...daily("AmazonEC2", [10, 10, 10]),
    line({ lineItemId: "d4-a", service: "AmazonEC2", usageStartIso: "2026-06-04T01:00:00.000Z", amountMicros: units(30) }),
    line({ lineItemId: "d4-b", service: "AmazonEC2", usageStartIso: "2026-06-04T13:00:00.000Z", amountMicros: units(30) }),
  ];
  const result = detectAnomalies(lines);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0]!.amountMicros, units(60));
  assert.equal(result.anomalies[0]!.ratio, 6);
  assert.equal(result.evaluatedDays, 4);
});

test("currencies never share a series", () => {
  const lines = [
    ...daily("AmazonEC2", [10, 10, 10, 40], 1, "USD"),
    ...daily("AmazonEC2", [1000, 1000, 1000, 1000], 1, "EUR"),
  ];
  const result = detectAnomalies(lines);
  assert.equal(result.anomalies.length, 1);
  assert.equal(result.anomalies[0]!.currency, "USD");
  assert.equal(result.anomalies[0]!.baselineMicros, units(10));
  assert.equal(result.anomalies[0]!.ratio, 4);
  assert.equal(result.evaluatedDays, 8);
});

test("currency separation also holds for space-containing service names", () => {
  const service = "Amazon Elastic Compute Cloud - Compute";
  const lines = [
    ...daily(service, [10, 10, 10, 40], 1, "USD"),
    ...daily(service, [1000, 1000, 1000, 1000], 1, "EUR"),
  ];
  const result = detectAnomalies(lines);
  assert.deepEqual(
    result.anomalies.map((a) => ({ currency: a.currency, service: a.service, dateIso: a.dateIso })),
    [{ currency: "USD", service, dateIso: "2026-06-04" }],
  );
});

test("fewer than 3 trailing days is never anomalous, and the window is the previous 7", () => {
  const short = detectAnomalies(daily("Amazon Elastic Compute Cloud - Compute", [1, 1, 100]));
  assert.equal(short.anomalies.length, 0);
  assert.equal(short.evaluatedDays, 3);

  // Day 9 has 8 prior days; only the previous 7 (days 2-8) form the window, so
  // the outlier on day 1 is out of scope and the median stays 10.
  const windowed = detectAnomalies(
    daily("Amazon Elastic Compute Cloud - Compute", [900, 10, 10, 10, 10, 10, 10, 10, 60]),
  );
  const dayNine = windowed.anomalies.filter((a) => a.dateIso === "2026-06-09");
  assert.equal(dayNine.length, 1);
  assert.equal(dayNine[0]!.baselineMicros, units(10));
  assert.equal(dayNine[0]!.ratio, 6);
});

test("anomalies sort by date descending then ratio descending", () => {
  const lines = [
    ...daily("Amazon Elastic Compute Cloud - Compute", [10, 10, 10, 100, 40]),
    ...daily("Amazon Simple Storage Service", [10, 10, 10, 200, 10]),
  ];
  const result = detectAnomalies(lines);
  const dates = result.anomalies.map((a) => a.dateIso);
  assert.deepEqual([...dates].sort((a, b) => b.localeCompare(a)), dates);
  const dayFour = result.anomalies.filter((a) => a.dateIso === "2026-06-04");
  assert.equal(dayFour.length, 2);
  assert.ok(dayFour[0]!.ratio >= dayFour[1]!.ratio);
  assert.equal(dayFour[0]!.service, "Amazon Simple Storage Service");
});

test("spends below the minimum micros floor are not flagged", () => {
  const lines = daily("Amazon Elastic Compute Cloud - Compute", [0, 0, 0, 0]).map((l, i) =>
    line({ ...l, amountMicros: i === 3 ? "900000" : "1000" }),
  );
  const result = detectAnomalies(lines);
  assert.equal(result.anomalies.length, 0);
  assert.equal(result.evaluatedDays, 4);
});

test("no lines yields an empty, disclosed result", () => {
  const result = detectAnomalies([]);
  assert.deepEqual(result.anomalies, []);
  assert.equal(result.evaluatedDays, 0);
  assert.equal(result.disclaimer, ANOMALY_DISCLAIMER);
});
