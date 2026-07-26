import assert from "node:assert/strict";
import test from "node:test";
import { buildShowbackInput } from "../lib/finops-showback-inputs.ts";
import { buildShowback } from "../lib/finops-showback.ts";
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
    tags: over.tags ?? {},
  };
}

test("attributes by the account-id map basis", () => {
  const built = buildShowbackInput({
    curLines: [
      line({ usageAccountId: "111122223333", amountUnits: 100 }),
      line({ usageAccountId: "444455556666", amountUnits: 40 }),
    ],
    accountToCustomer: { "111122223333": "cust-a", "444455556666": "cust-b" },
  });
  assert.deepEqual(
    built.lines.map((l) => [l.customerId, l.basis]),
    [
      ["cust-a", "account-map"],
      ["cust-b", "account-map"],
    ],
  );
});

test("attributes by the cost-allocation tag basis", () => {
  const built = buildShowbackInput({
    curLines: [line({ amountUnits: 100, tags: { Customer: "acme" } })],
    customerTagKey: "Customer",
  });
  assert.equal(built.lines[0].customerId, "acme");
  assert.equal(built.lines[0].basis, "tag");
});

test("account map wins over a tag when both match (precedence disclosed)", () => {
  const built = buildShowbackInput({
    curLines: [line({ usageAccountId: "111122223333", amountUnits: 100, tags: { Customer: "tagged-cust" } })],
    accountToCustomer: { "111122223333": "mapped-cust" },
    customerTagKey: "Customer",
  });
  assert.equal(built.lines[0].customerId, "mapped-cust");
  assert.equal(built.lines[0].basis, "account-map");
});

test("a line matching neither basis is unattributed, never guessed", () => {
  const built = buildShowbackInput({
    curLines: [line({ usageAccountId: "999900001111", amountUnits: 100 })],
    accountToCustomer: { "111122223333": "cust-a" },
    customerTagKey: "Customer",
  });
  assert.equal(built.lines[0].customerId, null);
  assert.equal(built.lines[0].basis, null);
});

test("drops and discloses a line with an unusable currency", () => {
  const built = buildShowbackInput({
    curLines: [
      line({ amountUnits: 100 }),
      line({ amountUnits: 50, currency: "us$" }),
    ],
  });
  assert.equal(built.lines.length, 1);
  assert.equal((built.skipped ?? []).length, 1);
  assert.match((built.skipped ?? [])[0].reason, /currency/);
});

test("composes end-to-end into the showback engine", () => {
  const built = buildShowbackInput({
    curLines: [
      line({ usageAccountId: "111122223333", amountUnits: 100 }),
      line({ usageAccountId: "444455556666", amountUnits: 40 }),
      line({ usageAccountId: "unknown", amountUnits: 10 }),
    ],
    accountToCustomer: { "111122223333": "cust-a", "444455556666": "cust-b" },
  });
  const report = buildShowback(built);
  const [usd] = report.results;
  assert.deepEqual(usd.customers.map((c) => c.customerId), ["cust-a", "cust-b"]);
  assert.equal(usd.unattributedMicros, units(10));
});

test("empty input yields empty lines and no skips", () => {
  const built = buildShowbackInput({ curLines: [] });
  assert.deepEqual(built.lines, []);
  assert.deepEqual(built.skipped, []);
});
