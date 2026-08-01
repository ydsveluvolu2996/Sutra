import assert from "node:assert/strict";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");

test("native KPI workspace renders the exact official sheet inventory and evidence filters", async () => {
  const vite = await createServer({
    root, configFile: false, logLevel: "silent", plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const [panel, kpi, definition] = await Promise.all([
      vite.ssrLoadModule("/app/costs/finops-foundational-panels.tsx"),
      vite.ssrLoadModule("/lib/finops-kpi.ts"),
      vite.ssrLoadModule("/lib/finops-kpi-official-definition.ts"),
    ]);
    const measurements = kpi.FINOPS_KPI_FORMULAS.map((formula) => ({
      kpiId: formula.id,
      formulaVersion: formula.formulaVersion,
      state: "measured",
      findingKind: "candidate_estimate",
      validationRequired: true,
      selectedGoal: null,
      eligibleLineCount: 1,
      classifiableLineCount: 1,
      unclassifiedLineCount: 0,
      evidenceCompleteness: "complete",
      reasonCodes: [],
      segments: [{
        basis: "usage_quantity", currency: "USD", usageUnit: "Hrs",
        numerator: "1", denominator: "2", currentBasisPoints: 5000,
        ratioRemainder: "0", ratioDenominator: "10000",
        goalStatus: "no_goal", gapBasisPoints: null,
        sourceLineIds: ["line-1"], sourceLineIdsTruncated: false,
      }],
    }));
    const envelope = {
      connectionId: `conn_${"a".repeat(32)}`,
      selectedPeriod: "2026-07",
      availablePeriods: [{
        period: "2026-07", generationId: `fbg_${"b".repeat(64)}`,
        committedAtIso: "2026-08-01T00:00:00.000Z",
      }],
      report: {
        ok: true, schema: "sutra.finops-kpi.v1",
        formulaRegistry: kpi.FINOPS_KPI_FORMULAS,
        measurements, opportunities: [], opportunitiesTruncated: false,
        evidenceWindow: {
          startIso: "2026-07-01T00:00:00.000Z",
          endIso: "2026-08-01T00:00:00.000Z",
        },
      },
      goalsConfigured: 0,
      sourceState: "complete",
      sourceEvidence: null,
      filters: { accountId: null, payerAccountId: null },
      filterOptions: {
        accountIds: ["111122223333"], payerAccountIds: ["444455556666"],
      },
      officialDefinition: definition.FINOPS_KPI_OFFICIAL_DEFINITION,
    };
    const html = renderToStaticMarkup(createElement(panel.KpiScorecard, {
      envelope,
      filters: { period: "", accountId: "", payerAccountId: "" },
      onFiltersChange: () => undefined,
    }));
    for (const text of [
      "v2.2.1 · 10 sheets · 91 visuals",
      "60 parameter controls · 34 filter controls",
      "KPI Tracker", "Set KPI Goals", "Metrics Summary", "EC2", "EBS",
      "S3", "RDS", "Other Graviton", "Commit Optimizations", "About",
      "Billing period", "Account ID", "Payer account ID",
      "All 19 Foundational KPI measurements",
      "Additional monthly savings at goal remains unavailable",
    ]) assert.match(html, new RegExp(text, "iu"), text);
    assert.doesNotMatch(html, /fixture|placeholder|sample data/iu);
  } finally {
    await vite.close();
  }
});
