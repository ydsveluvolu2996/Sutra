import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type {
  FinopsActiveBillingDataset,
  FinopsActiveBillingEvidence,
} from "../db/finops-active-billing-query-repository.ts";
import { parseCurCsv, type CanonicalCurLine } from "../lib/finops-cur.ts";
import {
  buildFinopsFocusDashboard,
  FINOPS_FOCUS_DASHBOARD_BOUNDS,
} from "../lib/finops-focus-dashboard.ts";
import type { FinopsReconciliationScope } from "../lib/finops-reconciliation.ts";

const OWNER = {
  orgId: "org_focus",
  customerId: "customer_focus",
  connectionId: "conn_focus",
} as const;

function focusLine(
  lineItemId: string,
  amountMicros: string,
  currency = "USD",
  overrides: Partial<CanonicalCurLine> = {},
): CanonicalCurLine {
  const parsed = parseCurCsv([
    "BillingAccountId,BillingAccountType,SubAccountId,ServiceName,ServiceCategory,ChargeCategory,ChargeDescription,ChargePeriodStart,BilledCost,BillingCurrency,EffectiveCost,ProviderName,RegionId,ResourceId,ResourceType,InvoiceId",
    `111111111111,AWS Organization,222222222222,Amazon EC2,Compute,Usage,${lineItemId},2026-07-01T00:00:00Z,1,${currency},0.75,AWS,us-east-1,i-1,Virtual Machine,invoice-1`,
  ].join("\n"));
  if ("error" in parsed) throw new Error(parsed.error);
  const line = parsed.lines[0];
  if (line === undefined) throw new Error("Expected a parsed line");
  return { ...line, amountMicros, ...overrides };
}

function evidence(
  acceptedRows: number,
  overrides: Partial<FinopsActiveBillingEvidence> = {},
): FinopsActiveBillingEvidence {
  return {
    activeManifestSha256: "a".repeat(64),
    activeSourceTable: "FOCUS_1_2_AWS",
    activeSourceFormat: "focus",
    activeSourceVersion: "1.2",
    activeSourceUpdatedAtIso: "2026-07-03T00:00:00.000Z",
    activeObservedAtIso: "2026-07-03T01:00:00.000Z",
    activeCommittedAtIso: "2026-07-03T02:00:00.000Z",
    acceptedRows,
    rejectedRows: 0,
    ...overrides,
  };
}

function scope(period = "2026-07", generation = "a"): FinopsReconciliationScope {
  return {
    organizationId: OWNER.orgId,
    customerId: OWNER.customerId,
    connectionId: OWNER.connectionId,
    exportName: "focus-export",
    billingPeriod: period,
    generationId: `fbg_${generation.repeat(64)}`,
  };
}

function dataset(
  lines: readonly CanonicalCurLine[],
  period = "2026-07",
  generation = "a",
  evidenceOverrides: Partial<FinopsActiveBillingEvidence> = {},
): FinopsActiveBillingDataset {
  const datasetScope = scope(period, generation);
  return {
    scope: datasetScope,
    evidence: evidence(lines.length, evidenceOverrides),
    rows: lines.map((line) => ({ ...datasetScope, line })),
  };
}

describe("FOCUS 1.2 report projection", () => {
  it("uses exact bigint micros and keeps currencies in independent reports", () => {
    const usd = focusLine("usd", "9007199254740993000001");
    const credit = focusLine("credit", "-1");
    const eur = focusLine("eur", "5000000", "EUR");
    const result = buildFinopsFocusDashboard({
      scope: OWNER,
      datasets: [dataset([usd, credit, eur], "2026-07", "a")],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.currencies.map(({ currency }) => currency), ["EUR", "USD"]);
    assert.equal(result.currencies[0]?.billedCostMicros, "5000000");
    assert.equal(result.currencies[1]?.billedCostMicros, "9007199254740993000000");
    assert.equal(result.invariants.includes("currencies_are_never_combined"), true);
    assert.equal(result.invariants.includes("money_uses_signed_bigint_micros"), true);
  });

  it("rejects CUR and FOCUS 1.0 at both evidence and canonical-row boundaries", () => {
    const line = focusLine("focus", "1000000");
    for (const substitution of [
      { activeSourceFormat: "aws-cur" as const, activeSourceVersion: "2.0" as const },
      { activeSourceFormat: "focus" as const, activeSourceVersion: "1.0" as const },
    ]) {
      const result = buildFinopsFocusDashboard({
        scope: OWNER,
        datasets: [dataset([line], "2026-07", "a", substitution)],
      });
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.failures[0]?.code, "SOURCE_SUBSTITUTION");
    }
    const rowSubstitution = buildFinopsFocusDashboard({
      scope: OWNER,
      datasets: [dataset([{ ...line, sourceFormat: "aws-cur", sourceVersion: "2.0" }])],
    });
    assert.equal(rowSubstitution.ok, false);
    if (!rowSubstitution.ok) {
      assert.equal(rowSubstitution.failures[0]?.code, "SOURCE_SUBSTITUTION");
      assert.equal(rowSubstitution.failures[0]?.rowIndex, 0);
    }
  });

  it("fails closed on cross-tenant rows, malformed micros, and duplicate line identities", () => {
    const line = focusLine("same", "1000000");
    const original = dataset([line]);
    const crossTenant: FinopsActiveBillingDataset = {
      ...original,
      rows: [{ ...original.rows[0]!, customerId: "customer_attacker" }],
    };
    const scoped = buildFinopsFocusDashboard({ scope: OWNER, datasets: [crossTenant] });
    assert.equal(scoped.ok, false);
    if (!scoped.ok) assert.equal(scoped.failures[0]?.code, "SCOPE_MISMATCH");

    const malformed = buildFinopsFocusDashboard({
      scope: OWNER,
      datasets: [dataset([{ ...line, amountMicros: "1.5" }])],
    });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.equal(malformed.failures[0]?.code, "INVALID_CANONICAL_ROW");

    const duplicate = buildFinopsFocusDashboard({
      scope: OWNER,
      datasets: [dataset([line, { ...line }])],
    });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.failures[0]?.code, "DUPLICATE_LINE_ITEM_ID");
  });

  it("discloses rejected rows and canonical non-null schema coverage", () => {
    const complete = focusLine("complete", "1000000");
    const sparse = focusLine("sparse", "2000000", "USD", {
      amortizedMicros: null,
      billingEntity: null,
      region: null,
      resourceId: null,
      resourceType: null,
      invoiceId: null,
    });
    const result = buildFinopsFocusDashboard({
      scope: OWNER,
      datasets: [dataset([complete, sparse], "2026-07", "a", { rejectedRows: 2 })],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.quality.ingestionCoverage, "partial");
    assert.deepEqual(result.quality.rejectionRatio, {
      rejectedRowsNumerator: "2",
      observedRowsDenominator: "4",
    });
    const provider = result.quality.fields.find(({ field }) => field === "ProviderName");
    assert.equal(provider?.coverage, "partial");
    assert.equal(provider?.coverageBasisPoints, "5000");
    const billed = result.quality.fields.find(({ field }) => field === "BilledCost");
    assert.equal(billed?.coverage, "complete");
    const usd = result.currencies[0];
    assert.equal(usd?.effectiveCost.totalMicros, null);
    assert.equal(usd?.effectiveCost.observedMicros, "750000");
    assert.equal(usd?.effectiveCost.missingLineCount, 1);
    assert.equal(result.conformanceClaim, false);
  });

  it("bounds high-cardinality dimensions and raw drilldowns deterministically", () => {
    const lines = Array.from({ length: 130 }, (_, index) => focusLine(
      `line-${String(index).padStart(3, "0")}`,
      String(index + 1),
      "USD",
      { service: `service-${String(index).padStart(3, "0")}` },
    ));
    const result = buildFinopsFocusDashboard({
      scope: OWNER,
      datasets: [dataset(lines)],
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const services = result.currencies[0]?.dimensions.find(
      ({ dimension }) => dimension === "service",
    );
    assert.equal(services?.distinctValueCount, 130);
    assert.equal(services?.entries.length, FINOPS_FOCUS_DASHBOARD_BOUNDS.dimensionValueLimit);
    assert.equal(services?.truncated, true);
    assert.equal(result.drilldowns.totalRows, 130);
    assert.equal(result.drilldowns.returnedRows, FINOPS_FOCUS_DASHBOARD_BOUNDS.drilldownLimit);
    assert.equal(result.drilldowns.truncated, true);
    assert.equal(result.drilldowns.rows[0]?.lineItemId, "line-129");
  });

  it("rejects more than 36 historical periods", () => {
    const datasets = Array.from({ length: 37 }, (_, index) => {
      const year = 2023 + Math.floor(index / 12);
      const month = index % 12 + 1;
      const period = `${year}-${String(month).padStart(2, "0")}`;
      const generation = (index % 10).toString();
      return dataset([focusLine(`line-${index}`, "1")], period, generation);
    });
    const result = buildFinopsFocusDashboard({ scope: OWNER, datasets });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.failures[0]?.code, "PERIOD_LIMIT_EXCEEDED");
  });
});
