import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
const [component, navigation, views, browser, css, catalog] = await Promise.all([
  readFile(path.join(root, "app/costs/finops-focus-dashboard.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/finops-dashboard-catalog-nav.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/finops-dashboard-views.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/costs-browser.tsx"), "utf8"),
  readFile(path.join(root, "app/costs/costs.module.css"), "utf8"),
  readFile(path.join(root, "lib/finops-dashboard-catalog.ts"), "utf8"),
]);

test("FOCUS catalog entry is wired to its tenant-resolved GET report", () => {
  // The catalog nav resolves dedicated views through the keyed registry, so the
  // FOCUS wiring is asserted where it now lives.
  assert.match(navigation, /getFinopsDashboardView\(selected\.id\)/u);
  assert.match(views, /^ {2}focus: \(\{[^}]*\}\) => \(/mu);
  assert.match(views, /<FinopsFocusDashboard/u);
  assert.match(views, /connectionId=\{connectionId\}/u);
  assert.match(
    browser,
    /<FinopsDashboardCatalogNav[\s\S]*connectionId=\{connectionId\}[\s\S]*onOpenSharedAnalysis=\{navigateToSection\}/u,
  );
  assert.match(component, /\/api\/v1\/finops\/focus\?\$\{parameters\.toString\(\)\}/u);
  assert.match(component, /new URLSearchParams\(\{ connectionId \}\)/u);
  assert.match(component, /parameters\.set\("fromPeriod", selectedFrom\)/u);
  assert.match(component, /parameters\.set\("toPeriod", selectedTo\)/u);
  assert.match(component, /credentials: "same-origin"/u);
  assert.match(
    catalog,
    /id: "focus"[\s\S]*currentMaturity: "PARTIAL_PIPELINE"/u,
  );
});

test("FOCUS UI has every honest delivery state and never substitutes evidence", () => {
  for (const state of [
    "loading",
    "configuration_required",
    "waiting",
    "empty",
    "partial",
    "stale",
    "failed",
    "complete",
  ]) assert.match(component, new RegExp(`view: "${state}"`, "u"), state);
  assert.match(component, /sourceState === "source_incomplete"/u);
  assert.match(component, /state\.envelope\.connectionId !== connectionId/u);
  assert.match(component, /requestState\.envelope\.connectionId === connectionId/u);
  assert.match(component, /report === null/u);
  assert.match(component, /CUR, FOCUS 1\.0, Cost Explorer, and sample spend are never substituted/u);
  assert.match(component, /not a FOCUS conformance certification/u);
  assert.match(component, /not invoice reconciliation/u);
  assert.match(component, /no exchange-rate conversion/u);
  assert.match(component, /no savings claim/u);
  assert.doesNotMatch(component, /fixture|mock spend|placeholder spend|dummy metric/iu);
});

test("FOCUS visuals use exact money, bounded API output, and accessible controls", () => {
  const formatter = component.slice(
    component.indexOf("export function formatFocusMicrosExact"),
    component.indexOf("function parseFocusEnvelope"),
  );
  assert.match(formatter, /BigInt\(micros\)/u);
  assert.match(formatter, /BigInt\(1_000_000\)/u);
  assert.doesNotMatch(formatter, /Number\s*\(/u);
  // The trend is drawn by the shared chart kit; the accessible name is passed
  // to it rather than set on hand-rolled markup, and the kit renders it as the
  // chart's role="img" label plus an exact-values table.
  assert.match(component, /ariaLabel=\{`\$\{selectedCurrency\.currency\} exact \$\{FOCUS_COST_LABELS\[costBasis\]\} trend`\}/u);
  assert.match(component, /import \{ RankingBars, TimeSeriesChart \} from "\.\.\/components\/charts"/u);
  assert.match(component, /Dimension analysis/u);
  assert.match(component, /Secondary dimension analysis/u);
  assert.match(component, /Second Group By/u);
  assert.match(component, /Bounded billing-line drilldown/u);
  assert.match(component, /Effective discount rate/u);
  assert.match(component, /Contracted cost/u);
  assert.match(component, /List cost/u);
  assert.match(component, /Month over month trends/u);
  assert.match(component, /Month over month exact cost change/u);
  assert.match(component, /Daily billing summary/u);
  assert.match(component, /Billing Account/u);
  assert.match(component, /Sub Account/u);
  assert.match(component, /Publisher/u);
  assert.match(component, /Charge Category/u);
  assert.match(component, /Apply billing controls/u);
  assert.match(component, /Tag taxonomy/u);
  assert.match(component, /Only exact policy keys are governed/u);
  assert.match(component, /Normalized source contract/u);
  assert.match(component, /FOCUS source<select/u);
  assert.match(component, /providerSourceId/u);
  assert.match(component, /Schema coverage/u);
  assert.match(component, /Active generation evidence for all selected periods/u);
  assert.match(component, /aria-pressed=\{currency === selectedCurrency\?\.currency\}/u);
  assert.match(component, /tabIndex=\{0\} role="region"/u);
  assert.match(component, /<caption>Bounded canonical FOCUS billing-line drilldown<\/caption>/u);
  assert.match(component, /<label>From period<select/u);
  assert.match(component, /<label>To period<select/u);
  assert.match(component, /From period must not be after to period/u);
});

test("FOCUS layout is responsive and exposes keyboard focus", () => {
  for (const selector of [
    ".focusWorkspace",
    ".focusKpis",
    ".focusCoverageList",
    ".focusTableWrap",
    ".focusQualityGrid",
    ".focusEvidenceDrawer",
  ]) assert.match(css, new RegExp(selector.replace(".", "\\."), "u"), selector);
  assert.match(css, /\.focusCurrencyTabs button:focus-visible/u);
  assert.match(css, /\.focusTableWrap:focus-visible/u);
  assert.match(css, /@media screen and \(max-width: 1120px\)[\s\S]*\.focusSplitGrid \{ grid-template-columns: 1fr;/u);
  assert.match(css, /@media screen and \(max-width: 760px\)[\s\S]*\.focusKpis, \.focusQualityGrid \{ grid-template-columns: 1fr;/u);
  assert.match(css, /min-height: 44px/u);
});

test("FOCUS official definition panel renders without a billing report", async () => {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const [focusModule, definitionModule] = await Promise.all([
      vite.ssrLoadModule("/app/costs/finops-focus-dashboard.tsx"),
      vite.ssrLoadModule("/lib/finops-focus-official-definition.ts"),
    ]);
    const html = renderToStaticMarkup(createElement(
      focusModule.FocusOfficialDefinitionPanel,
      { definition: definitionModule.FOCUS_OFFICIAL_DEFINITION },
    ));
    assert.match(html, /Official FOCUS definition coverage/u);
    assert.match(html, /Billing Summary/u);
    assert.match(html, /18 visuals/u);
    assert.match(html, /MoM Trends/u);
    assert.match(html, /9 visuals/u);
    assert.match(html, /About/u);
    assert.match(html, /Official provider repositories and native binding state/u);
    assert.match(html, /AZURE FOCUS 1 0 NORMALIZED BINDING NOT DEPLOYED/u);
    assert.match(html, /GCP FOCUS EXPORT ADAPTER NOT DEPLOYED/u);
    assert.match(html, /OCI SOURCE DISCOVERY AND BINDING NOT DEPLOYED/u);
    assert.match(html, /does not claim QuickSight pixel, geometry, query-result, or interaction parity/u);
  } finally {
    await vite.close();
  }
});

test("FOCUS report view renders exact evidence without browser data or placeholders", async () => {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const focusModule = await vite.ssrLoadModule("/app/costs/finops-focus-dashboard.tsx");
    const report = {
      ok: true,
      schema: "sutra.finops-focus-dashboard.v1",
      standard: "FOCUS_1_2",
      conformanceClaim: false,
      evidence: {
        organizationId: "org_render",
        customerId: "customer_render",
        connectionId: "conn_render",
        exportName: "focus-export",
        periods: [{
          period: "2026-07",
          generationId: `fbg_${"a".repeat(64)}`,
          manifestSha256: "b".repeat(64),
          sourceTable: "FOCUS_1_2_AWS",
          committedAtIso: "2026-08-01T00:00:00.000Z",
          acceptedRows: 1,
          rejectedRows: 0,
        }],
      },
      quality: {
        sourceFormat: "focus",
        sourceVersion: "1.2",
        schemaCoverageBasis: "canonical_non_null_field_presence",
        acceptedLineCount: 1,
        rejectedSourceRowCount: 0,
        ingestionCoverage: "complete",
        rejectionRatio: {
          rejectedRowsNumerator: "0",
          observedRowsDenominator: "1",
        },
        fields: [{
          field: "BilledCost",
          requirement: "projection_required",
          presentLineCount: 1,
          missingLineCount: 0,
          coverageBasisPoints: "10000",
          coverage: "complete",
        }],
      },
      currencies: [{
        currency: "USD",
        lineCount: 1,
        billedCostMicros: "9007199254740993000001",
        effectiveCost: {
          totalMicros: "8000000",
          observedMicros: "8000000",
          presentLineCount: 1,
          missingLineCount: 0,
          coverage: "complete",
        },
        dimensions: [{
          dimension: "service",
          distinctValueCount: 1,
          missingLineCount: 0,
          entries: [{
            rank: 1,
            value: "Amazon EC2",
            lineCount: 1,
            billedCostMicros: "9007199254740993000001",
            effectiveCost: {
              totalMicros: "8000000",
              observedMicros: "8000000",
              presentLineCount: 1,
              missingLineCount: 0,
              coverage: "complete",
            },
          }],
          truncated: false,
        }],
      }],
      trends: [{
        period: "2026-07",
        currency: "USD",
        lineCount: 1,
        billedCostMicros: "9007199254740993000001",
        effectiveCost: {
          totalMicros: "8000000",
          observedMicros: "8000000",
          presentLineCount: 1,
          missingLineCount: 0,
          coverage: "complete",
        },
      }],
      drilldowns: {
        totalRows: 1,
        returnedRows: 1,
        truncated: false,
        rows: [{
          period: "2026-07",
          lineItemId: "line-render",
          currency: "USD",
          billedCostMicros: "9007199254740993000001",
          effectiveCostMicros: "8000000",
          billingAccountId: "111111111111",
          subAccountId: "222222222222",
          provider: "AWS",
          service: "Amazon EC2",
          region: "us-east-1",
          chargeCategory: "Usage",
          resourceId: "i-render",
        }],
      },
      neutral: {
        schema: "sutra.finops-focus-neutral-report.v1",
        scope: { orgId: "org_render", customerId: "customer_render" },
        sources: [{ orgId: "org_render", customerId: "customer_render", sourceId: "conn_render:2026-07", provider: "AWS", focusVersion: "1.2", datasetName: "FOCUS_1_2_AWS", generationId: `fbg_${"a".repeat(64)}`, contentSha256: "b".repeat(64), collectedAt: "2026-08-01T00:00:00.000Z", dataThroughAt: "2026-08-01T00:00:00.000Z", normalizedSchema: "sutra.focus-neutral-line.v1" }],
        versions: ["1.2"], providers: ["AWS"],
        currencies: [{ currency: "USD", billedCostMicros: "9007199254740993000001", effectiveCostMicros: "8000000", effectiveDiscountRate: { state: "UNAVAILABLE", basisPoints: null, numeratorMicros: null, denominatorMicros: null, formula: "(LIST_COST-EFFECTIVE_COST)/LIST_COST", reason: "CHARGE_CLASS_SEMANTICS_NOT_PROVIDED" }, tags: [{ key: "team", label: "Team", classification: "GOVERNED", value: "platform", billedCostMicros: "9007199254740993000001", lineCount: 1 }] }],
        taxonomy: { state: "GOVERNED", policyId: "sutra-focus-baseline-v1", governedKeys: ["team"] },
        invariants: ["source_versions_and_provenance_are_retained", "currencies_are_never_combined", "money_uses_signed_integer_micros", "missing_cost_columns_are_never_substituted", "discount_rate_requires_valid_focus_denominator_semantics"],
      },
      invariants: [
        "only_active_canonical_focus_1_2_is_accepted",
        "currencies_are_never_combined",
        "money_uses_signed_bigint_micros",
        "missing_fields_are_not_substituted",
      ],
      disclaimer: "Not a conformance certification or invoice reconciliation.",
    };
    const markup = renderToStaticMarkup(createElement(
      focusModule.FinopsFocusReportView,
      { report },
    ));
    assert.match(markup, /Portable billing analysis/u);
    assert.match(markup, /USD 9,007,199,254,740,993\.000001/u);
    assert.match(markup, /Amazon EC2/u);
    assert.match(markup, /line-render/u);
    assert.match(markup, /BilledCost/u);
    assert.match(markup, /FOCUS_1_2_AWS/u);
    assert.doesNotMatch(markup, /fixture|sample spend|placeholder/iu);
  } finally {
    await vite.close();
  }
});
