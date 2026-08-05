import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * ADD-03 Cloud Intelligence Dashboard for GCP — presentation contract.
 *
 * GCP CID is excluded from the 27-dashboard release and its maturity is
 * PARTIAL_PIPELINE. There is no GCP billing connection in this runtime, so the
 * assertions here are deliberately negative as well as positive:
 *
 * 1. All 7 official sheets are presented, so a reader sees the real shape of the
 *    upstream dashboard.
 * 2. The "GCP provider connection is not implemented" state is stated plainly.
 * 3. No fabricated spend value appears anywhere — not a currency amount, not a
 *    zero standing in for a missing figure.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const dashboard = await vite.ssrLoadModule("/app/costs/finops-gcp-cloud-intelligence-dashboard.tsx");
const definitionModule = await vite.ssrLoadModule(
  "/lib/finops-gcp-cloud-intelligence-official-definition.ts",
);
after(async () => vite.close());

const DEFINITION = definitionModule.GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION;
const OFFICIAL_SHEETS = ["Summary", "Compute Engine", "Cloud SQL", "Big Query", "Network", "Kubernetes", "About"];

const render = (props) => renderToStaticMarkup(createElement(
  dashboard.FinopsGcpCloudIntelligencePresentation,
  props,
));

/** Every report-independent arm the route can return. */
const NO_SOURCE = {
  schema: "sutra.finops-gcp-cloud-intelligence-dashboard.v1",
  sourceState: "CONFIGURATION_REQUIRED",
  dashboard: null,
  selectionRequired: false,
  sources: [],
  officialDefinition: DEFINITION,
  activation: { provider: "GCP", reason: "NO_ACTIVE_GCP_BILLING_SOURCE" },
};

const NO_GENERATION = {
  schema: "sutra.finops-gcp-cloud-intelligence-dashboard.v1",
  sourceId: "src_gcp_1",
  sourceState: "PARTIAL_PIPELINE",
  dashboard: null,
  selectionRequired: false,
  sources: [{
    sourceId: "src_gcp_1",
    billingAccountId: "01ABCD-2345EF-6789AB",
    exportProjectId: "billing-export-project",
    location: "US",
  }],
  officialDefinition: DEFINITION,
  activation: {
    provider: "GCP",
    billingAccountId: "01ABCD-2345EF-6789AB",
    export: "billing-export-project.billing.gcp_billing_export_v1",
    pricing: "billing-export-project.billing.cloud_pricing_export",
    identity: "WORKLOAD_IDENTITY_REFERENCE_ONLY",
    reason: "GCP_BIGQUERY_BILLING_EXPORT_ADAPTER_NOT_DEPLOYED",
  },
};

/**
 * Any string that looks like a rendered money amount. Sheet counts, visual
 * counts and content hashes are digits too, so the pattern is anchored on a
 * currency marker: an ISO code or symbol immediately before a figure.
 */
const CURRENCY_AMOUNT = /(?:USD|EUR|GBP|JPY|INR|AUD|CAD|CHF|BRL|SEK)\s*[−-]?\d|[$€£¥]\s*\d/u;

for (const [name, response] of [["no registered source", NO_SOURCE], ["no accepted generation", NO_GENERATION]]) {
  test(`ADD-03 presents all 7 official sheets with ${name}`, () => {
    const html = render({ response });

    for (const sheet of OFFICIAL_SHEETS) assert.match(html, new RegExp(sheet, "u"));
    assert.equal(OFFICIAL_SHEETS.length, DEFINITION.totals.sheets);

    // The official structure is stated, not just the sheet names.
    assert.match(html, /7<\/b> official sheets/u);
    assert.match(html, /60<\/b> visuals/u);
    assert.match(html, /54<\/b> controls/u);
    // No sheet is presented as covered while the provider is unconnected.
    assert.match(html, /0<\/b> fully covered, <b>7<\/b> partial/u);
  });

  test(`ADD-03 states the not-implemented provider state with ${name}`, () => {
    const html = render({ response });

    assert.match(html, /GCP provider connection is not implemented/u);
    assert.match(html, /Configuration required/u);
    assert.match(html, /Sutra has no GCP billing connection in this runtime/u);
    assert.match(html, /Workload Identity \/ BigQuery/u);
    assert.match(html, /Not available/u);

    // Release scope and maturity are disclosed, never promoted.
    assert.match(html, /Excluded from the 27-dashboard release/u);
    assert.match(html, /PARTIAL_PIPELINE/u);
    assert.doesNotMatch(html, /LOCAL_VERTICAL_CANDIDATE|production[- ]ready|live[- ]accepted/iu);

    // The named unavailable capabilities are explicit, not implied.
    assert.match(html, /Live provider generation and reconciliation/u);
    assert.match(html, /Six-level project hierarchy parity/u);
    assert.match(html, /Exact interactions and visual geometry/u);

    // The active sheet withholds its figures and says why.
    assert.match(html, /Withheld: no accepted GCP billing generation/u);
    assert.match(html, /No AWS value, aggregate or estimate is substituted/u);
  });

  test(`ADD-03 renders no fabricated spend value with ${name}`, () => {
    const html = render({ response });

    assert.doesNotMatch(html, CURRENCY_AMOUNT);
    // No borrowed provider or sample framing anywhere.
    assert.doesNotMatch(html, /sample spend|placeholder spend|mock billing|demo cost|example cost/iu);
    // A withheld figure is never rendered as a zero.
    assert.doesNotMatch(html, /Net billed|Cost before credits|Realized credits|Pricing variance/u);
    assert.doesNotMatch(html, /\b0\.00\b/u);
  });
}

test("ADD-03 presents the 7 official sheets and the same disclosures with no response at all", () => {
  const html = render({ response: null });

  for (const sheet of OFFICIAL_SHEETS) assert.match(html, new RegExp(sheet, "u"));
  assert.match(html, /GCP provider connection is not implemented/u);
  // With no response the pinned native binding state is the source state.
  assert.match(html, /GCP BIGQUERY BILLING EXPORT ADAPTER NOT DEPLOYED/u);
  assert.doesNotMatch(html, CURRENCY_AMOUNT);
});

test("ADD-03 exact-nanos formatter never fabricates and never converts to Number", () => {
  const { formatNanosExact } = dashboard;

  // Missing evidence is a label, never a zero.
  assert.equal(formatNanosExact(null, "USD"), "Not available");
  assert.equal(formatNanosExact("1000000000", "usd"), "Not available");
  assert.equal(formatNanosExact("1.5", "USD"), "Not available");

  // Exact nanos, including magnitudes a double cannot hold exactly.
  assert.equal(formatNanosExact("1000000000", "USD"), "USD 1.00");
  assert.equal(formatNanosExact("1234567891234567890", "USD"), "USD 1,234,567,891.23456789");
  assert.equal(formatNanosExact("-65432110", "EUR"), "−EUR 0.06543211");
  assert.equal(formatNanosExact("0", "USD"), "USD 0.00");
});

test("ADD-03 sheet inventory mirrors the pinned definition exactly", () => {
  const inventory = dashboard.gcpOfficialSheetInventory(DEFINITION);

  assert.equal(inventory.totalSheets, 7);
  assert.equal(inventory.totalVisuals, 60);
  assert.equal(inventory.totalControls, 54);
  assert.equal(inventory.supportedSheets, 0);
  assert.equal(inventory.partialSheets, 7);
  assert.deepEqual(inventory.sheets.map((sheet) => sheet.name), OFFICIAL_SHEETS);
  assert.deepEqual(
    inventory.sheets.map((sheet) => sheet.visualCount),
    DEFINITION.sheets.map((sheet) => sheet.visualCount),
  );
  assert.equal(
    inventory.sheets.reduce((total, sheet) => total + sheet.controlCount, 0),
    inventory.totalControls,
  );
  // Every sheet carries its audited gap plus the missing-connection gap.
  for (const sheet of inventory.sheets) {
    assert.equal(sheet.support, "PARTIAL");
    assert.equal(sheet.gaps.length, 2);
    assert.match(sheet.gaps[1], /No GCP billing connection exists in this runtime/u);
  }
  assert.equal(inventory.source.commit, DEFINITION.source.commit);
  assert.equal(inventory.source.sha256, DEFINITION.source.embeddedDefinitionSha256);
  assert.equal(inventory.source.version, null);
});
