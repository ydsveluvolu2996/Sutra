import assert from "node:assert/strict";
import test from "node:test";
import {
  buildUnitEconomics,
  type UnitEconomicsInput,
} from "../lib/finops-unit-economics.ts";
import type { AttributedCurLine } from "../lib/finops-showback.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function line(over: Partial<AttributedCurLine> & { amountUnits: number }): AttributedCurLine {
  return {
    customerId: over.customerId ?? null,
    basis: over.basis ?? null,
    currency: over.currency ?? "USD",
    amountMicros: over.amountMicros ?? units(over.amountUnits),
    usageAccountId: over.usageAccountId ?? "111122223333",
    service: over.service ?? "AmazonEC2",
  };
}

test("computes cost per unit per customer when a count is provided", () => {
  const input: UnitEconomicsInput = {
    lines: [line({ customerId: "cust-a", basis: "account-map", amountUnits: 100 })],
    customerUnits: [{ customerId: "cust-a", currency: "USD", count: 4 }],
    unitLabel: "transaction",
  };
  const report = buildUnitEconomics(input);
  assert.equal(report.schema, "sutra.finops-unit-economics.v1");
  assert.equal(report.unitLabel, "transaction");
  const [usd] = report.results;
  const cpu = usd.customers[0].costPerUnit;
  assert.equal(cpu.ratioBasis, "unit-count-provided");
  assert.equal(cpu.amountMicros, units(100));
  assert.equal(cpu.count, 4);
  // 100_000_000 micros / 4 = 25_000_000 micros per transaction.
  assert.equal(cpu.microsPerUnit, 25_000_000);
});

test("cost per unit is null with a reason when the count is not provided", () => {
  const report = buildUnitEconomics({
    lines: [line({ customerId: "cust-a", basis: "account-map", amountUnits: 100 })],
  });
  const cpu = report.results[0].customers[0].costPerUnit;
  assert.equal(cpu.microsPerUnit, null);
  assert.equal(cpu.count, null);
  assert.equal(cpu.ratioBasis, "unit-count-not-provided");
  // Raw spend is still emitted so the UI can format honestly.
  assert.equal(cpu.amountMicros, units(100));
});

test("cost per unit is null with a reason on a zero count (never divide-by-zero)", () => {
  const report = buildUnitEconomics({
    lines: [line({ customerId: "cust-a", basis: "account-map", amountUnits: 100 })],
    customerUnits: [{ customerId: "cust-a", currency: "USD", count: 0 }],
  });
  const cpu = report.results[0].customers[0].costPerUnit;
  assert.equal(cpu.microsPerUnit, null);
  assert.equal(cpu.count, 0);
  assert.equal(cpu.ratioBasis, "unit-count-zero");
});

test("a negative or non-finite count is treated as an unusable denominator", () => {
  const report = buildUnitEconomics({
    lines: [line({ customerId: "cust-a", basis: "account-map", amountUnits: 100 })],
    customerUnits: [{ customerId: "cust-a", currency: "USD", count: -5 }],
  });
  const cpu = report.results[0].customers[0].costPerUnit;
  assert.equal(cpu.microsPerUnit, null);
  assert.equal(cpu.ratioBasis, "unit-count-zero");
});

test("supports a global unit denominator over total currency spend", () => {
  const report = buildUnitEconomics({
    lines: [
      line({ customerId: "cust-a", basis: "account-map", amountUnits: 60 }),
      line({ customerId: "cust-b", basis: "account-map", amountUnits: 30 }),
      line({ customerId: null, basis: null, amountUnits: 10 }),
    ],
    globalUnits: [{ currency: "USD", count: 100 }],
  });
  const [usd] = report.results;
  // Global divides TOTAL currency spend (100 units) by 100 -> 1_000_000 micros/unit.
  assert.equal(usd.global.amountMicros, units(100));
  assert.equal(usd.global.microsPerUnit, 1_000_000);
  assert.equal(usd.unattributedMicros, units(10));
  // Per-customer counts absent -> null with reason, independent of the global.
  assert.equal(usd.customers[0].costPerUnit.ratioBasis, "unit-count-not-provided");
});

test("currencies are isolated and never summed together", () => {
  const report = buildUnitEconomics({
    lines: [
      line({ customerId: "cust-a", basis: "account-map", amountUnits: 100, currency: "USD" }),
      line({ customerId: "cust-a", basis: "account-map", amountUnits: 20, currency: "EUR" }),
    ],
    customerUnits: [
      { customerId: "cust-a", currency: "USD", count: 10 },
      { customerId: "cust-a", currency: "EUR", count: 4 },
    ],
  });
  assert.deepEqual(report.results.map((r) => r.currency), ["EUR", "USD"]);
  const eur = report.results[0];
  const usd = report.results[1];
  assert.equal(eur.customers[0].costPerUnit.microsPerUnit, 5_000_000); // 20/4
  assert.equal(usd.customers[0].costPerUnit.microsPerUnit, 10_000_000); // 100/10
});

test("rounds the display ratio to the configured decimals while keeping raw values", () => {
  const report = buildUnitEconomics(
    {
      lines: [line({ customerId: "cust-a", basis: "account-map", amountMicros: "10", amountUnits: 0 })],
      customerUnits: [{ customerId: "cust-a", currency: "USD", count: 3 }],
    },
    { ratioDecimals: 2 },
  );
  const cpu = report.results[0].customers[0].costPerUnit;
  // 10 / 3 = 3.333... -> rounded to 2 decimals.
  assert.equal(cpu.microsPerUnit, 3.33);
  assert.equal(cpu.amountMicros, "10");
  assert.equal(cpu.count, 3);
});

test("empty input yields an honest empty result", () => {
  const report = buildUnitEconomics({ lines: [] });
  assert.deepEqual(report.results, []);
  assert.equal(report.unitLabel, null);
  assert.ok(report.limitations.length > 0);
  assert.ok(report.disclaimer.length > 0);
});

test("is deterministic across identical calls", () => {
  const input: UnitEconomicsInput = {
    lines: [
      line({ customerId: "cust-b", basis: "tag", amountUnits: 40 }),
      line({ customerId: "cust-a", basis: "account-map", amountUnits: 40 }),
    ],
    customerUnits: [{ customerId: "cust-a", currency: "USD", count: 8 }],
    globalUnits: [{ currency: "USD", count: 16 }],
  };
  const first = buildUnitEconomics(input);
  const second = buildUnitEconomics(input);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
