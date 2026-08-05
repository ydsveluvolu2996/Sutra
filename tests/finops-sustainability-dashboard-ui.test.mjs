import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * ADD-08 Sustainability UI contract.
 *
 * Renders every one of the six official sheets against a realistic dashboard
 * envelope and asserts the rules that make this vertical honest:
 *
 * - Sutra CUR2-derived proxy estimates and AWS provider-reported carbon are
 *   separately labelled everywhere, and never merged: no rendered figure is the
 *   sum of a proxy quantity and a carbon quantity, and no rendered figure is the
 *   sum of the location-based and market-based carbon methods.
 * - Every quantity carries an explicit unit (a proxy unit, or MTCO2e).
 * - The dimensions this vertical does not deliver — regional renewable mix and
 *   map, processor and instance family, storage class, transfer path and idle
 *   network — read as unavailable pending versioned evidence.
 * - Missing evidence is a labelled state, never a zero.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const ui = await vite.ssrLoadModule("/app/costs/finops-sustainability-carbon-dashboard.tsx");
const definitionModule = await vite.ssrLoadModule("/lib/finops-sustainability-official-definition.ts");
after(async () => vite.close());

const OFFICIAL = definitionModule.SUSTAINABILITY_OFFICIAL_DEFINITION;
const CONNECTION = `conn_${"a".repeat(32)}`;
const GENERATION = `scg_${"b".repeat(64)}`;

/** Every proxy dimension arrives with no pinned source or version. */
const NO_DIMENSIONS = Object.fromEntries([
  "processorArchitecture", "instanceFamily", "storageClass", "transferPath",
  "idleNetworkResource", "regionLatitudeE6", "regionLongitudeE6", "renewableEnergyClass",
].map((key) => [key, { state: "unavailable", value: null, sourceField: null, sourceVersion: null }]));

const proxyRow = (overrides) => ({
  usagePeriod: "2026-07",
  usageAccountId: "111122223333",
  region: "us-east-1",
  service: "AmazonEC2",
  workloadTagKey: "workload",
  workloadTagValue: "checkout",
  metric: "COMPUTE_VCPU_HOURS",
  unit: "vCPU-hours",
  valueMicros: "12345678901",
  sourceRowCount: 120,
  dimensions: NO_DIMENSIONS,
  ...overrides,
});

const carbonRow = (overrides) => ({
  usagePeriod: "2026-07",
  modelVersion: "v1.2.0",
  usageAccountId: "111122223333",
  regionCode: "us-east-1",
  location: "US East (N. Virginia)",
  productCode: "AmazonEC2",
  unit: "MTCO2e",
  totalLbmMicroMtco2e: "4500000",
  totalMbmMicroMtco2e: "3100000",
  scope1MicroMtco2e: "200000",
  scope2LbmMicroMtco2e: "2500000",
  scope2MbmMicroMtco2e: "1100000",
  scope3LbmMicroMtco2e: "1800000",
  scope3MbmMicroMtco2e: "1800000",
  ...overrides,
});

const REPORT = {
  schema: "sutra.finops-sustainability-dashboard.v1",
  connectionId: CONNECTION,
  sourceState: "partial",
  runtimeState: "failed",
  state: "partial",
  filters: {},
  officialDefinition: OFFICIAL,
  lineage: {
    proxyGenerationId: `fbg_${"c".repeat(64)}`,
    proxyManifestSha256: "d".repeat(64),
    proxyDataThroughAtIso: "2026-07-31T00:00:00.000Z",
    carbonExportArn: "arn:aws:bcm-data-exports:us-east-1:111122223333:export/carbon",
    carbonGenerationId: `carbon_${"e".repeat(58)}`,
    carbonManifestSha256: "f".repeat(64),
    carbonPublishedAtIso: "2026-07-15T00:00:00.000Z",
    carbonPublicationKind: "MONTHLY",
    carbonModelVersions: ["v1.2.0"],
  },
  proxy: {
    interpretation: "RESOURCE_USE_PROXY_NOT_CARBON",
    series: [
      proxyRow({}),
      proxyRow({ usagePeriod: "2026-06", valueMicros: "11000000000", sourceRowCount: 110 }),
      proxyRow({ region: "eu-west-1", valueMicros: "2500000000", sourceRowCount: 40, workloadTagValue: "search" }),
      proxyRow({
        metric: "STORAGE_GB_HOURS", unit: "GB-hours", service: "AmazonS3",
        valueMicros: "870000000", sourceRowCount: 60,
      }),
      proxyRow({
        metric: "STORAGE_REQUESTS", unit: "requests", service: "AmazonS3",
        valueMicros: "45000000", sourceRowCount: 55,
      }),
      proxyRow({
        metric: "DATA_TRANSFER_GB", unit: "GB", service: "AWSDataTransfer",
        valueMicros: "3300000", sourceRowCount: 22, region: null,
      }),
      proxyRow({
        metric: "LAMBDA_GB_SECONDS", unit: "GB-seconds", service: "AWSLambda",
        valueMicros: "980000000", sourceRowCount: 400,
      }),
    ],
    trends: [
      { usagePeriod: "2026-06", metric: "COMPUTE_VCPU_HOURS", unit: "vCPU-hours", valueMicros: "11000000000", sourceRowCount: 110 },
      { usagePeriod: "2026-07", metric: "COMPUTE_VCPU_HOURS", unit: "vCPU-hours", valueMicros: "14845678901", sourceRowCount: 160 },
      { usagePeriod: "2026-07", metric: "LAMBDA_GB_SECONDS", unit: "GB-seconds", valueMicros: "980000000", sourceRowCount: 400 },
      { usagePeriod: "2026-07", metric: "STORAGE_GB_HOURS", unit: "GB-hours", valueMicros: "870000000", sourceRowCount: 60 },
      { usagePeriod: "2026-07", metric: "STORAGE_REQUESTS", unit: "requests", valueMicros: "45000000", sourceRowCount: 55 },
      { usagePeriod: "2026-07", metric: "DATA_TRANSFER_GB", unit: "GB", valueMicros: "3300000", sourceRowCount: 22 },
    ],
    targets: {
      configured: true,
      reason: "IMMUTABLE_SERVER_OWNED_TARGET_VERSIONS",
      workloadTagGoals: [{
        targetId: `stgt_${"1".repeat(64)}`,
        versionId: `stgv_${"2".repeat(64)}`,
        workloadTagKey: "workload",
        workloadTagValue: "checkout",
        metric: "COMPUTE_VCPU_HOURS",
        periodStart: "2026-07",
        unit: "vCPU-hours",
        targetValueMicros: "13000000000",
        actualValueMicros: "14845678901",
        state: "ABOVE_TARGET",
        reason: "Approved technical resource-use threshold",
        governedBy: "usr_1",
        versionedAt: "2026-07-02T00:00:00.000Z",
        interpretation: "TECHNICAL_RESOURCE_USE_TARGET_NOT_CARBON_TARGET",
      }],
    },
    technicalPlans: [
      {
        metric: "COMPUTE_VCPU_HOURS", latestPeriod: "2026-07",
        latestValueMicros: "14845678901", previousPeriod: "2026-06",
        deltaMicros: "3845678901", direction: "INCREASED",
        action: "Review instance rightsizing, schedules, and autoscaling against service demand.",
        claim: "TECHNICAL_RESOURCE_PLAN_NOT_CARBON_REDUCTION_CLAIM",
      },
      {
        metric: "STORAGE_GB_HOURS", latestPeriod: "2026-07",
        latestValueMicros: "870000000", previousPeriod: null,
        deltaMicros: null, direction: "UNKNOWN",
        action: "Review retention, lifecycle, compression, and unattached storage.",
        claim: "TECHNICAL_RESOURCE_PLAN_NOT_CARBON_REDUCTION_CLAIM",
      },
      {
        metric: "DATA_TRANSFER_GB", latestPeriod: "2026-07",
        latestValueMicros: "3300000", previousPeriod: null,
        deltaMicros: null, direction: "UNKNOWN",
        action: "Review architecture locality, caching, compression, and cross-zone or cross-Region paths.",
        claim: "TECHNICAL_RESOURCE_PLAN_NOT_CARBON_REDUCTION_CLAIM",
      },
      {
        metric: "LAMBDA_GB_SECONDS", latestPeriod: "2026-07",
        latestValueMicros: "980000000", previousPeriod: null,
        deltaMicros: null, direction: "UNKNOWN",
        action: "Review function memory sizing, duration, and invocation architecture.",
        claim: "TECHNICAL_RESOURCE_PLAN_NOT_CARBON_REDUCTION_CLAIM",
      },
    ],
  },
  providerCarbon: {
    interpretation: "AWS_PROVIDER_ESTIMATE_NOT_PROXY_DERIVATION",
    series: [
      carbonRow({}),
      carbonRow({ regionCode: "eu-west-1", location: null, totalLbmMicroMtco2e: "1250000", totalMbmMicroMtco2e: "900000" }),
      carbonRow({ usagePeriod: "2026-06", totalLbmMicroMtco2e: "4100000", totalMbmMicroMtco2e: null }),
      carbonRow({ productCode: null, usageAccountId: "444455556666", totalLbmMicroMtco2e: "620000", totalMbmMicroMtco2e: "410000" }),
    ],
    trends: [
      {
        usagePeriod: "2026-06", modelVersion: "v1.2.0", unit: "MTCO2e",
        totalLbmMicroMtco2e: "4100000", totalMbmMicroMtco2e: null,
        scope1MicroMtco2e: "180000", scope2LbmMicroMtco2e: "2300000",
        scope2MbmMicroMtco2e: "1000000", scope3LbmMicroMtco2e: "1620000",
        scope3MbmMicroMtco2e: "1620000",
      },
      {
        usagePeriod: "2026-07", modelVersion: "v1.2.0", unit: "MTCO2e",
        totalLbmMicroMtco2e: "6370000", totalMbmMicroMtco2e: "4410000",
        scope1MicroMtco2e: "200000", scope2LbmMicroMtco2e: "2500000",
        scope2MbmMicroMtco2e: "1100000", scope3LbmMicroMtco2e: "1800000",
        scope3MbmMicroMtco2e: "1800000",
      },
    ],
  },
  separation: {
    proxyConvertedToCarbon: false,
    carbonAllocatedToWorkloads: false,
    seriesMayBeComparedVisuallyButNotMathematicallyCombined: true,
  },
  limitations: ["PROXY_METRICS_ARE_NOT_EMISSIONS", "CARBON_ROWS_ARE_PROVIDER_ESTIMATES"],
  history: [{
    generationId: GENERATION,
    sourceCaptureId: `sustainability_${"9".repeat(52)}`,
    sourceState: "partial",
    proxyState: "complete",
    carbonState: "partial",
    completedAtIso: "2026-08-01T00:00:00.000Z",
    proxyRowCount: 7,
    carbonRowCount: 4,
    contentSha256: "b".repeat(64),
  }],
  filterOptions: {
    accounts: ["111122223333", "444455556666"],
    regions: ["eu-west-1", "us-east-1"],
    services: ["AWSDataTransfer", "AWSLambda", "AmazonEC2", "AmazonS3"],
    workloadTags: ["checkout", "search"],
    proxyMetrics: ["COMPUTE_VCPU_HOURS", "DATA_TRANSFER_GB", "LAMBDA_GB_SECONDS", "STORAGE_GB_HOURS", "STORAGE_REQUESTS"],
    carbonModels: ["v1.2.0"],
    carbonProducts: ["AmazonEC2"],
  },
  freshness: {
    proxy: { dataThroughAt: "2026-07-31T00:00:00.000Z", ageHours: 24, staleAfterHours: 48 },
    providerCarbon: { publishedAt: "2026-07-15T00:00:00.000Z", ageHours: 420, staleAfterHours: 840 },
  },
  evidence: {
    generationId: GENERATION,
    activeGenerationId: GENERATION,
    latestGenerationId: `scg_${"c".repeat(64)}`,
    sourceCaptureId: `sustainability_${"9".repeat(52)}`,
    contentSha256: "b".repeat(64),
    newerIncomplete: true,
  },
  collection: {
    state: "unavailable",
    jobContractAvailable: true,
    providerAdapterAvailable: true,
    registeredInSharedRuntime: false,
    reason: "SUSTAINABILITY_CUR2_CARBON_MATERIALIZER_NOT_REGISTERED",
  },
  disclosures: [
    "Resource-use proxy metrics are not carbon emissions.",
    "LBM and MBM are separate accounting methods and are never added together.",
  ],
};

const PROXY_LABEL = "Sutra CUR2-derived proxy estimate";
const CARBON_LABEL = "AWS provider-reported carbon";

const sheets = ui.FINOPS_SUSTAINABILITY_SHEETS;
const renderSheet = (key) =>
  renderToStaticMarkup(createElement(ui.FinopsSustainabilitySheets, {
    report: REPORT,
    initialSheetKey: key,
  }));

/** One sheet's own content, without the standing cross-channel summary band. */
const renderSheetContent = (key) =>
  renderToStaticMarkup(createElement(ui.FinopsSustainabilitySheetContent, {
    report: REPORT,
    sheet: sheets.sheets.find((sheet) => sheet.key === key),
  }));

/** Exact micro-unit sum, formatted the way the dashboard formats a figure. */
const exact = (micros) => {
  const amount = BigInt(micros);
  const whole = (amount / BigInt(1_000_000)).toString().replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  const raw = (amount % BigInt(1_000_000)).toString().padStart(6, "0");
  const significant = raw.replace(/0+$/u, "");
  return `${whole}.${significant.length < 2 ? significant.padEnd(2, "0") : significant}`;
};

test("the pinned definition drives exactly six sheets, 25 visuals and 17 controls", () => {
  assert.equal(sheets.totalSheets, 6);
  assert.equal(sheets.totalVisuals, 25);
  assert.equal(sheets.totalControls, 17);
  assert.deepEqual(sheets.sheets.map((sheet) => sheet.key), [
    "regional-footprint", "compute-proxies", "storage-proxies",
    "data-transfer-networking-proxies", "carbon-emissions", "about",
  ]);
  // Only the Carbon Emissions sheet is evidence-backed; the rest disclose gaps.
  assert.equal(sheets.supportedSheets, 1);
  assert.equal(sheets.partialSheets, 5);
  for (const sheet of sheets.sheets) {
    assert.ok(sheet.gaps.length > 0, `${sheet.name} must carry its audited gap`);
  }
});

test("every official sheet renders with its coverage, audited gap and channel separation", () => {
  for (const sheet of sheets.sheets) {
    const html = renderSheet(sheet.key);
    assert.ok(html.length > 2000, `${sheet.name} rendered almost nothing`);
    assert.match(html, new RegExp(sheet.name.replace(/[/]/gu, "."), "u"));
    // The sheet's own coverage classification and gaps are disclosed.
    assert.match(html, new RegExp(sheet.supportLabel.replace(/_/gu, " "), "u"));
    for (const gap of sheet.gaps) {
      assert.ok(html.includes(gap.slice(0, 60)), `${sheet.name} omitted its audited gap`);
    }
    // The standing separation notice never disappears.
    assert.ok(html.includes(PROXY_LABEL), `${sheet.name} lost the proxy channel label`);
    assert.ok(html.includes(CARBON_LABEL), `${sheet.name} lost the carbon channel label`);
    assert.match(html, /never mathematically combined/u);
    assert.doesNotMatch(html, /placeholder|lorem ipsum|sample data|TODO/iu);
  }
});

test("proxy estimates and provider carbon are separately labelled and never combined", () => {
  const carbonHtml = renderSheet("carbon-emissions");

  // Both channels are named, in their own units, with their own methods.
  assert.match(carbonHtml, /Location-based method \(LBM\), MTCO2e/u);
  assert.match(carbonHtml, /Market-based method \(MBM\), MTCO2e/u);
  assert.match(carbonHtml, /Two accounting methods, never combined/u);
  assert.match(carbonHtml, /compared visually, never combined/u);
  assert.match(carbonHtml, /Grouped, never stacked/u);
  assert.match(carbonHtml, /not derived from a proxy estimate|no figure on this sheet is derived from a proxy estimate/u);

  // No figure is the sum of the two carbon accounting methods.
  const methodSum = exact(
    BigInt(REPORT.providerCarbon.trends[1].totalLbmMicroMtco2e)
    + BigInt(REPORT.providerCarbon.trends[1].totalMbmMicroMtco2e),
  );
  assert.ok(!carbonHtml.includes(methodSum), `LBM and MBM were combined into ${methodSum}`);

  // No figure is the sum of a proxy quantity and a carbon quantity.
  const crossChannelSum = exact(
    BigInt(REPORT.proxy.trends[1].valueMicros)
    + BigInt(REPORT.providerCarbon.trends[1].totalLbmMicroMtco2e),
  );
  assert.ok(
    !carbonHtml.includes(crossChannelSum),
    `a proxy estimate was added to provider carbon: ${crossChannelSum}`,
  );

  // Exact figures are printed for both channels, each with its own unit.
  assert.ok(carbonHtml.includes(`${exact("6370000")} MTCO2e`));
  const computeHtml = renderSheet("compute-proxies");
  assert.ok(computeHtml.includes(`${exact("14845678901")} vCPU-hours`));
  // A proxy sheet's own content never presents an MTCO2e figure: the only place
  // the two channels appear together is the labelled summary band and the
  // explicitly side-by-side comparison, neither of which does arithmetic.
  for (const key of ["compute-proxies", "storage-proxies", "data-transfer-networking-proxies"]) {
    assert.doesNotMatch(renderSheetContent(key), /[\d)] MTCO2e/u);
  }
  // Conversely, the Carbon Emissions sheet content presents no proxy figure
  // outside its clearly labelled side-by-side comparison panel.
  const carbonContent = renderSheetContent("carbon-emissions");
  assert.match(carbonContent, /compared visually, never combined/u);

  // A bare number with an ambiguous unit is not acceptable: every rendered
  // quantity carries either a proxy unit or MTCO2e.
  for (const [sheetKey, unit] of [
    ["compute-proxies", "vCPU-hours"],
    ["storage-proxies", "GB-hours"],
    ["data-transfer-networking-proxies", "GB"],
  ]) {
    assert.match(renderSheet(sheetKey), new RegExp(`\\d ${unit}`, "u"));
  }
});

test("unavailable dimensions read as unavailable pending versioned evidence", () => {
  const expectations = [
    ["regional-footprint", ["Regional renewable-energy mix and footprint map", "Renewable-energy classification", "Region latitude"]],
    ["compute-proxies", ["Processor architecture and EC2 instance family", "EC2 instance family"]],
    ["storage-proxies", ["EBS volume type and S3 storage class", "EBS / S3 storage class"]],
    ["data-transfer-networking-proxies", ["Data-transfer path classification", "Idle NAT Gateway and Elastic Load Balancer evidence", "Idle NAT / ELB evidence"]],
  ];
  for (const [key, titles] of expectations) {
    const html = renderSheet(key);
    assert.match(html, /Unavailable pending versioned evidence/u);
    assert.match(html, /Unavailable — not inferred/u);
    assert.match(html, /No pinned source or version delivered/u);
    for (const title of titles) {
      assert.ok(html.includes(title), `${key} did not disclose ${title}`);
    }
  }

  // The About sheet gathers all five unavailable dimensions in one place.
  const about = renderSheet("about");
  for (const title of [
    "Regional renewable-energy mix and footprint map",
    "Processor architecture and EC2 instance family",
    "EBS volume type and S3 storage class",
    "Data-transfer path classification",
    "Idle NAT Gateway and Elastic Load Balancer evidence",
  ]) {
    assert.ok(about.includes(title), `About omitted ${title}`);
  }
});

test("missing evidence is a labelled state and governance stays non-carbon", () => {
  const carbonHtml = renderSheet("carbon-emissions");
  // 2026-06 publishes no market-based total.
  assert.match(carbonHtml, /Not published/u);
  assert.doesNotMatch(carbonHtml, /MBM 0\.00 MTCO2e/u);

  const about = renderSheet("about");
  assert.match(about, /never carbon targets/u);
  assert.match(about, /TECHNICAL RESOURCE USE TARGET NOT CARBON TARGET/u);
  assert.ok(about.includes(`${exact("13000000000")} vCPU-hours`), "the governed target is not exact");
  assert.match(about, /above target/iu);
  assert.match(about, /SUSTAINABILITY CUR2 CARBON MATERIALIZER NOT REGISTERED/u);
  assert.match(about, /Resource-use proxy metrics are not carbon emissions\./u);
  assert.match(about, new RegExp(OFFICIAL.artifactSha256, "u"));

  const storage = renderSheet("storage-proxies");
  // A metric with no previous period is unknown, not flat and not zero.
  assert.match(storage, /No previous period \(none collected\)/u);
});

test("the container export and its props signature are preserved", () => {
  assert.equal(typeof ui.FinopsSustainabilityCarbonDashboard, "function");
  assert.equal(typeof ui.FinopsSustainabilityCarbonReportView, "function");
  assert.equal(typeof ui.FinopsSustainabilitySheets, "function");
  assert.equal(typeof ui.FinopsSustainabilitySheetContent, "function");
  assert.equal(typeof ui.SustainabilityOfficialDefinitionPanel, "function");

  // The registry renders the container with a null connection and no evidence.
  const idle = renderToStaticMarkup(
    createElement(ui.FinopsSustainabilityCarbonDashboard, { connectionId: null }),
  );
  assert.match(idle, /Connect an active AWS trust-role account/u);
  assert.doesNotMatch(idle, /0 MTCO2e|zero emissions claim/u);

  // The retained report view keeps taking filters plus a change handler.
  const view = renderToStaticMarkup(createElement(ui.FinopsSustainabilityCarbonReportView, {
    report: REPORT,
    filters: { region: "us-east-1" },
    onFiltersChange: () => undefined,
  }));
  assert.match(view, /Carbon model version/u);
  assert.match(view, /Workload tag \(proxy channel\)/u);
});
