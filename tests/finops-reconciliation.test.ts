import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CanonicalCurLine } from "../lib/finops-cur.ts";
import { parseCurCsv } from "../lib/finops-cur.ts";
import {
  reconcileCanonicalBillingGeneration,
  type FinopsExpectedCurrencyEvidence,
  type FinopsReconciliationEvidence,
  type FinopsReconciliationInput,
  type FinopsReconciliationScope,
  type ScopedCanonicalBillingRow,
} from "../lib/finops-reconciliation.ts";

const SCOPE: FinopsReconciliationScope = {
  organizationId: "org_reconcile",
  customerId: "customer_reconcile",
  connectionId: "conn_reconcile",
  exportName: "aws-cur",
  billingPeriod: "2026-07",
  generationId: `fbg_${"a".repeat(64)}`,
};
const MANIFEST_SHA256 = "a".repeat(64);

function canonicalLines(
  rows: readonly string[],
): readonly CanonicalCurLine[] {
  const parsed = parseCurCsv([
    "line_item_id,line_item_usage_account_id,product_servicecode,line_item_line_item_type,line_item_usage_start_date,line_item_unblended_cost,line_item_currency_code",
    ...rows,
  ].join("\n"));
  if ("error" in parsed) throw new Error(parsed.error);
  assert.equal(parsed.rejected.length, 0);
  return parsed.lines;
}

function scopedRows(
  lines: readonly CanonicalCurLine[],
): readonly ScopedCanonicalBillingRow[] {
  return lines.map((line) => ({ ...SCOPE, line }));
}

function evidence(
  currencies: readonly FinopsExpectedCurrencyEvidence[],
  overrides: Partial<FinopsReconciliationEvidence> = {},
): FinopsReconciliationEvidence {
  return {
    scope: SCOPE,
    sourceEvidenceId: "s3://sutra-billing/aws-cur/2026-07/manifest.json#version-1",
    manifestSha256: MANIFEST_SHA256,
    rowCount: currencies.reduce((sum, entry) => sum + entry.rowCount, 0),
    currencies,
    ...overrides,
  };
}

function input(
  rows: readonly ScopedCanonicalBillingRow[],
  sourceEvidence: FinopsReconciliationEvidence | null,
  overrides: Partial<FinopsReconciliationInput> = {},
): FinopsReconciliationInput {
  return { scope: SCOPE, rows, evidence: sourceEvidence, ...overrides };
}

describe("canonical billing reconciliation", () => {
  it("authorizes atomic activation only after exact per-currency and category reconciliation", () => {
    const lines = canonicalLines([
      "usd-usage,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,10.25,USD",
      "usd-tax,111122223333,AmazonTax,Tax,2026-07-01T01:00:00Z,0.75,USD",
      "usd-credit,111122223333,AWS,Credit,2026-07-01T02:00:00Z,-1.00,USD",
      "usd-fee,111122223333,AmazonEC2,Fee,2026-07-01T03:00:00Z,2.00,USD",
      "eur-refund,111122223333,AWS,Refund,2026-07-01T04:00:00Z,-3.00,EUR",
    ]);
    const result = reconcileCanonicalBillingGeneration(input(
      scopedRows(lines),
      evidence([
        {
          currency: "EUR",
          rowCount: 1,
          totalMicros: "-3000000",
          categoryTotalsMicros: { refund: "-3000000" },
          categoryRowCounts: { refund: 1 },
        },
        {
          currency: "USD",
          rowCount: 4,
          totalMicros: "12000000",
          categoryTotalsMicros: {
            usage: "10250000",
            tax: "750000",
            credit: "-1000000",
            fee: "2000000",
          },
          categoryRowCounts: { usage: 1, tax: 1, credit: 1, fee: 1 },
        },
      ]),
    ));

    assert.equal(result.ok, true);
    assert.equal(result.activation, "activate_staged_generation");
    assert.equal(result.toleranceMicros, "0");
    assert.equal(result.actual.rowCount, 5);
    assert.deepEqual(
      result.actual.currencies.map(({ currency, rowCount, totalMicros }) => ({
        currency,
        rowCount,
        totalMicros,
      })),
      [
        { currency: "EUR", rowCount: 1, totalMicros: "-3000000" },
        { currency: "USD", rowCount: 4, totalMicros: "12000000" },
      ],
    );
  });

  it("uses BigInt beyond Number and signed bigint ranges without combining currencies", () => {
    const [first, second, euro] = canonicalLines([
      "huge-1,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1,USD",
      "huge-2,111122223333,AmazonEC2,Usage,2026-07-01T01:00:00Z,1,USD",
      "negative,111122223333,AWS,Credit,2026-07-01T02:00:00Z,-1,EUR",
    ]);
    const each = "90000000000000000000000000000000000000";
    const negative = "-90000000000000000000000000000000000000";
    const rows = scopedRows([
      { ...first, amountMicros: each },
      { ...second, amountMicros: each },
      { ...euro, amountMicros: negative },
    ]);
    const result = reconcileCanonicalBillingGeneration(input(rows, evidence([
      {
        currency: "EUR",
        rowCount: 1,
        totalMicros: negative,
        categoryTotalsMicros: { credit: negative },
      },
      {
        currency: "USD",
        rowCount: 2,
        totalMicros: "180000000000000000000000000000000000000",
        categoryTotalsMicros: {
          usage: "180000000000000000000000000000000000000",
        },
      },
    ])));
    assert.equal(result.ok, true);
    assert.equal(
      result.actual.currencies.find(({ currency }) => currency === "USD")?.totalMicros,
      "180000000000000000000000000000000000000",
    );
  });

  it("defaults to exact totals and accepts only an explicit integer-micro tolerance", () => {
    const rows = scopedRows(canonicalLines([
      "line-1,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1,USD",
    ]));
    const source = evidence([{
      currency: "USD",
      rowCount: 1,
      totalMicros: "1000001",
      categoryTotalsMicros: { usage: "1000001" },
    }]);

    const exact = reconcileCanonicalBillingGeneration(input(rows, source));
    assert.equal(exact.ok, false);
    assert.deepEqual(exact.failures.map(({ code }) => code), [
      "CURRENCY_TOTAL_MISMATCH",
      "CATEGORY_TOTAL_MISMATCH",
    ]);
    assert.equal(exact.failures[0]?.absoluteDeltaMicros, "1");

    const tolerated = reconcileCanonicalBillingGeneration(input(
      rows,
      source,
      { toleranceMicros: "1" },
    ));
    assert.equal(tolerated.ok, true);

    for (const invalid of ["-1", "0.5", "01", "1e3"]) {
      const rejected = reconcileCanonicalBillingGeneration(input(
        rows,
        source,
        { toleranceMicros: invalid },
      ));
      assert.equal(rejected.ok, false);
      assert.equal(rejected.failures[0]?.code, "INVALID_TOLERANCE_MICROS");
    }
  });

  it("reports stable count, total, and optional category mismatch reasons", () => {
    const rows = scopedRows(canonicalLines([
      "line-1,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,2,USD",
    ]));
    const result = reconcileCanonicalBillingGeneration(input(rows, evidence(
      [{
        currency: "USD",
        rowCount: 2,
        totalMicros: "3000000",
        categoryTotalsMicros: { usage: "3000000" },
        categoryRowCounts: { usage: 2 },
      }],
      { rowCount: 2 },
    )));
    assert.equal(result.ok, false);
    assert.equal(result.activation, "retain_current_active_generation");
    assert.deepEqual(result.failures.map(({ code, field }) => ({ code, field })), [
      {
        code: "CURRENCY_ROW_COUNT_MISMATCH",
        field: "currencies.USD.rowCount",
      },
      {
        code: "CURRENCY_TOTAL_MISMATCH",
        field: "currencies.USD.totalMicros",
      },
      {
        code: "CATEGORY_ROW_COUNT_MISMATCH",
        field: "currencies.USD.categoryRowCounts.usage",
      },
      {
        code: "CATEGORY_TOTAL_MISMATCH",
        field: "currencies.USD.categoryTotalsMicros.usage",
      },
      { code: "CURRENCY_ROW_COUNT_MISMATCH", field: "rowCount" },
    ]);
  });

  it("blocks missing, invalid, duplicate, inconsistent, and unknown source evidence", () => {
    const rows = scopedRows(canonicalLines([
      "line-1,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1,USD",
    ]));
    const missing = reconcileCanonicalBillingGeneration(input(rows, null));
    assert.equal(missing.ok, false);
    assert.equal(missing.failures[0]?.code, "MISSING_SOURCE_EVIDENCE");

    const invalidCases: readonly FinopsReconciliationEvidence[] = [
      evidence([
        { currency: "USD", rowCount: 1, totalMicros: "1000000" },
        { currency: "USD", rowCount: 0, totalMicros: "0" },
      ]),
      evidence([{ currency: "ZZZ", rowCount: 1, totalMicros: "1000000" }]),
      evidence(
        [{ currency: "USD", rowCount: 1, totalMicros: "1000000" }],
        { rowCount: 2 },
      ),
      evidence(
        [{ currency: "USD", rowCount: 1, totalMicros: "1.25" }],
      ),
    ];
    const expectedCodes = [
      "DUPLICATE_CURRENCY_EVIDENCE",
      "UNKNOWN_CURRENCY",
      "EVIDENCE_ROW_COUNT_INCONSISTENT",
      "INVALID_SOURCE_EVIDENCE",
    ];
    invalidCases.forEach((source, index) => {
      const result = reconcileCanonicalBillingGeneration(input(rows, source));
      assert.equal(result.ok, false);
      assert.ok(result.failures.some(({ code }) => code === expectedCodes[index]));
    });
  });

  it("rejects every cross-scope dimension before comparing staged totals", () => {
    const [line] = canonicalLines([
      "line-1,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1,USD",
    ]);
    const source = evidence([
      { currency: "USD", rowCount: 1, totalMicros: "1000000" },
    ]);
    const mismatches: readonly Partial<FinopsReconciliationScope>[] = [
      { organizationId: "org_attacker" },
      { customerId: "customer_attacker" },
      { connectionId: "conn_attacker" },
      { exportName: "attacker-cur" },
      { billingPeriod: "2026-06" },
      { generationId: `fbg_${"b".repeat(64)}` },
    ];
    for (const mismatch of mismatches) {
      const result = reconcileCanonicalBillingGeneration(input(
        [{ ...SCOPE, ...mismatch, line }],
        source,
      ));
      assert.equal(result.ok, false);
      assert.equal(result.failures[0]?.code, "ROW_SCOPE_MISMATCH");
      assert.equal(result.failures[0]?.rowIndex, 0);
    }

    const evidenceScopeMismatch = reconcileCanonicalBillingGeneration(input(
      scopedRows([line]),
      evidence(
        [{ currency: "USD", rowCount: 1, totalMicros: "1000000" }],
        { scope: { ...SCOPE, customerId: "customer_attacker" } },
      ),
    ));
    assert.equal(evidenceScopeMismatch.ok, false);
    assert.equal(
      evidenceScopeMismatch.failures[0]?.code,
      "EVIDENCE_SCOPE_MISMATCH",
    );
  });

  it("never rounds malformed micros and blocks unknown or unevidenced row currencies", () => {
    const [base] = canonicalLines([
      "line-1,111122223333,AmazonEC2,Usage,2026-07-01T00:00:00Z,1,USD",
    ]);
    const source = evidence([
      { currency: "USD", rowCount: 1, totalMicros: "1000000" },
    ]);
    const cases: readonly {
      readonly line: CanonicalCurLine;
      readonly code: string;
    }[] = [
      { line: { ...base, amountMicros: "1000000.4" }, code: "INVALID_CANONICAL_ROW" },
      { line: { ...base, currency: "ZZZ" }, code: "UNKNOWN_CURRENCY" },
      { line: { ...base, currency: "EUR" }, code: "UNEXPECTED_CURRENCY" },
    ];
    for (const entry of cases) {
      const result = reconcileCanonicalBillingGeneration(input(
        scopedRows([entry.line]),
        source,
      ));
      assert.equal(result.ok, false);
      assert.equal(result.failures[0]?.code, entry.code);
      assert.equal(result.activation, "retain_current_active_generation");
    }
  });

  it("accepts an evidence-backed empty billing period without inventing currency totals", () => {
    const result = reconcileCanonicalBillingGeneration(input(
      [],
      evidence([], { rowCount: 0 }),
    ));
    assert.equal(result.ok, true);
    assert.equal(result.actual.rowCount, 0);
    assert.deepEqual(result.actual.currencies, []);
  });

  it("requires a content-derived generation identifier", () => {
    const result = reconcileCanonicalBillingGeneration({
      scope: { ...SCOPE, generationId: "generation-one" },
      rows: [],
      evidence: evidence([], { rowCount: 0 }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.failures[0]?.code, "INVALID_SCOPE");
  });
});
