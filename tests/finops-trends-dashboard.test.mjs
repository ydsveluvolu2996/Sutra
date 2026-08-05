import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * Renders every documented feature area of ADD-09 Trends against a realistic
 * `/api/v1/finops/trends` envelope and asserts the honesty rules hold:
 *
 * - money prints as exact micro-units and a credit keeps its negative sign,
 * - a period with no collected evidence is a gap, never a zero,
 * - a percentage the engine refused to compute is explained, not printed,
 * - an exact rational percentage is not inflated by a factor of one hundred,
 * - QuickSight ML forecasting, the geospatial map and QuickSight automation are
 *   stated as unavailable rather than simulated,
 * - no QuickSight sheet or visual count is invented, because AWS publishes none.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const trends = await vite.ssrLoadModule("/app/costs/finops-trends-dashboard.tsx");
const definitionModule = await vite.ssrLoadModule("/lib/finops-trends-official-definition.ts");
after(async () => vite.close());

const DEFINITION = definitionModule.FINOPS_TRENDS_OFFICIAL_DEFINITION;
const AREAS = DEFINITION.documentedFeatureAreas;

const render = (component, props) => renderToStaticMarkup(createElement(component, props));

const CONNECTION = `conn_${"a".repeat(32)}`;
const GENERATION = (suffix) => `fbg_${suffix.repeat(64)}`;
const UNAVAILABLE = (reason) => ({ available: false, reason });

const CONTRIBUTORS = [
  {
    dimension: "account",
    available: true,
    unavailableReason: null,
    contributors: [
      {
        value: "111122223333",
        currentMicros: "800000000",
        priorMicros: "0",
        deltaMicros: "800000000",
        absoluteMovementShare: { numerator: "8", denominator: "9" },
      },
      {
        value: "444455556666",
        currentMicros: "100000000",
        priorMicros: "200000000",
        deltaMicros: "-100000000",
        absoluteMovementShare: { numerator: "1", denominator: "9" },
      },
    ],
    totalDimensionValues: 2,
    truncated: false,
  },
  {
    dimension: "service",
    available: true,
    unavailableReason: null,
    contributors: [
      {
        value: "AmazonEC2",
        currentMicros: "800000000",
        priorMicros: "0",
        deltaMicros: "800000000",
        absoluteMovementShare: { numerator: "8", denominator: "9" },
      },
      {
        value: null,
        currentMicros: "100000000",
        priorMicros: "200000000",
        deltaMicros: "-100000000",
        absoluteMovementShare: { numerator: "1", denominator: "9" },
      },
    ],
    totalDimensionValues: 3,
    truncated: true,
  },
  {
    dimension: "region",
    available: true,
    unavailableReason: null,
    contributors: [{
      value: "us-east-1",
      currentMicros: "900000000",
      priorMicros: "0",
      deltaMicros: "900000000",
      absoluteMovementShare: { numerator: "1", denominator: "1" },
    }],
    totalDimensionValues: 1,
    truncated: false,
  },
  {
    dimension: "charge_category",
    available: false,
    unavailableReason: "INCOMPLETE_COST_BASIS",
    contributors: [],
    totalDimensionValues: 0,
    truncated: false,
  },
];

const NO_PRIOR_CONTRIBUTORS = CONTRIBUTORS.map((group) => ({
  dimension: group.dimension,
  available: false,
  unavailableReason: "NO_PRIOR_PERIOD",
  contributors: [],
  totalDimensionValues: 0,
  truncated: false,
}));

/** Six months: one is missing entirely, and the month before the last is a real zero. */
const POINTS = (scale) => [
  {
    period: "2026-03",
    periodState: "COMPLETE",
    totalMicros: String(1_000_000_000 * scale),
    contributingRowCount: 400,
    missingCostRowCount: 0,
    costCoverage: "complete",
    monthOverMonth: UNAVAILABLE("NO_PRIOR_PERIOD"),
    trailingAverage: UNAVAILABLE("INSUFFICIENT_CONTIGUOUS_HISTORY"),
    rollingComparison: UNAVAILABLE("INSUFFICIENT_CONTIGUOUS_HISTORY"),
    contributors: NO_PRIOR_CONTRIBUTORS,
    signals: [],
  },
  {
    period: "2026-04",
    periodState: "COMPLETE",
    totalMicros: String(1_200_000_000 * scale),
    contributingRowCount: 410,
    missingCostRowCount: 0,
    costCoverage: "complete",
    monthOverMonth: {
      available: true,
      baselineMicros: String(1_000_000_000 * scale),
      currentMicros: String(1_200_000_000 * scale),
      deltaMicros: String(200_000_000 * scale),
      percent: { numerator: "20", denominator: "1" },
      percentUnavailableReason: null,
    },
    trailingAverage: UNAVAILABLE("INSUFFICIENT_CONTIGUOUS_HISTORY"),
    rollingComparison: UNAVAILABLE("INSUFFICIENT_CONTIGUOUS_HISTORY"),
    contributors: CONTRIBUTORS,
    signals: [],
  },
  {
    // No active generation was ever delivered for this month.
    period: "2026-05",
    periodState: "MISSING",
    totalMicros: null,
    contributingRowCount: 0,
    missingCostRowCount: 0,
    costCoverage: "unavailable",
    monthOverMonth: UNAVAILABLE("MISSING_PERIOD"),
    trailingAverage: UNAVAILABLE("MISSING_PERIOD"),
    rollingComparison: UNAVAILABLE("MISSING_PERIOD"),
    contributors: NO_PRIOR_CONTRIBUTORS,
    signals: [],
  },
  {
    period: "2026-06",
    periodState: "COMPLETE",
    totalMicros: String(1_500_000_000 * scale),
    contributingRowCount: 430,
    missingCostRowCount: 0,
    costCoverage: "complete",
    monthOverMonth: UNAVAILABLE("MISSING_PERIOD"),
    trailingAverage: UNAVAILABLE("MISSING_PERIOD"),
    rollingComparison: UNAVAILABLE("MISSING_PERIOD"),
    contributors: NO_PRIOR_CONTRIBUTORS,
    signals: [],
  },
  {
    // A measured zero: the generation is complete and the bill really was zero.
    period: "2026-07",
    periodState: "COMPLETE",
    totalMicros: "0",
    contributingRowCount: 12,
    missingCostRowCount: 0,
    costCoverage: "complete",
    monthOverMonth: {
      available: true,
      baselineMicros: String(1_500_000_000 * scale),
      currentMicros: "0",
      deltaMicros: String(-1_500_000_000 * scale),
      percent: { numerator: "-100", denominator: "1" },
      percentUnavailableReason: null,
    },
    trailingAverage: UNAVAILABLE("MISSING_PERIOD"),
    rollingComparison: UNAVAILABLE("MISSING_PERIOD"),
    contributors: CONTRIBUTORS,
    signals: [],
  },
  {
    period: "2026-08",
    periodState: "COMPLETE",
    totalMicros: String(900_000_000 * scale),
    contributingRowCount: 450,
    missingCostRowCount: 0,
    costCoverage: "complete",
    // The prior month is a real zero, so a percentage is mathematically undefined.
    monthOverMonth: {
      available: true,
      baselineMicros: "0",
      currentMicros: String(900_000_000 * scale),
      deltaMicros: String(900_000_000 * scale),
      percent: null,
      percentUnavailableReason: "BASELINE_ZERO",
    },
    trailingAverage: {
      available: true,
      windowMonths: 3,
      exactAverageMicros: { numerator: String(2_400_000_001 * scale), denominator: "3" },
    },
    rollingComparison: {
      available: true,
      windowMonths: 3,
      currentWindowStartPeriod: "2026-06",
      currentWindowEndPeriod: "2026-08",
      priorWindowStartPeriod: "2026-03",
      priorWindowEndPeriod: "2026-05",
      currentWindowTotalMicros: String(2_400_000_000 * scale),
      priorWindowTotalMicros: String(2_200_000_000 * scale),
      deltaMicros: String(200_000_000 * scale),
      percent: { numerator: "100", denominator: "11" },
      percentUnavailableReason: null,
    },
    contributors: CONTRIBUTORS,
    signals: [{
      code: "TRAILING_BASELINE_DEVIATION",
      severity: "INFORMATIONAL",
      formula: "abs(currentMicros*3-sum(previous3Micros))*100 >= sum(previous3Micros)*30",
      thresholdPercent: 30,
      // 100/3 percent is 33.33%, not 3333.33%.
      observedPercent: { numerator: "100", denominator: "3" },
      baseline: "PREVIOUS_3_MONTH_AVERAGE",
      explanation:
        "The current total differed from the exact previous-three-month average by at least the pinned 30% review threshold.",
    }],
  },
];

const PERIOD_SUMMARY = (period, state, suffix) => ({
  period,
  state,
  stateReasons: [state],
  loadKind: state === "MISSING" ? null : "ORIGINAL",
  generationId: state === "MISSING" ? null : GENERATION(suffix),
  collectionState: state === "MISSING" ? null : "COMPLETE",
  rowCount: state === "MISSING" ? null : 450,
  rejectedRowCount: state === "MISSING" ? null : 0,
  ageSeconds: state === "MISSING" ? null : 3_600,
  staleAfterSeconds: 129_600,
  lineage: state === "MISSING" ? null : {
    sourceEvidenceId: `active-cur2:${suffix.repeat(64)}`,
    manifestSha256: suffix.repeat(64),
    generationId: GENERATION(suffix),
    sourceUpdatedAtIso: "2026-08-04T22:00:00.000Z",
    observedAtIso: "2026-08-05T00:00:00.000Z",
    committedAtIso: "2026-08-05T00:05:00.000Z",
    activatedAtIso: "2026-08-05T00:05:00.000Z",
    sourceRowCount: 450,
    sourceLineItemIdCount: 450,
    sourceLineItemIds: ["li-1", "li-2"],
    sourceLineItemIdsTruncated: true,
  },
});

const CAPABILITIES = {
  schema: "sutra.finops-trends-capability-closure.v1",
  forecast: {
    provider: { available: false, reason: "AWS_QUICKSIGHT_ML_FORECAST_EVIDENCE_NOT_INGESTED" },
    sutra: [
      {
        available: true,
        currency: "USD",
        costBasis: "unblended",
        model: "sutra_integer_linear_trend_v1",
        estimate: true,
        trainingWindow: {
          fromPeriod: "2026-06",
          toPeriod: "2026-08",
          periodCount: 3,
          generationIds: [GENERATION("d"), GENERATION("e"), GENERATION("f")],
        },
        points: [
          { period: "2026-09", forecastMicros: "700000000", lowerMicros: "600000000", upperMicros: "800000000" },
          { period: "2026-10", forecastMicros: "600000000", lowerMicros: "500000000", upperMicros: "700000000" },
          { period: "2026-11", forecastMicros: "500000000", lowerMicros: "400000000", upperMicros: "600000000" },
        ],
        errorBand: {
          method: "mean_absolute_residual",
          meanAbsoluteResidualMicros: "100000000",
          statisticalConfidence: false,
        },
        disclosure: "SUTRA_DETERMINISTIC_ESTIMATE_NOT_AWS_QUICKSIGHT_ML_NOT_A_QUOTE",
      },
      {
        available: false,
        currency: "USD",
        costBasis: "amortized",
        reason: "INSUFFICIENT_CONTIGUOUS_COMPLETE_HISTORY",
        observedCompletePeriods: 2,
        minimumRequired: 3,
      },
    ],
  },
  serviceTaxonomy: {
    state: "PARTIAL",
    evidenceBasis: "ACTIVE_CUR2_SERVICE_CATEGORY_FIELDS",
    missingTaxonomyRowCount: 17,
    groups: [
      { category: "Compute", subcategory: "Virtual machines", services: ["AmazonEC2"] },
      { category: "Support", subcategory: null, services: ["AWSSupportEnterprise"] },
    ],
    costTrends: [
      {
        period: "2026-08",
        category: "Compute",
        subcategory: "Virtual machines",
        service: "AmazonEC2",
        currency: "USD",
        costBasis: "unblended",
        totalMicros: "800000000",
        rowCount: 300,
      },
      {
        period: "2026-08",
        category: "Support",
        subcategory: null,
        service: "AWSSupportEnterprise",
        currency: "USD",
        costBasis: "unblended",
        totalMicros: "-100000000",
        rowCount: 4,
      },
    ],
  },
  serviceUsage: {
    state: "PARTIAL",
    evidenceBasis: "ACTIVE_CUR2_METERED_QUANTITY_AND_UNIT",
    missingQuantityRowCount: 9,
    missingUnitRowCount: 3,
    groups: [
      {
        period: "2026-08",
        category: "Compute",
        service: "AmazonEC2",
        usageType: "BoxUsage:m7g.large",
        unit: "Hrs",
        usageAmountMicros: "3600500000",
        rowCount: 300,
      },
      {
        period: "2026-08",
        category: null,
        service: "AmazonS3",
        usageType: null,
        unit: "GB-Mo",
        usageAmountMicros: "125000000",
        rowCount: 20,
      },
    ],
  },
  accounts: {
    state: "PARTIAL",
    evidenceBasis: "ACTIVE_CUR2_ACCOUNT_NAME_FIELDS_NOT_ORGANIZATIONS_API",
    organizationsApiEvidenceAvailable: false,
    missingPayerAccountIdRowCount: 5,
    missingNameRowCount: 11,
    entries: [
      { role: "PAYER", accountId: "999988887777", friendlyName: "Payer", nameState: "CUR2_FIELD" },
      { role: "USAGE", accountId: "111122223333", friendlyName: null, nameState: "UNAVAILABLE" },
      { role: "USAGE", accountId: "444455556666", friendlyName: null, nameState: "CONFLICT" },
    ],
  },
  geography: {
    state: "PARTIAL",
    evidenceBasis: "ACTIVE_CUR2_REGION_COST_AND_METERED_USAGE",
    map: { available: false, reason: "AUTHORITATIVE_REGION_COORDINATES_NOT_INGESTED" },
    missingRegionRowCount: 7,
    regions: [
      {
        region: "eu-west-1",
        costs: [],
        usage: [{ unit: "GB-Mo", usageAmountMicros: "125000000" }],
      },
      {
        region: "us-east-1",
        costs: [{ currency: "USD", costBasis: "unblended", totalMicros: "800000000" }],
        usage: [{ unit: "Hrs", usageAmountMicros: "3600500000" }],
      },
    ],
  },
  automation: {
    quickSightThresholdAlerts: { available: false, reason: "AWS_QUICKSIGHT_ALERT_EVIDENCE_NOT_INGESTED" },
    quickSightScheduledDelivery: { available: false, reason: "AWS_QUICKSIGHT_SCHEDULE_EVIDENCE_NOT_INGESTED" },
    sutraAlertRules: {
      available: false,
      configuredCount: null,
      enabledCount: null,
      reason: "RUNTIME_STATUS_UNAVAILABLE",
    },
    sutraScheduledCostReports: {
      available: true,
      configuredCount: 2,
      enabledCount: 1,
      reason: "SUTRA_TENANT_SCOPED_RUNTIME",
    },
  },
};

const REPORT = {
  ok: true,
  schema: "sutra.finops-trends-intelligence.v1",
  state: "PARTIAL",
  tenant: {
    organizationId: "org_1",
    customerId: "cus_1",
    connectionId: CONNECTION,
    exportName: "foundational-cur2-export-v1",
  },
  window: { fromPeriod: "2026-03", toPeriod: "2026-08", periodCount: 6 },
  evaluatedAtIso: "2026-08-05T01:00:00.000Z",
  expectedCurrencies: ["USD"],
  selectedCostBases: ["unblended", "amortized"],
  rollingWindowMonths: 3,
  contributorLimit: 8,
  periods: [
    PERIOD_SUMMARY("2026-03", "COMPLETE", "a"),
    PERIOD_SUMMARY("2026-04", "COMPLETE", "b"),
    PERIOD_SUMMARY("2026-05", "MISSING", "c"),
    PERIOD_SUMMARY("2026-06", "COMPLETE", "d"),
    PERIOD_SUMMARY("2026-07", "COMPLETE", "e"),
    PERIOD_SUMMARY("2026-08", "COMPLETE", "f"),
  ],
  series: [
    { currency: "USD", costBasis: "unblended", points: POINTS(1) },
    { currency: "USD", costBasis: "amortized", points: POINTS(2) },
  ],
  summary: {
    activeGenerationCount: 5,
    sourceRowCount: 2_140,
    completePeriodCount: 5,
    missingPeriodCount: 1,
    currentPartialPeriodCount: 0,
    correctionPeriodCount: 0,
    backfillPeriodCount: 0,
    stalePeriodCount: 0,
    partialPeriodCount: 0,
    emptyPeriodCount: 0,
    signalCount: 2,
  },
  forecast: { available: false, reason: "NOT_PRODUCED_EVIDENCE_HONEST_TRENDS_ONLY" },
  signalPolicy: {
    momAbsolutePercentThreshold: 20,
    trailingBaselineMonths: 3,
    trailingAbsolutePercentThreshold: 30,
    formulas: {
      momAbsolutePercentChange: "abs(currentMicros-priorMicros)*100 >= abs(priorMicros)*20",
      trailingBaselineDeviation:
        "abs(currentMicros*3-sum(previous3Micros))*100 >= sum(previous3Micros)*30",
    },
  },
  additionalReadOperations: [],
  limitations: [
    "ACTIVE_RECONCILED_IMMUTABLE_AWS_CUR2_GENERATIONS_ONLY",
    "CURRENCIES_AND_COST_BASES_ARE_NEVER_MERGED_OR_CONVERTED",
    "PARTIAL_OR_MISSING_PERIODS_ARE_NOT_INTERPOLATED",
    "SIGNALS_USE_PINNED_EXPLAINABLE_THRESHOLDS_NOT_MACHINE_LEARNING",
    "NO_FORECAST_QUOTE_INVOICE_OR_SAVINGS_CLAIM_IS_PRODUCED",
  ],
  capabilities: CAPABILITIES,
};

const ENVELOPE = {
  connectionId: CONNECTION,
  officialDefinition: DEFINITION,
  selectedWindow: { fromPeriod: "2026-03", toPeriod: "2026-08" },
  availablePeriods: [
    { period: "2026-08", generationId: GENERATION("f"), committedAtIso: "2026-08-05T00:05:00.000Z" },
    { period: "2026-07", generationId: GENERATION("e"), committedAtIso: "2026-08-01T00:05:00.000Z" },
  ],
  report: REPORT,
  sourceState: "partial",
};

const SELECTION = trends.defaultTrendsSelection(REPORT);

const area = (name) => {
  const found = AREAS.find((entry) => entry.name === name);
  assert.ok(found !== undefined, `${name} is not a documented feature area`);
  return found;
};

const renderArea = (name, selection = SELECTION) => render(trends.FinopsTrendsFeatureAreaPanel, {
  report: REPORT,
  definition: DEFINITION,
  area: area(name),
  selection,
});

test("the pinned definition documents nine feature areas and no QuickSight object count", () => {
  assert.equal(AREAS.length, 9);
  assert.equal(DEFINITION.quickSightDefinition.sheetCount, null);
  assert.equal(DEFINITION.quickSightDefinition.visualCount, null);
  assert.equal(DEFINITION.documentedControls.length, 7);
});

test("every documented feature area renders substantive content and its audited coverage", () => {
  for (const entry of AREAS) {
    const html = renderArea(entry.name);
    assert.ok(html.length > 400, `${entry.name} rendered almost nothing`);
    assert.ok(html.includes(entry.nativeCoverage), `${entry.name} hid its audited coverage`);
    assert.ok(html.includes(entry.purpose), `${entry.name} omitted the AWS purpose`);
    if (entry.gap !== null) {
      assert.ok(html.includes(entry.gap), `${entry.name} omitted its audited gap`);
    }
    // Lineage travels with every area, so no figure is readable without evidence.
    assert.ok(html.includes("Evidence and lineage"), `${entry.name} dropped lineage`);
    assert.ok(html.includes("f".repeat(64)), `${entry.name} dropped the manifest hash`);
  }
});

test("monthly actuals print exact micros and a missing month is a gap, not a zero", () => {
  const html = renderArea("Periodic trends and actuals");
  // 1000000000 micros is exactly USD 1,000.00 and is printed in full.
  assert.ok(html.includes("USD 1,000.00"), "the exact micro amount must be printed");
  assert.ok(html.includes("USD 1,500.00"));
  // The month with no active generation says so, in the table and in the chart data.
  assert.ok(html.includes("Not collected"), "an uncollected month must say so");
  assert.ok(html.includes("missing"), "the missing period state must be visible");
  assert.ok(html.includes("role=\"img\""), "the trend must render as a real chart");
  // 2026-07 is a measured zero on a complete generation, so it is shown as zero.
  assert.ok(html.includes("USD 0.00"), "a measured zero must still be shown");
  // A month whose window is incomplete has no trailing average.
  assert.ok(html.includes("Not available: missing period"));
  assert.ok(html.includes("Not available: insufficient contiguous history"));
});

test("a percentage the engine withheld is explained rather than printed", () => {
  const html = renderArea("Periodic trends and actuals");
  assert.ok(html.includes("percentage withheld: baseline zero"), "the reason must be named");
  assert.ok(
    html.includes("percentage of a zero baseline is undefined and is not estimated"),
    "the withheld percentage must be explained",
  );
});

test("an exact rational percentage is neither rounded away nor inflated", () => {
  const html = renderArea("Periodic trends and actuals");
  // 100/3 percent is 33.33%, and the exact rational travels with it.
  assert.ok(html.includes("33.33%"), "the truncated decimal must be shown");
  assert.ok(html.includes("exact 100/3%"), "the exact rational must be shown");
  assert.equal(html.includes("3333.33%"), false, "a percent rational must not be scaled by 100");
  // An exactly representable percentage prints exactly, with no spurious decimals.
  assert.ok(html.includes("20%"));
  // An exact rational average of micros keeps its remainder.
  assert.ok(html.includes("exact 2400000001/3 micros"));
});

test("negative movement keeps its sign and is never shown as a magnitude", () => {
  const html = renderArea("Three-month service percentage change");
  assert.ok(html.includes("−USD 100.00"), "a decrease must keep the unicode minus");
  // The share of absolute movement is a share of one, shown as a percentage of it.
  assert.ok(html.includes("exact 800/9%"), "the exact movement share must be shown");
  assert.ok(html.includes("88.88%"));
  // A contributor the export did not name is disclosed, not dropped or relabelled.
  assert.ok(html.includes("Service not reported"));
  assert.ok(html.includes("truncated to the requested contributor limit of 8"));
});

test("the QuickSight ML forecast is unavailable and the Sutra estimate is labelled", () => {
  const html = renderArea("ML-powered forecast");
  assert.ok(html.includes("QuickSight machine-learning forecast is unavailable"));
  assert.ok(html.includes("aws quicksight ml forecast evidence not ingested"));
  assert.ok(html.includes("not produced evidence honest trends only"));
  // The Sutra estimate is shown, exactly, and disclosed as not being AWS ML.
  assert.ok(html.includes("USD 700.00"), "the estimate must print exact micros");
  assert.ok(html.includes("sutra deterministic estimate not aws quicksight ml not a quote"));
  assert.ok(html.includes("statistical confidence: not claimed"));
  assert.ok(html.includes("Deterministic integer linear trend"));

  // The amortized series has too little contiguous history: withheld, with the count.
  const amortized = renderArea("ML-powered forecast", { ...SELECTION, costBasis: "amortized" });
  assert.ok(amortized.includes("A Sutra estimate is withheld"));
  assert.ok(amortized.includes("insufficient contiguous complete history"));
  assert.ok(amortized.includes("2 contiguous complete periods are eligible; 3 are required"));
});

test("CUR2 taxonomy and metered usage are separated by unit and never merged", () => {
  const html = renderArea("Service category and service usage trends");
  assert.ok(html.includes("AmazonEC2"));
  assert.ok(html.includes("Virtual machines"));
  // A negative support credit keeps its sign in the taxonomy table.
  assert.ok(html.includes("−USD 100.00"));
  // Metered quantities keep their exact micro fraction and their provider unit.
  assert.ok(html.includes("3,600.5 Hrs"), "usage must be exact and unit-labelled");
  assert.ok(html.includes("125 GB-Mo"));
  assert.ok(html.includes("Not reported"), "an absent subcategory or usage type says so");
  assert.ok(html.includes("17 rows in this window carry no provider"));
  assert.ok(html.includes("9 rows lack a metered quantity"));
});

test("account identity states what the export could not prove", () => {
  const html = renderArea("AWS account trends");
  assert.ok(html.includes("999988887777"));
  assert.ok(html.includes("AWS Organizations account taxonomy is unavailable"));
  assert.ok(html.includes("Organizations API evidence available: no"));
  assert.ok(html.includes("conflict"), "a conflicting name must be reported as a conflict");
  assert.ok(html.includes("Not available"), "an unnamed account must not be given a name");
});

test("the geospatial map is unavailable and Region evidence is not a map", () => {
  const html = renderArea("Global usage map");
  assert.ok(html.includes("The global usage map is unavailable"));
  assert.ok(html.includes("authoritative region coordinates not ingested"));
  assert.ok(html.includes("us-east-1"));
  // A Region with no cost on the selected basis is not shown as zero cost.
  assert.ok(html.includes("eu-west-1"));
  assert.ok(html.includes("Not available"));
  assert.ok(html.includes("7 rows carry no valid provider Region"));
});

test("QuickSight automation is unavailable and Sutra automation is shown separately", () => {
  const html = renderArea("Threshold alerts and scheduled delivery");
  assert.ok(html.includes("aws quicksight alert evidence not ingested"));
  assert.ok(html.includes("aws quicksight schedule evidence not ingested"));
  // A runtime status Sutra could not read is unavailable, never zero.
  assert.ok(html.includes("Unavailable"));
  assert.ok(html.includes("Withheld: runtime status unavailable"));
  assert.equal(html.includes("0 enabled of 0"), false, "an unreadable status must not read as zero");
  assert.ok(html.includes("1 enabled of 2"), "a readable status shows its exact counts");
  assert.ok(html.includes("not AWS Cost Anomaly Detection findings"));
});

test("calendar-period spend keeps cost bases apart and gaps visible", () => {
  const html = renderArea("AWS Usage v5.1 additions");
  assert.ok(html.includes("unblended"));
  assert.ok(html.includes("amortized"));
  // The amortized series is twice the unblended one; both are printed exactly.
  assert.ok(html.includes("USD 1,000.00"));
  assert.ok(html.includes("USD 2,000.00"));
  assert.ok(html.includes("Not collected"), "the missing month must stay a gap in both bases");
  assert.ok(html.includes("Payer accounts"));
});

test("the filter area claims only selectors this page really exposes", () => {
  const html = renderArea("Filter controls and one-click filtering");
  for (const control of DEFINITION.documentedControls) {
    assert.ok(html.includes(control), `${control} must be listed verbatim`);
  }
  assert.ok(html.includes("QuickSight control and parameter counts are unavailable"));
  assert.ok(html.includes("not published"), "an unpublished count must say so");
  assert.ok(html.includes("Pixel parity claimed: no"));
  assert.ok(html.includes("Unavailable means not published, not zero."));
});

test("the workspace exposes one tab per documented area and invents no sheet count", () => {
  const html = render(trends.FinopsTrendsWorkspace, { envelope: ENVELOPE });
  assert.equal((html.match(/role="tab"/gu) ?? []).length, 9);
  assert.equal((html.match(/role="tabpanel"/gu) ?? []).length, 1);
  assert.equal((html.match(/aria-selected="true"/gu) ?? []).length, 1);
  assert.ok(html.includes("9</b> documented AWS feature areas"));
  // No sheet or visual count exists upstream, so none is displayed.
  assert.ok(html.includes("not published"));
  assert.equal(/\d+<\/b> official sheets/u.test(html), false, "no sheet count may be claimed");
  assert.ok(html.includes(DEFINITION.source.commit.slice(0, 12)), "the pinned commit must be shown");
  // A named area can be opened directly.
  const forecast = render(trends.FinopsTrendsWorkspace, {
    envelope: ENVELOPE, initialAreaName: "Global usage map",
  });
  assert.ok(forecast.includes("The global usage map is unavailable"));
});

test("a rejected or absent report renders nothing rather than an empty dashboard", () => {
  for (const report of [
    null,
    {
      ok: false,
      schema: "sutra.finops-trends-intelligence.v1",
      state: "ERROR",
      failures: [{ code: "ROW_LIMIT_EXCEEDED", field: "periods.rows" }],
    },
  ]) {
    assert.equal(render(trends.FinopsTrendsWorkspace, {
      envelope: { ...ENVELOPE, report },
    }), "");
  }
});
