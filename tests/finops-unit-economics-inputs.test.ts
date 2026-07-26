import assert from "node:assert/strict";
import test from "node:test";
import { buildUnitEconomicsInput } from "../lib/finops-unit-economics-inputs.ts";
import { buildUnitEconomics } from "../lib/finops-unit-economics.ts";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";

const units = (whole: number): string => String(whole * 1_000_000);

function line(over: Partial<NormalizedCurLine> & { amountUnits: number }): NormalizedCurLine {
  return {
    lineItemId: over.lineItemId ?? `li-${over.amountUnits}`,
    usageAccountId: over.usageAccountId ?? "111122223333",
    service: over.service ?? "AmazonEC2",
    chargeCategory: over.chargeCategory ?? "Usage",
    usageStartIso: over.usageStartIso ?? "2026-01-01T00:00:00.000Z",
    amountMicros: over.amountMicros ?? units(over.amountUnits),
    currency: over.currency ?? "USD",
    region: over.region ?? null,
    amortizedMicros: over.amortizedMicros ?? null,
    commitmentType: over.commitmentType ?? null,
    commitmentId: over.commitmentId ?? null,
    commitmentExpiry: over.commitmentExpiry ?? null,
    tags: over.tags ?? {},
  };
}

test("reuses showback attribution (account map) and passes unit counts through", () => {
  const built = buildUnitEconomicsInput({
    curLines: [line({ usageAccountId: "111122223333", amountUnits: 100 })],
    accountToCustomer: { "111122223333": "cust-a" },
    customerUnits: [{ customerId: "cust-a", currency: "USD", count: 5 }],
    globalUnits: [{ currency: "USD", count: 10 }],
    unitLabel: "seat",
  });
  assert.equal(built.lines[0].customerId, "cust-a");
  assert.equal(built.lines[0].basis, "account-map");
  assert.deepEqual(built.customerUnits, [{ customerId: "cust-a", currency: "USD", count: 5 }]);
  assert.deepEqual(built.globalUnits, [{ currency: "USD", count: 10 }]);
  assert.equal(built.unitLabel, "seat");
});

test("composes end-to-end into the unit-economics engine", () => {
  const built = buildUnitEconomicsInput({
    curLines: [
      line({ usageAccountId: "111122223333", amountUnits: 100, tags: {} }),
      line({ usageAccountId: "unknown", amountUnits: 20 }),
    ],
    accountToCustomer: { "111122223333": "cust-a" },
    customerUnits: [{ customerId: "cust-a", currency: "USD", count: 4 }],
  });
  const report = buildUnitEconomics(built);
  const [usd] = report.results;
  assert.equal(usd.customers[0].customerId, "cust-a");
  assert.equal(usd.customers[0].costPerUnit.microsPerUnit, 25_000_000); // 100/4
  assert.equal(usd.unattributedMicros, units(20));
});

test("defaults unit counts to empty arrays when omitted", () => {
  const built = buildUnitEconomicsInput({ curLines: [line({ amountUnits: 10 })] });
  assert.deepEqual(built.customerUnits, []);
  assert.deepEqual(built.globalUnits, []);
});

test("empty input yields empty lines and no skips", () => {
  const built = buildUnitEconomicsInput({ curLines: [] });
  assert.deepEqual(built.lines, []);
  assert.deepEqual(built.skipped, []);
});
