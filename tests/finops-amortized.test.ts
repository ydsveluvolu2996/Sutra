import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NormalizedCurLine } from "../lib/finops-cur.ts";
import { buildAmortizedView } from "../lib/finops-amortized.ts";

function line(over: Partial<NormalizedCurLine> & { amountMicros: string }): NormalizedCurLine {
  return {
    lineItemId: over.lineItemId ?? "li",
    usageAccountId: over.usageAccountId ?? "111111111111",
    service: over.service ?? "AmazonEC2",
    chargeCategory: over.chargeCategory ?? "Usage",
    usageStartIso: over.usageStartIso ?? "2026-07-01T00:00:00.000Z",
    amountMicros: over.amountMicros,
    currency: over.currency ?? "USD",
    region: over.region ?? null,
    amortizedMicros: over.amortizedMicros ?? null,
    commitmentType: over.commitmentType ?? null,
    commitmentId: over.commitmentId ?? null,
    commitmentExpiry: over.commitmentExpiry ?? null,
    tags: over.tags ?? {},
  };
}

describe("buildAmortizedView", () => {
  it("reports the billed vs amortized delta and a by-service breakdown", () => {
    const view = buildAmortizedView([
      // An upfront Savings Plan fee: $120 billed this month, $10 amortized.
      line({ service: "AWSSavingsPlan", amountMicros: "120000000", amortizedMicros: "10000000" }),
      // Covered usage: $0 billed (paid via the fee), $30 amortized/effective.
      line({ service: "AmazonEC2", amountMicros: "0", amortizedMicros: "30000000" }),
      // Plain on-demand: no amortized figure, effective == billed ($40).
      line({ service: "AmazonS3", amountMicros: "40000000" }),
    ]);

    assert.equal(view.available, true);
    assert.equal(view.currency, "USD");
    // Billed = 120 + 0 + 40 = 160; amortized = 10 + 30 + 40(fallback) = 80.
    assert.equal(view.billedMicros, "160000000");
    assert.equal(view.amortizedMicros, "80000000");
    assert.equal(view.billedUnits, 160);
    assert.equal(view.amortizedUnits, 80);
    // Delta = amortized - billed = -80 (amortizing removes the upfront spike).
    assert.equal(view.deltaMicros, "-80000000");
    assert.equal(view.deltaUnits, -80);
    assert.equal(view.lineCount, 3);
    assert.equal(view.amortizedLineCount, 2);

    // By service, sorted by billed spend descending.
    assert.deepEqual(view.byService.map((entry) => entry.service), ["AWSSavingsPlan", "AmazonS3", "AmazonEC2"]);
    const savingsPlan = view.byService[0];
    assert.equal(savingsPlan.billedMicros, "120000000");
    assert.equal(savingsPlan.amortizedMicros, "10000000");
    assert.equal(savingsPlan.deltaMicros, "-110000000");
    // On-demand S3: effective falls back to billed, delta 0.
    const s3 = view.byService[1];
    assert.equal(s3.amortizedMicros, "40000000");
    assert.equal(s3.deltaMicros, "0");
  });

  it("is available=false when no line carries an amortized figure (effective == billed)", () => {
    const view = buildAmortizedView([
      line({ service: "AmazonEC2", amountMicros: "50000000" }),
      line({ service: "AmazonS3", amountMicros: "25000000" }),
    ]);
    assert.equal(view.available, false);
    assert.equal(view.amortizedLineCount, 0);
    // With no amortized data the effective total merely equals billed.
    assert.equal(view.billedMicros, "75000000");
    assert.equal(view.amortizedMicros, "75000000");
    assert.equal(view.deltaMicros, "0");
  });

  it("reports unavailable with empty totals when there are no lines", () => {
    const view = buildAmortizedView([]);
    assert.equal(view.available, false);
    assert.equal(view.currency, null);
    assert.deepEqual([...view.currenciesPresent], []);
    assert.equal(view.billedMicros, "0");
    assert.equal(view.amortizedMicros, "0");
    assert.deepEqual([...view.byService], []);
  });

  it("analyses only the dominant currency and discloses the others", () => {
    const view = buildAmortizedView([
      line({ currency: "USD", amountMicros: "100000000", amortizedMicros: "60000000" }),
      line({ currency: "EUR", amountMicros: "10000000", amortizedMicros: "5000000" }),
    ]);
    assert.equal(view.currency, "USD");
    assert.deepEqual([...view.currenciesPresent], ["EUR", "USD"]);
    // Only USD lines are summed; EUR is excluded, never mixed.
    assert.equal(view.billedMicros, "100000000");
    assert.equal(view.amortizedMicros, "60000000");
  });
});
