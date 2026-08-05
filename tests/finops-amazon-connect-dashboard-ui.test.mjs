import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * ADD-11 Amazon Connect Cost Insights UI.
 *
 * Renders every one of the eight official sheets against a realistic report and
 * asserts the honesty rules hold: exact micro-unit money is printed, negative
 * amounts keep their sign, absent evidence is a labelled state rather than a
 * zero, a share that cannot be computed exactly is withheld with its reason,
 * the unpublished `resource_connect_view` contract stays unpublished, and no raw
 * phone number, contact id or HMAC token can leak into the markup.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const view = await vite.ssrLoadModule("/app/costs/finops-amazon-connect-cost-insights-dashboard.tsx");
const definitionModule = await vite.ssrLoadModule("/lib/finops-amazon-connect-official-definition.ts");
after(async () => vite.close());

const OFFICIAL = definitionModule.AMAZON_CONNECT_OFFICIAL_DEFINITION;
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const GENERATION_ID = `acig_${"d".repeat(64)}`;

const render = (component, props) => renderToStaticMarkup(createElement(component, props));

const EMPTY_FILTERS = {
  instanceAlias: "", service: "", chargeFamily: "", channel: "", direction: "",
  countryCode: "", phoneNumberType: "", usageUnit: "",
};

/** A realistic report: two instances, credits, an unattributed slice, mixed units. */
const REPORT = {
  schema: "sutra.finops-amazon-connect-cost-insights-dashboard.v1",
  connectionId: CONNECTION_ID,
  sourceState: "partial",
  officialDefinition: OFFICIAL,
  dashboard: {
    filters: {},
    window: { days: 30, startDay: "2026-07-02", endDay: "2026-07-31" },
    filterOptions: {
      instanceAliases: ["support-prod", "sales-prod"],
      services: ["AMAZON_CONNECT", "CONTACT_CENTER_TELECOM"],
      chargeFamilies: ["TELEPHONY_INBOUND", "TELEPHONY_OUTBOUND", "PHONE_NUMBER", "CHAT"],
      channels: ["VOICE", "CHAT"],
      directions: ["INBOUND", "OUTBOUND"],
      countries: ["US", "GB"],
      phoneNumberTypes: ["DID", "TOLL_FREE"],
      usageUnits: ["Minutes", "Numbers"],
    },
    overview: {
      instanceCount: 2,
      phoneNumberCount: 34,
      costMicros: "8123456789",
      unattributedCostMicros: "1123456789",
      usageRowCount: 512,
      tokenizedContactCount: 4821,
    },
    instances: [
      {
        instanceLabel: "support-prod", status: "ACTIVE", inboundCallsEnabled: true,
        outboundCallsEnabled: true, observedAtIso: "2026-07-31T11:00:00.000Z",
        phoneNumberCount: 22, costMicros: "5000000123",
      },
      {
        instanceLabel: "sales-prod", status: "ACTIVE", inboundCallsEnabled: false,
        outboundCallsEnabled: true, observedAtIso: "2026-07-31T11:00:00.000Z",
        phoneNumberCount: 12, costMicros: "1999999877",
      },
    ],
    telecom: [
      {
        countryCode: "US", phoneNumberType: "DID", direction: "INBOUND", rowCount: 210,
        costMicros: "3210000000", quantityMicros: "84000000000", unit: "Minutes",
      },
      {
        countryCode: "GB", phoneNumberType: "TOLL_FREE", direction: "OUTBOUND", rowCount: 44,
        costMicros: "980500000", quantityMicros: "12500000000", unit: "Minutes",
      },
      {
        countryCode: null, phoneNumberType: null, direction: "UNKNOWN", rowCount: 4,
        costMicros: "-45500000", quantityMicros: "0", unit: null,
      },
    ],
    dailyUsage: [
      {
        day: "2026-07-29", service: "CONTACT_CENTER_TELECOM", chargeFamily: "TELEPHONY_INBOUND",
        channel: "VOICE", direction: "INBOUND", usageType: "Inbound-Minutes", rowCount: 30,
        costMicros: "1200000000", quantityMicros: "36000000000", unit: "Minutes",
      },
      {
        day: "2026-07-30", service: "CONTACT_CENTER_TELECOM", chargeFamily: "TELEPHONY_OUTBOUND",
        channel: "VOICE", direction: "OUTBOUND", usageType: "Outbound-Minutes", rowCount: 26,
        costMicros: "980500000", quantityMicros: "18000000000", unit: "Minutes",
      },
      {
        day: "2026-07-31", service: "AMAZON_CONNECT", chargeFamily: "PHONE_NUMBER",
        channel: "VOICE", direction: "UNKNOWN", usageType: null, rowCount: 34,
        costMicros: "68000000", quantityMicros: "34000000", unit: "Numbers",
      },
      {
        day: "2026-07-31", service: "AMAZON_CONNECT", chargeFamily: "CHAT",
        channel: "CHAT", direction: "UNKNOWN", usageType: "Chat-Messages", rowCount: 12,
        costMicros: "-45500000", quantityMicros: "5000000", unit: null,
      },
    ],
    callPatterns: [
      {
        instanceLabel: "support-prod", channel: "VOICE", direction: "INBOUND",
        countryCode: "US", phoneNumberType: "DID", contactCount: 3900,
        costMicros: "3210000000", quantityMicros: "84000000000", unit: "Minutes",
      },
      {
        instanceLabel: "Unattributed", channel: "VOICE", direction: "TRANSFER",
        countryCode: null, phoneNumberType: null, contactCount: 921,
        costMicros: "121000000", quantityMicros: "1500000000", unit: null,
      },
    ],
    phoneInventory: [
      {
        instanceLabel: "support-prod", countryCode: "US", phoneNumberType: "DID",
        status: "CLAIMED", count: 22,
      },
      {
        instanceLabel: "sales-prod", countryCode: "GB", phoneNumberType: "TOLL_FREE",
        status: "IN_PROGRESS", count: 12,
      },
    ],
    privacySafeContactDetails: [
      {
        instanceLabel: "support-prod", channel: "VOICE", direction: "INBOUND",
        countryCode: "US", phoneNumberType: "DID", distinctTokenizedContactCount: 3900,
        totalCostMicros: "3210000000", totalUsageMicros: "84000000000", unit: "Minutes",
        detailLevel: "AGGREGATED_TOKEN_COUNTS_ONLY",
      },
      {
        instanceLabel: "Unattributed", channel: "VOICE", direction: "TRANSFER",
        countryCode: null, phoneNumberType: null, distinctTokenizedContactCount: 921,
        totalCostMicros: "121000000", totalUsageMicros: "1500000000", unit: null,
        detailLevel: "AGGREGATED_TOKEN_COUNTS_ONLY",
      },
    ],
    limitations: [
      "Supporting AWS-service spend in Connect-enabled accounts is not collected.",
      "Raw contact identifiers and phone numbers are forbidden end to end.",
    ],
  },
  history: [
    {
      generationId: GENERATION_ID, completedAtIso: "2026-07-31T12:00:00.000Z", state: "current",
      instanceCount: 2, phoneAggregateCount: 2, costRowCount: 512, currency: "USD",
      costBasis: "NET_AMORTIZED",
    },
    {
      generationId: `acig_${"c".repeat(64)}`, completedAtIso: "2026-07-30T12:00:00.000Z",
      state: "superseded", instanceCount: 2, phoneAggregateCount: 2, costRowCount: 498,
      currency: "USD", costBasis: "NET_AMORTIZED",
    },
  ],
  freshness: { dataThroughAt: "2026-07-31T11:00:00.000Z", ageHours: 3.25, staleAfterHours: 48 },
  provenance: {
    generationId: GENERATION_ID,
    activeGenerationId: GENERATION_ID,
    latestGenerationId: `acig_${"e".repeat(64)}`,
    newerIncomplete: true,
    captureId: `connect_${"f".repeat(64)}`,
    billingGenerationId: `fbg_${"1".repeat(64)}`,
    billingManifestSha256: "2".repeat(64),
    costBasis: "NET_AMORTIZED",
    currency: "USD",
  },
  privacy: {
    rawPhoneNumbersReturned: false, rawContactIdsReturned: false, contactTokensReturned: false,
    callerPiiReturned: false, standardUiDetailLevel: "AGGREGATED_TOKEN_COUNTS_ONLY",
    privilegedTokenLookupRouteAvailable: false,
  },
  collection: {
    jobContractAvailable: true, providerAdapterAvailable: true, state: "ready",
    reason: "AMAZON_CONNECT_RUNTIME_ACCEPTED_GENERATION",
    lastAttemptAt: "2026-07-31T12:00:00.000Z", acceptedGenerationId: GENERATION_ID,
  },
};

/** The same report with every evidence array emptied and no positive total. */
const EMPTY_REPORT = {
  ...REPORT,
  sourceState: "empty",
  dashboard: {
    ...REPORT.dashboard,
    overview: {
      instanceCount: 0, phoneNumberCount: 0, costMicros: "0", unattributedCostMicros: "0",
      usageRowCount: 0, tokenizedContactCount: 0,
    },
    instances: [],
    telecom: [],
    dailyUsage: [],
    callPatterns: [],
    phoneInventory: [],
    privacySafeContactDetails: [],
  },
};

const sheetKeys = [
  "overview", "contact-center", "connect", "telecom",
  "daily-usage", "call-details", "contact-search", "about",
];

function descriptors() {
  return OFFICIAL.sheets.map((sheet) => ({
    key: sheet.name.trim().toLowerCase().replace(/[^a-z0-9]+/gu, "-"),
    name: sheet.name,
    visualCount: sheet.visualCount,
    controlCount: sheet.parameterControls.length + sheet.filterControls.length,
    support: sheet.nativeCoverage === "SUPPORTED" ? "SUPPORTED" : "PARTIAL",
    supportLabel: sheet.nativeCoverage,
    gaps: [sheet.remainingGap],
    formulaIds: [],
    controls: [...sheet.parameterControls, ...sheet.filterControls],
    evidence: sheet.nativeEvidence,
  }));
}

test("every official sheet renders its own content, coverage and audited gap", () => {
  const sheets = descriptors();
  assert.equal(sheets.length, 8);
  assert.deepEqual(sheets.map((sheet) => sheet.key), sheetKeys);

  for (const sheet of sheets) {
    const html = render(view.AmazonConnectCostInsightsSheetContent, { report: REPORT, sheet });
    assert.ok(html.length > 200, `${sheet.name} rendered no substantial content`);
    // No sheet falls through to the "no native projection" default.
    assert.doesNotMatch(html, /no native projection/u);

    const coverage = render(view.AmazonConnectCostInsightsSheets, { report: REPORT });
    const gap = sheet.gaps[0];
    assert.match(coverage, new RegExp(gap.slice(0, 40).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(coverage, new RegExp(sheet.supportLabel, "u"));
  }
});

test("all eight sheets, their visual and control totals, appear in one presentational pass", () => {
  const html = render(view.AmazonConnectCostInsightsSheets, { report: REPORT });
  for (const sheet of OFFICIAL.sheets) {
    assert.match(html, new RegExp(`${sheet.name} sheet`, "u"));
    assert.match(html, new RegExp(`${sheet.visualCount} official visual`, "u"));
  }
  assert.match(html, /<b>8<\/b> official sheets/u);
  assert.match(html, /<b>121<\/b> visuals/u);
  assert.match(html, /<b>61<\/b>\s*controls/u);
  // Coverage never upgrades: Contact Center stays UNAVAILABLE, About stays ABOUT.
  assert.match(html, /UNAVAILABLE/u);
  assert.match(html, /ABOUT/u);
});

test("money is exact integer micro-units and negative amounts keep their sign", () => {
  const html = render(view.AmazonConnectCostInsightsSheets, { report: REPORT });
  // 8123456789 micros = USD 8,123.456789 exactly, with no rounding anywhere.
  assert.match(html, /USD 8,123\.456789/u);
  assert.match(html, /USD 1,123\.456789/u);
  assert.match(html, /USD 5,000\.000123/u);
  // Credits keep their sign with the exact formatter's unicode minus.
  assert.match(html, /−USD 45\.50/u);
  // Usage quantities are the source unit, never money.
  assert.match(html, /84,000 Minutes/u);
  assert.match(html, /34 Numbers/u);
  assert.match(html, /\(unit not supplied\)/u);
  assert.doesNotMatch(html, /USD 84,000/u);
});

test("withheld percentages are explained and exact shares are basis-point derived", () => {
  const html = render(view.AmazonConnectCostInsightsSheets, { report: REPORT });
  // 1123456789 / 8123456789 = 1382.6… basis points, truncated to 1382 rather than
  // rounded up, so the share can never overstate the unattributed slice.
  assert.match(html, /13\.82% of the period total/u);

  const withheld = render(view.AmazonConnectCostInsightsSheets, { report: EMPTY_REPORT });
  assert.match(withheld, /Share withheld: the period total is not a positive amount/u);
  assert.match(withheld, /composition is withheld/u);
});

test("absent evidence is a labelled state and never a zero", () => {
  const html = render(view.AmazonConnectCostInsightsSheets, { report: EMPTY_REPORT });
  assert.match(html, /Evidence unavailable for this sheet/u);
  assert.match(html, /not a zero bill/u);
  assert.match(html, /unavailable for the window, not zero/u);
  assert.match(html, /not a window of zeros/u);
  assert.match(html, /unavailable rather than zero/u);
  assert.match(html, /it is not evidence that no contact occurred/u);
  // The unavailable-by-contract sheet says why, and no supporting-service cost is invented.
  assert.match(html, /broader evidence plane is not configured/u);
});

test("the unpublished resource_connect_view contract is disclosed, never fabricated", () => {
  const html = render(view.AmazonConnectCostInsightsSheets, { report: REPORT });
  assert.match(html, /resource_connect_view/u);
  assert.match(html, /Not published at the pinned commit/u);
  assert.match(html, /summary_view/u);
  assert.match(html, /cid\/builtin\/core\/data\/queries\/cid\/summary_view\.sql/u);
  // The pinned hashes travel with the claim.
  assert.match(html, new RegExp(OFFICIAL.source.embeddedDefinitionSha256, "u"));
  assert.match(html, new RegExp(OFFICIAL.source.commit, "u"));
});

test("lineage, freshness and the newer incomplete attempt are disclosed", () => {
  const html = render(view.AmazonConnectCostInsightsSheets, { report: REPORT });
  assert.match(html, new RegExp(REPORT.provenance.activeGenerationId, "u"));
  assert.match(html, new RegExp(REPORT.provenance.billingGenerationId, "u"));
  assert.match(html, /A newer incomplete attempt exists and is disclosed, not activated/u);
  assert.match(html, /2026-07-31T11:00:00\.000Z/u);
  assert.match(html, /3\.25 hours old · stale after 48/u);
  assert.match(html, /NET AMORTIZED/u);
});

test("no raw phone number, contact identifier or HMAC token can leak", () => {
  const full = render(view.AmazonConnectCostInsightsReportView, {
    report: REPORT, filters: EMPTY_FILTERS, onFiltersChange: () => undefined,
  });
  // Tokens and raw endpoints in any of the shapes the collector can produce.
  assert.doesNotMatch(full, /ctk_[a-f0-9]{16}|epk_[a-f0-9]{16}/u);
  // E.164 and North American dialling forms.
  assert.doesNotMatch(full, /\+\d{7,15}/u);
  assert.doesNotMatch(full, /\b\d{3}-\d{3}-\d{4}\b/u);
  assert.doesNotMatch(full, /\(\d{3}\)\s?\d{3}-\d{4}/u);
  // The boundary is stated, not assumed.
  assert.match(full, /Phone numbers, raw contact IDs, HMAC tokens, caller identity/u);
  assert.match(full, /Never returned/u);
  assert.match(full, /Privileged exact-token lookup is disabled/u);
  assert.match(full, /tokens hidden/u);
  assert.match(full, /Distinct tokenized contacts/u);
  // Contact counts are counts, and country is not represented as caller location.
  assert.match(full, /Billing country/u);
  assert.match(full, /not caller location/u);
});

test("the container export and its props signature are preserved", () => {
  assert.equal(typeof view.FinopsAmazonConnectCostInsightsDashboard, "function");
  assert.equal(typeof view.AmazonConnectCostInsightsReportView, "function");
  assert.equal(typeof view.AmazonConnectOfficialDefinitionPanel, "function");
  assert.equal(typeof view.AmazonConnectCostInsightsSheets, "function");
  assert.equal(typeof view.AmazonConnectCostInsightsSheetContent, "function");
  const configuration = render(view.AmazonConnectOfficialDefinitionPanel, {
    definition: OFFICIAL,
  });
  assert.match(configuration, /Official AWS definition coverage/u);
  assert.match(configuration, /8 sheets · 121 visuals · 61 controls/u);
});
