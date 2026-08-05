import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * ADD-05 AWS Marketplace Single Pane of Glass presentation.
 *
 * Renders every one of the five official tabs against a realistic report and
 * asserts the honesty rules: exact integer micro-unit money, CUR2 and
 * control-plane evidence kept apart, missing evidence as a labelled state rather
 * than a zero, withheld percentages explained, negative amounts keeping their
 * sign, and Bedrock third-party model classification presented as unavailable
 * rather than simulated.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const marketplace = await vite.ssrLoadModule("/app/costs/finops-marketplace-spg-dashboard.tsx");
const definitionModule = await vite.ssrLoadModule("/lib/finops-marketplace-spg-official-definition.ts");
after(async () => vite.close());

const DEFINITION = definitionModule.MARKETPLACE_SPG_OFFICIAL_DEFINITION;
const render = (component, props) => renderToStaticMarkup(createElement(component, props));

const ranked = (key, currency, billed, amortized, rowCount) => ({
  key, currency, billedAmountMicros: billed, amortizedAmountMicros: amortized, rowCount,
});

/**
 * USD carries a positive total with a real credit row, so signs and a computable
 * share are both exercised. EUR carries only a refund, so its total is negative
 * and every EUR share must be withheld with a reason.
 */
const SPEND_ROWS = [
  {
    linkedAccountId: "111122223333", billingPeriod: "2026-07", invoiceId: "invoice-9001",
    productCode: "prod-sec", productName: "Sentinel Threat Feed", sellerName: "Sentinel Security",
    chargeCategory: "subscription", currency: "USD",
    billedAmountMicros: "1234567890", amortizedAmountMicros: "1200000000",
  },
  {
    linkedAccountId: "444455556666", billingPeriod: "2026-07", invoiceId: null,
    productCode: null, productName: "Atlas Data Exchange", sellerName: "Atlas Data",
    chargeCategory: "usage", currency: "USD",
    billedAmountMicros: "450000000", amortizedAmountMicros: null,
  },
  {
    linkedAccountId: "111122223333", billingPeriod: "2026-07", invoiceId: "invoice-9001",
    productCode: "prod-sec", productName: "Sentinel Threat Feed", sellerName: "Sentinel Security",
    chargeCategory: "credit", currency: "USD",
    billedAmountMicros: "-65432110", amortizedAmountMicros: null,
  },
  {
    linkedAccountId: "777788889999", billingPeriod: "2026-06", invoiceId: "invoice-8800",
    productCode: "prod-eu", productName: "Helios Advisory", sellerName: "Helios Partners",
    chargeCategory: "refund", currency: "EUR",
    billedAmountMicros: "-24000000", amortizedAmountMicros: null,
  },
];

const REPORT = {
  schema: "sutra.finops-marketplace-spg-dashboard.v1",
  connectionId: `conn_${"a".repeat(32)}`,
  sourceState: "partial",
  dashboard: {
    filters: { accountId: null, product: null, seller: null, currency: null, billingPeriod: null, agreementStatus: null, expirationState: null, licenseStatus: null },
    filterOptions: {
      accounts: ["111122223333", "444455556666", "777788889999"],
      products: ["Atlas Data Exchange", "Helios Advisory", "Sentinel Threat Feed"],
      sellers: ["Atlas Data", "Helios Partners", "Sentinel Security"],
      currencies: ["EUR", "USD"],
      periods: ["2026-07", "2026-06"],
    },
    summaries: [
      { currency: "EUR", billedAmountMicros: "-24000000", amortizedAmountMicros: null, rowCount: 1 },
      { currency: "USD", billedAmountMicros: "1619135780", amortizedAmountMicros: "1200000000", rowCount: 3 },
    ],
    trends: [
      { billingPeriod: "2026-06", currency: "EUR", billedAmountMicros: "-24000000", amortizedAmountMicros: null, rowCount: 1 },
      { billingPeriod: "2026-06", currency: "USD", billedAmountMicros: "900000000", amortizedAmountMicros: "880000000", rowCount: 2 },
      { billingPeriod: "2026-07", currency: "USD", billedAmountMicros: "1619135780", amortizedAmountMicros: null, rowCount: 3 },
    ],
    spendBySeller: [
      ranked("Sentinel Security", "USD", "1169135780", "1200000000", 2),
      ranked("Atlas Data", "USD", "450000000", null, 1),
      ranked("Helios Partners", "EUR", "-24000000", null, 1),
    ],
    spendByProduct: [
      ranked("Sentinel Threat Feed", "USD", "1169135780", "1200000000", 2),
      ranked("Atlas Data Exchange", "USD", "450000000", null, 1),
      ranked("Helios Advisory", "EUR", "-24000000", null, 1),
    ],
    spendByAccount: [
      ranked("111122223333", "USD", "1169135780", "1200000000", 2),
      ranked("444455556666", "USD", "450000000", null, 1),
      ranked("777788889999", "EUR", "-24000000", null, 1),
    ],
    spendByInvoice: [
      ranked("invoice-9001", "USD", "1169135780", "1200000000", 2),
      ranked("INVOICE_NOT_SUPPLIED", "USD", "450000000", null, 1),
      ranked("invoice-8800", "EUR", "-24000000", null, 1),
    ],
    agreementDeployment: [
      { status: "DEPLOYED", activeAgreementCount: 1, lifecycleCommitments: [{ currency: "USD", amountMicros: "24000000000" }] },
      { status: "METADATA_UNAVAILABLE", activeAgreementCount: 1, lifecycleCommitments: [] },
    ],
    agreementChargesByMonth: [
      { month: "2026-06", currency: "USD", amountMicros: "2000000000" },
      { month: "2026-07", currency: "USD", amountMicros: "2000000000" },
    ],
    licenseExpirationSummary: [
      { state: "EXPIRING_60_DAYS", count: 1 },
      { state: "NO_END_DATE", count: 1 },
    ],
    licenseStatusSummary: [
      { status: "AVAILABLE", count: 1 },
      { status: "SUSPENDED", count: 1 },
    ],
    licenseProductSummary: [
      { productName: "Sentinel Threat Feed", count: 1 },
      { productName: "Atlas Data Exchange", count: 1 },
    ],
    projectionTruncation: { filterOptions: false, spendRankings: false, agreementCharges: false, licenseProducts: true },
    agreements: [
      {
        agreementId: "agmt-0001", sourceAccountId: "111122223333", status: "ACTIVE",
        acceptanceAt: "2026-01-15T09:00:00.000Z", startAt: "2026-01-15T00:00:00.000Z",
        endAt: "2026-09-20T00:00:00.000Z", offerId: "offer-4411", productId: "prod-sec",
        expirationState: "EXPIRING_60_DAYS",
        estimatedCharges: { amountMicros: "24000000000", currency: "USD", meaning: "KNOWN_LIFECYCLE_COMMITMENT_NOT_USAGE_ACTUAL" },
        product: {
          productName: "Sentinel Threat Feed", sellerDisplayName: "Sentinel Security",
          deployedOnAws: "DEPLOYED", fulfillmentTypes: ["SAAS"],
          approvedProductType: "SOFTWARE", approvedProductTypeEvidenceId: "taxonomy-evidence-1",
        },
        terms: [
          { type: "LEGAL", legalDocumentTypes: ["CustomEula"], autoRenew: null, committedAmountMicros: null, pricingCurrency: null },
          { type: "RENEWAL", legalDocumentTypes: [], autoRenew: true, committedAmountMicros: "24000000000", pricingCurrency: "USD" },
        ],
        entitlements: [{ type: "License", status: "PROVISIONED", resourceType: "SaaS" }],
        charges: [
          { chargeId: "charge-1", chargeAt: "2026-07-01T00:00:00.000Z", money: { amount: "2000.000000", currencyCode: "USD" } },
          { chargeId: "charge-2", chargeAt: null, money: { amount: "-125.50", currencyCode: "USD" } },
        ],
      },
      {
        agreementId: "agmt-0002", sourceAccountId: "444455556666", status: "ACTIVE",
        acceptanceAt: null, startAt: null, endAt: null, offerId: null, productId: "prod-data",
        expirationState: "NO_END_DATE", estimatedCharges: null,
        product: {
          productName: "Atlas Data Exchange", sellerDisplayName: "Atlas Data",
          deployedOnAws: "NOT_APPLICABLE", fulfillmentTypes: [],
          approvedProductType: null, approvedProductTypeEvidenceId: null,
        },
        terms: [],
        entitlements: [],
        charges: [],
      },
    ],
    agreementsTruncated: false,
    licenses: [
      {
        licenseArn: "arn:aws:license-manager:us-east-1:111122223333:license:l-1",
        beneficiaryAccountId: "111122223333", productName: "Sentinel Threat Feed",
        licenseName: "Annual subscription", status: "AVAILABLE",
        validity: { startAt: "2026-01-15T00:00:00.000Z", endAt: "2026-09-20T00:00:00.000Z" },
        entitlements: [{ name: "Seats", unit: "Count", value: null, maxCount: "250", overageAllowed: false }],
      },
      {
        licenseArn: "arn:aws:license-manager:us-east-1:444455556666:license:l-2",
        beneficiaryAccountId: "444455556666", productName: "Atlas Data Exchange",
        licenseName: "Perpetual entitlement", status: "SUSPENDED", validity: null,
        entitlements: [],
      },
    ],
    licensesTruncated: false,
    grants: [{
      grantArn: "arn:aws:license-manager:us-east-1:111122223333:grant:g-1",
      licenseArn: "arn:aws:license-manager:us-east-1:111122223333:license:l-1",
      granteeAccountId: "444455556666", status: "ACTIVE", operations: ["CheckoutLicense", "ExtendConsumptionLicense"],
    }],
    grantsTruncated: false,
    spendRows: SPEND_ROWS,
    spendRowsTruncated: true,
    counts: {
      agreements: 2, expiringWithin90Days: 1, licenses: 2, grants: 1, activeGrants: 1, spendRows: 4,
    },
  },
  officialDefinition: DEFINITION,
  history: [{
    generationId: `mspg_${"d".repeat(64)}`, capturedAt: "2026-08-01T00:00:00.000Z", state: "READY",
    agreementCount: 2, licenseCount: 2, grantCount: 1, spendRowCount: 4, spendSummaries: [],
  }],
  source: {
    organizationCoverage: "PARTIAL",
    channelStates: { agreements: "READY", licenses: "PARTIAL", spend: "READY" },
    limitations: ["Buyer-side agreement evidence only; seller reports are out of scope."],
  },
  freshness: { dataThroughAt: "2026-07-31T00:00:00.000Z", ageHours: 26.5, staleAfterHours: 48 },
  provenance: {
    generationId: `mspg_${"d".repeat(64)}`, activeGenerationId: `mspg_${"d".repeat(64)}`,
    latestGenerationId: `mspg_${"e".repeat(64)}`, newerIncomplete: true,
    captureId: `marketplace_${"f".repeat(64)}`, contentSha256: "d".repeat(64),
    cur2GenerationId: `fbg_${"b".repeat(64)}`, cur2SourceEvidenceId: "aws-data-export:1",
    cur2Predicate: "CUR2_BILLING_ENTITY_AWS_MARKETPLACE",
  },
  separation: {
    realizedSpendSource: "ACTIVE_RECONCILED_CUR2_ONLY",
    agreementsLicensesAndGrantsSource: "AWS_MARKETPLACE_CONTROL_PLANE",
    crossSourceEntitlementInference: false,
    agreementEstimatedChargesMeaning: "KNOWN_LIFECYCLE_COMMITMENT_NOT_USAGE_ACTUAL",
  },
  collection: {
    jobContractAvailable: true, providerAdapterAvailable: true, state: "ready",
    reason: "MARKETPLACE_SIGNED_BROKER_ADAPTER_BOUND", lastAttemptAt: "2026-08-01T00:00:00.000Z",
  },
  unsupportedOfficialViews: [
    "Offer classification as public self-service versus private offer is not supplied by the current buyer evidence contract.",
  ],
};

const FILTERS = {
  accountId: "", product: "", seller: "", currency: "", billingPeriod: "",
  agreementStatus: "", expirationState: "", licenseStatus: "",
};

const tabHtml = (id) => render(marketplace.MarketplaceSpgTabPanel, {
  report: REPORT,
  tab: DEFINITION.tabs.find((tab) => tab.id === id),
});

test("the pinned catalog really is five tabs and twenty-three documented areas", () => {
  assert.equal(DEFINITION.tabs.length, 5);
  assert.equal(DEFINITION.documentedTabCount, 5);
  assert.equal(
    DEFINITION.tabs.reduce((total, tab) => total + tab.areas.length, 0),
    DEFINITION.documentedVisualAreaCount,
  );
  assert.equal(DEFINITION.documentedVisualAreaCount, 23);
});

test("every official tab renders substantive content and no tab is silently blank", () => {
  for (const tab of DEFINITION.tabs) {
    const html = tabHtml(tab.id);
    assert.ok(html.length > 400, `${tab.label} rendered almost nothing`);
    const informative = html.includes("<table") || html.includes("role=\"img\"")
      || html.includes("role=\"status\"");
    assert.ok(informative, `${tab.label} rendered no recognizable content`);
  }
});

test("the full view exposes all five tabs and all twenty-three documented areas", () => {
  const html = render(marketplace.MarketplaceSpgDashboardView, { report: REPORT });
  for (const [index, tab] of DEFINITION.tabs.entries()) {
    assert.ok(html.includes(`Official tab ${index + 1} of 5`), `${tab.label} header missing`);
    assert.ok(html.includes(`id="marketplace-${tab.id}"`), `${tab.label} anchor missing`);
  }
  for (const tab of DEFINITION.tabs) {
    for (const area of tab.areas) {
      assert.ok(html.includes(area.name), `documented area ${area.name} is not disclosed`);
    }
  }
  // Unpublished QuickSight geometry is stated as unavailable, never invented.
  assert.ok(html.includes("official visual count unavailable"));
  assert.equal(/\d+ official visuals/u.test(html), false);
});

test("money prints as exact micro-units and negative amounts keep their sign", () => {
  const summary = tabHtml("spend-summary");
  // 1619135780 micros is exactly USD 1,619.13578 — no rounding to cents.
  assert.ok(summary.includes("1,619.13578"), "exact micro amount must be printed in full");
  // A refund stays negative, with the unicode minus the exact formatter uses.
  assert.ok(summary.includes("−EUR 24.00"), "a negative billed amount must keep its sign");
  assert.equal(
    (summary.match(/EUR 24\.00/gu) ?? []).length,
    (summary.match(/−EUR 24\.00/gu) ?? []).length,
    "every rendering of the refund must carry its minus sign",
  );
  // A credit row survives into the deep-dive drilldown with its sign.
  const deepDive = tabHtml("spend-deep-dive");
  assert.ok(deepDive.includes("−USD 65.43211"), "the credit magnitude and sign must be exact");
});

test("absent amortized cost is a labelled state, never a zero", () => {
  const summary = tabHtml("spend-summary");
  assert.ok(summary.includes("Not supplied by CUR2"), "a missing amortized amount must say so");
  assert.equal(summary.includes(">USD 0.00<"), false, "absence must not be rendered as zero money");
  assert.ok(
    summary.includes("Usage quantity and unit are unavailable"),
    "the audited PARTIAL usage gap must be disclosed",
  );
  assert.ok(summary.includes("Not in projection"));
});

test("a share that is not a fact is withheld with its reason", () => {
  const summary = tabHtml("spend-summary");
  // EUR holds only a refund, so no proportion of the currency total exists.
  assert.ok(summary.includes("Share is withheld for EUR"), "a withheld share must be explained");
  assert.ok(
    summary.includes("a negative part is not a share of a whole")
    || summary.includes("the filtered currency total is not positive"),
    "the withholding reason must be stated",
  );
  assert.ok(summary.includes("Withheld"), "the withheld share cell must be labelled");
  // USD is positive, so its exact basis-point share is shown.
  assert.ok(summary.includes("72.20%") || summary.includes("27.79%"), "a computable share must be exact");
});

test("CUR2 realized spend and control-plane commitment are never merged", () => {
  const view = render(marketplace.MarketplaceSpgDashboardView, { report: REPORT });
  assert.ok(view.includes("Two evidence planes, never conflated."));
  assert.ok(view.includes("never summed with realized spend"));

  const agreements = tabHtml("marketplace-agreements");
  // The commitment is exact and carries its meaning, never presented as spend.
  assert.ok(agreements.includes("24,000.00"), "known commitment must be exact");
  assert.ok(agreements.includes("Known lifecycle commitment, not usage actual and not an invoice"));
  assert.ok(agreements.includes("not CUR2 realized spend") || agreements.includes("never added to"));
  // Agreement charge amounts are supplied as decimals and are not converted.
  assert.ok(agreements.includes("2000.000000"), "the supplied decimal amount must be verbatim");
  assert.ok(agreements.includes("-125.50"), "a negative supplied charge keeps its sign");
  // No plane-crossing total exists: the CUR2 total never appears on the agreements tab.
  assert.equal(agreements.includes("1,619.13578"), false, "CUR2 spend must not appear as agreement evidence");
});

test("Bedrock third-party model classification reads as unavailable and is never simulated", () => {
  const html = tabHtml("bedrock-3p-foundational-model-spend");
  assert.ok(html.includes("Authoritative classification required"));
  assert.ok(html.includes("Bedrock third-party model classification is unavailable"));
  assert.ok(html.includes("Bedrock-powered classification is not available in this vertical"));
  assert.ok(html.includes("does not simulate the classification"));
  assert.ok(html.includes("UNAVAILABLE"), "the audited support classification must be shown");
  // No spend figure is presented under a classification nothing proves.
  assert.equal(html.includes("1,619.13578"), false, "no spend may be attributed to a model class");
  assert.equal(/simulated spend|estimated share|inferred classification/iu.test(html), false);
});

test("missing control-plane evidence is proven absence rather than zero", () => {
  const empty = {
    ...REPORT,
    sourceState: "empty",
    dashboard: {
      ...REPORT.dashboard,
      summaries: [], trends: [], spendBySeller: [], spendByProduct: [], spendByAccount: [],
      spendByInvoice: [], spendRows: [], spendRowsTruncated: false,
      agreementDeployment: [], agreementChargesByMonth: [], agreements: [],
      licenses: [], grants: [], licenseExpirationSummary: [], licenseStatusSummary: [],
      licenseProductSummary: [],
      counts: { agreements: 0, expiringWithin90Days: 0, licenses: 0, grants: 0, activeGrants: 0, spendRows: 0 },
    },
  };
  const spend = render(marketplace.MarketplaceSpgTabPanel, {
    report: empty, tab: DEFINITION.tabs.find((tab) => tab.id === "spend-summary"),
  });
  assert.ok(spend.includes("No CUR2 spend in the current filter"));
  assert.ok(spend.includes("not a zero invoice"));

  const licenses = render(marketplace.MarketplaceSpgTabPanel, {
    report: empty, tab: DEFINITION.tabs.find((tab) => tab.id === "granted-entitled-licenses"),
  });
  assert.ok(licenses.includes("No license validity evidence"));
  assert.ok(licenses.includes("No sharing grant evidence"));
  assert.ok(licenses.includes("not proof that sharing is disabled"));

  const agreements = render(marketplace.MarketplaceSpgTabPanel, {
    report: empty, tab: DEFINITION.tabs.find((tab) => tab.id === "marketplace-agreements"),
  });
  assert.ok(agreements.includes("No commitment evidence supplied"));
  assert.ok(agreements.includes("not a commitment of zero"));
});

test("licenses, grants and their product mapping render real control-plane evidence", () => {
  const html = tabHtml("granted-entitled-licenses");
  assert.ok(html.includes("Received licenses and entitlements"));
  assert.ok(html.includes("Seats: 250 Count"), "an entitlement limit must be shown as supplied");
  assert.ok(html.includes("No validity window supplied"), "a missing validity window must be labelled");
  assert.ok(html.includes("License sharing grants"));
  assert.ok(html.includes("CheckoutLicense"));
  assert.ok(html.includes("No grant references this license"), "an unmapped license must say so");
  // License expiry and agreement expiry are counted separately, never added.
  assert.ok(html.includes("never added together"));
  assert.ok(html.includes("deterministically bounded"), "the bounded product summary must be disclosed");
});

test("the approved product taxonomy is shown without inference", () => {
  const html = tabHtml("marketplace-agreements");
  for (const type of ["SOFTWARE", "DATA", "PROFESSIONAL SERVICES"]) {
    assert.ok(html.includes(type), `${type} must appear in the approved taxonomy`);
  }
  assert.ok(html.includes("NOT BOUND TO APPROVED TAXONOMY"));
  assert.ok(html.includes("not bound to the approved taxonomy and stay explicitly untyped"));
  assert.ok(html.includes("approved type not bound"), "an untyped product must be labelled in the table");
  assert.ok(html.includes("never inferred from a product or seller name"));
});

test("the container view keeps its filter controls and its evidence disclosure", () => {
  const html = render(marketplace.MarketplaceSpgReportView, {
    report: REPORT, filters: FILTERS, onFiltersChange: () => undefined,
  });
  assert.ok(html.includes("Marketplace procurement filters"));
  assert.equal((html.match(/<select/gu) ?? []).length, 8);
  assert.ok(html.includes("Export visible CUR2 rows"));
  // Provenance, separation, history and named limitations stay inspectable.
  assert.ok(html.includes("Unsupported official dimensions"));
  assert.ok(html.includes("CUR2_BILLING_ENTITY_AWS_MARKETPLACE".replaceAll("_", " ")));
  assert.ok(html.includes("ACTIVE RECONCILED CUR2 ONLY"));
  assert.ok(html.includes("Buyer-side agreement evidence only; seller reports are out of scope."));
  // A newer incomplete collection is disclosed rather than shown as the head.
  assert.ok(html.includes("newer incomplete collection is disclosed"));
});

test("the official definition panel states what the AWS source does not publish", () => {
  const html = render(marketplace.MarketplaceSpgOfficialDefinitionPanel, { definition: DEFINITION });
  assert.ok(html.includes("5 tabs"));
  assert.ok(html.includes("23 documented visual areas"));
  assert.ok(html.includes("not disclosed in immutable source"));
  assert.ok(html.includes("counts are unavailable rather than estimated"));
  assert.ok(html.includes("Frozen source coverage remains visible"));
});
