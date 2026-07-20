import assert from "node:assert/strict";
import test from "node:test";
import {
  buildShowback,
  type AttributedCurLine,
  type ShowbackInput,
} from "../lib/finops-showback.ts";

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

function input(lines: readonly AttributedCurLine[]): ShowbackInput {
  return { lines };
}

test("attributes spend to customers per the account-map basis", () => {
  const report = buildShowback(
    input([
      line({ customerId: "cust-a", basis: "account-map", amountUnits: 100 }),
      line({ customerId: "cust-a", basis: "account-map", amountUnits: 50 }),
      line({ customerId: "cust-b", basis: "account-map", amountUnits: 30 }),
    ]),
  );
  assert.equal(report.schema, "sutra.finops-showback.v1");
  const [usd] = report.results;
  assert.equal(usd.currency, "USD");
  // Descending direct spend: cust-a (150) then cust-b (30).
  assert.deepEqual(usd.customers.map((c) => c.customerId), ["cust-a", "cust-b"]);
  assert.equal(usd.customers[0].directMicros, units(150));
  assert.equal(usd.customers[0].lineCount, 2);
  assert.deepEqual(usd.customers[0].attributionBases, ["account-map"]);
  assert.equal(usd.unattributedMicros, "0");
  assert.equal(usd.totalMicros, units(180));
});

test("attributes spend via the tag basis and discloses it per bucket", () => {
  const report = buildShowback(
    input([
      line({ customerId: "acme", basis: "tag", amountUnits: 40 }),
      line({ customerId: "acme", basis: "account-map", amountUnits: 10 }),
    ]),
  );
  const [usd] = report.results;
  // A bucket fed by both bases discloses both, sorted & deduplicated.
  assert.deepEqual(usd.customers[0].attributionBases, ["account-map", "tag"]);
  assert.equal(usd.customers[0].directMicros, units(50));
});

test("spend matching no customer is disclosed as unattributed, never force-assigned", () => {
  const report = buildShowback(
    input([
      line({ customerId: "cust-a", basis: "account-map", amountUnits: 100 }),
      line({ customerId: null, basis: null, amountUnits: 25 }),
      line({ customerId: null, basis: null, amountUnits: 5 }),
    ]),
  );
  const [usd] = report.results;
  assert.equal(usd.customers.length, 1);
  assert.equal(usd.customers[0].directMicros, units(100));
  assert.equal(usd.unattributedMicros, units(30));
  assert.equal(usd.unattributedLineCount, 2);
  assert.equal(usd.totalMicros, units(130));
});

test("chargeback off by default: every chargeback field is null (no hidden markup)", () => {
  const report = buildShowback(
    input([
      line({ customerId: "cust-a", basis: "account-map", amountUnits: 100 }),
      line({ customerId: null, basis: null, amountUnits: 20 }),
    ]),
  );
  assert.equal(report.chargebackEnabled, false);
  const [usd] = report.results;
  assert.equal(usd.customers[0].distributedSharedMicros, null);
  assert.equal(usd.customers[0].upliftMicros, null);
  assert.equal(usd.customers[0].chargebackTotalMicros, null);
  assert.equal(usd.chargeback.enabled, false);
  assert.equal(usd.chargeback.distributionBasis, null);
  assert.equal(usd.chargeback.upliftPercent, 0);
});

test("chargeback distributes shared spend by direct-spend share when enabled and discloses it", () => {
  const report = buildShowback(
    input([
      line({ customerId: "cust-a", basis: "account-map", amountUnits: 75 }),
      line({ customerId: "cust-b", basis: "account-map", amountUnits: 25 }),
      line({ customerId: null, basis: null, amountUnits: 40 }),
    ]),
    { chargeback: { distributeShared: true } },
  );
  assert.equal(report.chargebackEnabled, true);
  const [usd] = report.results;
  // direct total 100; unattributed 40 spread 75/25 -> 30 / 10.
  const a = usd.customers.find((c) => c.customerId === "cust-a");
  const b = usd.customers.find((c) => c.customerId === "cust-b");
  assert.equal(a?.distributedSharedMicros, units(30));
  assert.equal(b?.distributedSharedMicros, units(10));
  assert.equal(a?.chargebackTotalMicros, units(105));
  assert.equal(b?.chargebackTotalMicros, units(35));
  // Fully distributed: no remainder, unattributed still disclosed intact.
  assert.equal(usd.chargeback.distributeShared, true);
  assert.equal(usd.chargeback.distributionBasis, "by-direct-spend-share");
  assert.equal(usd.chargeback.distributedUnattributedMicros, units(40));
  assert.equal(usd.chargeback.undistributedRemainderMicros, "0");
  assert.equal(usd.unattributedMicros, units(40));
});

test("distribution remainder that does not divide evenly is disclosed, not sprinkled", () => {
  const report = buildShowback(
    input([
      line({ customerId: "cust-a", basis: "account-map", amountUnits: 1 }),
      line({ customerId: "cust-b", basis: "account-map", amountUnits: 1 }),
      line({ customerId: "cust-c", basis: "account-map", amountUnits: 1 }),
      // 1 micro of unattributed cannot split three ways.
      line({ customerId: null, basis: null, amountMicros: "1", amountUnits: 0 }),
    ]),
    { chargeback: { distributeShared: true } },
  );
  const [usd] = report.results;
  const distributed = usd.customers.reduce(
    (sum, c) => sum + BigInt(c.distributedSharedMicros ?? "0"),
    BigInt(0),
  );
  assert.equal(distributed.toString(), usd.chargeback.distributedUnattributedMicros);
  assert.equal(usd.chargeback.undistributedRemainderMicros, "1");
  assert.equal(distributed.toString(), "0");
});

test("chargeback with distribution disabled but no direct spend discloses a reason", () => {
  const report = buildShowback(
    input([line({ customerId: null, basis: null, amountUnits: 50 })]),
    { chargeback: { distributeShared: true } },
  );
  const [usd] = report.results;
  assert.equal(usd.chargeback.note, "NO_DIRECT_SPEND_BASIS_FOR_DISTRIBUTION");
  assert.equal(usd.chargeback.distributedUnattributedMicros, "0");
  assert.equal(usd.chargeback.undistributedRemainderMicros, units(50));
});

test("uplift applies a disclosed markup only when enabled", () => {
  const report = buildShowback(
    input([line({ customerId: "cust-a", basis: "account-map", amountUnits: 200 })]),
    { chargeback: { upliftPercent: 10 } },
  );
  assert.equal(report.chargebackEnabled, true);
  const [usd] = report.results;
  assert.equal(usd.chargeback.upliftPercent, 10);
  // 10% of 200 = 20; distribution off so distributedShared is null.
  assert.equal(usd.customers[0].distributedSharedMicros, null);
  assert.equal(usd.customers[0].upliftMicros, units(20));
  assert.equal(usd.customers[0].chargebackTotalMicros, units(220));
});

test("uplift applies on top of distributed shared spend (chargeable base)", () => {
  const report = buildShowback(
    input([
      line({ customerId: "cust-a", basis: "account-map", amountUnits: 100 }),
      line({ customerId: null, basis: null, amountUnits: 20 }),
    ]),
    { chargeback: { distributeShared: true, upliftPercent: 10 } },
  );
  const [usd] = report.results;
  // base = 100 direct + 20 distributed = 120; uplift 10% = 12; total 132.
  assert.equal(usd.customers[0].distributedSharedMicros, units(20));
  assert.equal(usd.customers[0].upliftMicros, units(12));
  assert.equal(usd.customers[0].chargebackTotalMicros, units(132));
});

test("currencies are isolated and never summed together", () => {
  const report = buildShowback(
    input([
      line({ customerId: "cust-a", basis: "account-map", amountUnits: 100, currency: "USD" }),
      line({ customerId: "cust-a", basis: "account-map", amountUnits: 10, currency: "EUR" }),
    ]),
  );
  assert.deepEqual(report.results.map((r) => r.currency), ["EUR", "USD"]);
  const eur = report.results[0];
  const usd = report.results[1];
  assert.equal(eur.customers[0].directMicros, units(10));
  assert.equal(usd.customers[0].directMicros, units(100));
});

test("empty input yields an honest empty result, not a fabricated bucket", () => {
  const report = buildShowback(input([]));
  assert.deepEqual(report.results, []);
  assert.equal(report.schema, "sutra.finops-showback.v1");
  assert.ok(report.limitations.length > 0);
  assert.ok(report.disclaimer.length > 0);
});

test("is deterministic across identical calls", () => {
  const built = input([
    line({ customerId: "cust-b", basis: "tag", amountUnits: 30 }),
    line({ customerId: "cust-a", basis: "account-map", amountUnits: 30 }),
    line({ customerId: null, basis: null, amountUnits: 5 }),
  ]);
  const first = buildShowback(built, { chargeback: { distributeShared: true, upliftPercent: 5 } });
  const second = buildShowback(built, { chargeback: { distributeShared: true, upliftPercent: 5 } });
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});
