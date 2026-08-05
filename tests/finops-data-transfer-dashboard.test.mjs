import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * Renders every AWS-documented purpose area of the ADD-10 Data Transfer
 * dashboard against a realistic canonical snapshot, and asserts the honesty
 * rules hold: money prints as exact micro-unit strings, a missing cost or byte
 * total is a labelled absence rather than a zero, negative amounts keep their
 * sign, a withheld percentage explains itself, an uncharged group is never
 * presented as paid transfer, and no sheet or visual count is claimed for a
 * dashboard whose QuickSight definition AWS does not publish.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const view = await vite.ssrLoadModule("/app/costs/finops-data-transfer-dashboard.tsx");
const auditModule = await vite.ssrLoadModule("/lib/finops-data-transfer-official-audit.ts");
after(async () => vite.close());

const AUDIT = auditModule.DATA_TRANSFER_OFFICIAL_AUDIT;
const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const GENERATION_ID = `fbg_${"b".repeat(64)}`;
const MANIFEST_SHA = "c".repeat(64);

const render = (component, props) => renderToStaticMarkup(createElement(component, props));

const cost = (basis, totalMicros, contributing, rows) => ({
  basis,
  totalMicros,
  contributingRowCount: contributing,
  missingRowCount: rows - contributing,
  coverage: contributing === 0
    ? "unavailable"
    : contributing === rows ? "complete" : "partial",
});

/** Amortized and unblended present; the other four bases are unavailable. */
const costs = (micros, rows = 4, contributing = micros === null ? 0 : rows) => [
  cost("unblended", micros, contributing, rows),
  cost("net", null, 0, rows),
  cost("amortized", micros, contributing, rows),
  cost("list", null, 0, rows),
  cost("contracted", null, 0, rows),
  cost("public", null, 0, rows),
];

const quantity = (sourceUnit, quantityMicros, normalizedBytesMicros, rowCount = 4) => ({
  sourceUnit, quantityMicros, normalizedBytesMicros, rowCount,
});

const SCOPE = {
  organizationId: "org_1",
  customerId: "cus_1",
  connectionId: CONNECTION_ID,
  exportName: "sutra-cur2-export-v1",
  billingPeriod: "2026-07",
  generationId: GENERATION_ID,
};

const path = (sourceLocation, sourceLocationType, destinationLocation, evidence) => ({
  sourceLocation, sourceLocationType, destinationLocation, evidence,
});

const provider = (overrides) => ({
  serviceCode: null,
  serviceName: null,
  productCode: null,
  productName: null,
  operation: null,
  transferType: null,
  ...overrides,
});

const drilldown = (overrides) => ({
  currency: "USD",
  direction: "OUTBOUND",
  usageAccountId: "111122223333",
  service: "AmazonEC2",
  region: "us-east-1",
  availabilityZone: null,
  resourceId: "i-0123456789abcdef0",
  path: path(null, null, null, "UNAVAILABLE"),
  provider: provider({}),
  rowCount: 4,
  costs: costs("1000000"),
  quantities: [quantity("GB", "1000000000", "1000000000000000")],
  normalizedBytesMicros: "1000000000000000",
  classificationRuleIds: ["INTERNET_DATA_TRANSFER_BYTES_V1"],
  usageTypes: ["USE1-DataTransfer-Out-Bytes"],
  usageTypesTruncated: false,
  sourceLineIdCount: 4,
  sourceLineIds: ["line-1", "line-2"],
  sourceLineIdsTruncated: false,
  ...overrides,
});

const DRILLDOWNS = [
  // Internet egress: a real charge with exact fractional micros.
  drilldown({
    category: "INTERNET",
    costs: costs("1234567890"),
    normalizedBytesMicros: "1073741824000000",
    quantities: [quantity("GB", "1073741824", "1073741824000000")],
    path: path("us-east-1", "AWS Region", "External", "PARTIAL"),
    provider: provider({
      serviceCode: "AmazonEC2",
      serviceName: "Amazon Elastic Compute Cloud",
      productCode: "AmazonEC2",
      productName: "Amazon Elastic Compute Cloud",
      operation: "RunInstances",
      transferType: "AWS Outbound",
    }),
  }),
  // Global Accelerator transfer premium.
  drilldown({
    category: "GLOBAL_ACCELERATOR",
    service: "AWSGlobalAccelerator",
    costs: costs("45000000"),
    classificationRuleIds: ["GLOBAL_ACCELERATOR_TRANSFER_PREMIUM_V1"],
    usageTypes: ["USE1-OUT-Bytes-Internet"],
    provider: provider({
      serviceCode: "AWSGlobalAccelerator",
      productCode: "AWSGlobalAccelerator",
      transferType: "Accelerator Premium",
    }),
  }),
  // Global Accelerator fixed fee: accelerator hours, never transferred bytes.
  drilldown({
    category: "GLOBAL_ACCELERATOR",
    direction: "UNKNOWN",
    service: "AWSGlobalAccelerator",
    costs: costs("18000000"),
    classificationRuleIds: ["GLOBAL_ACCELERATOR_FIXED_FEE_V1"],
    usageTypes: ["Global-Accelerator-fixed-fee"],
    normalizedBytesMicros: null,
    quantities: [quantity("Hrs", "744000000", null)],
    provider: provider({
      serviceCode: "AWSGlobalAccelerator",
      productCode: "AWSGlobalAccelerator",
    }),
  }),
  // Inter-Region with both provider endpoints reported.
  drilldown({
    category: "INTER_REGION",
    costs: costs("9876543210"),
    classificationRuleIds: ["INTER_REGION_AWS_BYTES_V1"],
    usageTypes: ["USE1-EUC1-AWS-Out-Bytes"],
    path: path("us-east-1", "AWS Region", "eu-central-1", "CUR2_PROVIDER_REPORTED"),
    provider: provider({
      serviceCode: "AmazonEC2",
      productCode: "AmazonEC2",
      transferType: "InterRegion Outbound",
    }),
  }),
  // Inter-Region with no endpoints and no cost on any basis.
  drilldown({
    category: "INTER_REGION",
    usageAccountId: "444455556666",
    resourceId: null,
    region: null,
    costs: costs(null),
    classificationRuleIds: ["INTER_REGION_AWS_BYTES_V1"],
    usageTypes: ["USE1-AWS-Out-Bytes"],
    normalizedBytesMicros: null,
    quantities: [],
    path: path(null, null, null, "UNAVAILABLE"),
  }),
  // Inter-AZ credit correction: negative and must keep its sign.
  drilldown({
    category: "INTER_AZ",
    direction: "UNKNOWN",
    availabilityZone: "us-east-1a",
    costs: costs("-2500000"),
    classificationRuleIds: ["INTER_AZ_REGIONAL_BYTES_V1"],
    usageTypes: ["USE1-DataTransfer-Regional-Bytes"],
  }),
  // Inter-AZ proven-zero charge: real evidence, but not paid transfer.
  drilldown({
    category: "INTER_AZ",
    direction: "UNKNOWN",
    usageAccountId: "777788889999",
    availabilityZone: null,
    costs: costs("0"),
    classificationRuleIds: ["INTER_AZ_REGIONAL_BYTES_V1"],
    usageTypes: ["USE1-DataTransfer-Regional-Bytes"],
  }),
  // CloudFront egress.
  drilldown({
    category: "CLOUDFRONT",
    service: "AmazonCloudFront",
    region: "global",
    costs: costs("777000000"),
    classificationRuleIds: ["CLOUDFRONT_PRODUCT_OUT_BYTES_V1"],
    usageTypes: ["DataTransfer-Out-Bytes"],
    provider: provider({
      serviceCode: "AmazonCloudFront",
      productCode: "AmazonCloudFront",
      productName: "Amazon CloudFront",
      operation: "GET",
      transferType: "CloudFront Outbound",
    }),
  }),
];

const summary = (category, micros, overrides = {}) => ({
  category,
  currency: "USD",
  rowCount: 4,
  directionCounts: { INBOUND: 1, OUTBOUND: 2, UNKNOWN: 1 },
  costs: costs(micros),
  quantities: [quantity("GB", "1000000000", "1000000000000000")],
  normalizedBytesMicros: "1000000000000000",
  byteNormalizedRowCount: 4,
  missingOrUnknownUnitRowCount: 0,
  ...overrides,
});

const REPORT = {
  schemaVersion: "sutra.finops-data-transfer-snapshot.v1",
  state: "PARTIAL",
  complete: false,
  scope: SCOPE,
  source: {
    kind: "AWS_CUR2_ACTIVE_GENERATION",
    evidenceId: `active-cur2:${MANIFEST_SHA}`,
    generationId: GENERATION_ID,
    manifestSha256: MANIFEST_SHA,
    status: "PARTIAL",
    generatedAtIso: "2026-08-01T00:00:00.000Z",
    dataThroughAtIso: "2026-08-01T00:00:00.000Z",
    evaluatedAtIso: "2026-08-02T00:00:00.000Z",
    ageHours: 24,
    freshnessSlaHours: 48,
    errorCode: "MANIFEST_OBJECT_COVERAGE_UNAVAILABLE",
    objectCoverage: {
      status: "unavailable",
      manifestObjectCount: null,
      processedObjectCount: null,
    },
  },
  taxonomy: {
    id: "aws-cur2-data-transfer",
    version: "2026-08-01.v2",
    sha256: "8055f80dd3f7b8c86439cb96ef0c112a35b414e1ecf308f80405aeff2edde029",
  },
  coverage: {
    scannedRowCount: 4210,
    transferCandidateRowCount: 32,
    classifiedRowCount: 28,
    unknownRowCount: 2,
    unclassifiedRowCount: 2,
    excludedNonTransferRowCount: 4178,
    missingUsageTypeRowCount: 2,
    classification: "partial",
    dimensions: {
      account: "complete",
      service: "complete",
      region: "partial",
      resource: "partial",
      sourceLocation: "partial",
      destinationLocation: "partial",
      providerService: "partial",
      transferType: "partial",
    },
    byteNormalization: "partial",
    byteNormalizedRowCount: 24,
    missingQuantityRowCount: 4,
    unknownUnitRowCount: 4,
  },
  categorySummaries: [
    summary("CLOUDFRONT", "777000000"),
    summary("GLOBAL_ACCELERATOR", "63000000"),
    // A negative category total: credits and corrections keep their sign.
    summary("INTER_AZ", "-2500000"),
    summary("INTER_REGION", "9876543210"),
    summary("INTERNET", "1234567890"),
    // Byte normalization unavailable for this category.
    summary("UNCLASSIFIED", null, {
      normalizedBytesMicros: null,
      byteNormalizedRowCount: 0,
      missingOrUnknownUnitRowCount: 4,
      quantities: [],
    }),
    summary("UNKNOWN", "5000000", {
      normalizedBytesMicros: null,
      byteNormalizedRowCount: 0,
      missingOrUnknownUnitRowCount: 2,
    }),
  ],
  drilldowns: DRILLDOWNS,
  limitations: [
    "Only immutable active AWS CUR 2.0 evidence is analyzed; no live service telemetry is inferred.",
    "Byte normalization uses only the exact pinned unit multipliers; unknown or missing units remain null and disclosed.",
  ],
};

const ENVELOPE = {
  connectionId: CONNECTION_ID,
  selectedPeriod: "2026-07",
  availablePeriods: [
    { period: "2026-07", generationId: GENERATION_ID, committedAtIso: "2026-08-01T02:00:00.000Z" },
  ],
  officialAudit: AUDIT,
  report: REPORT,
  sourceState: "partial",
};

const purposeMarkup = (purpose) => render(view.FinopsDataTransferPurposes, {
  envelope: ENVELOPE,
  initialPurposeKey: view.dataTransferPurposeKey(purpose),
});

test("every AWS-documented purpose renders as its own evidence-backed area", () => {
  assert.equal(AUDIT.documentedVisualPurposes.length, 5);
  for (const item of AUDIT.documentedVisualPurposes) {
    const markup = purposeMarkup(item.purpose);
    assert.ok(
      markup.includes(`<h3>${item.purpose}</h3>`),
      `${item.purpose} is not rendered as the active purpose heading`,
    );
    // Both audit disclosures for the purpose are shown, not just the good half.
    assert.ok(markup.includes(item.nativeEvidence), `${item.purpose} omits its native evidence`);
    assert.ok(markup.includes(item.remainingGap), `${item.purpose} omits its remaining gap`);
    // Every purpose is reachable as a tab, so no purpose is hidden.
    for (const other of AUDIT.documentedVisualPurposes) {
      assert.ok(markup.includes(other.purpose), `${other.purpose} tab is missing`);
    }
    assert.ok(markup.length > 4000, `${item.purpose} rendered an implausibly empty panel`);
  }
});

test("no sheet, visual or control count is claimed for an unpublished definition", () => {
  const markup = purposeMarkup("Data Transfer Summary");
  assert.ok(markup.includes("not available — AWS publishes no definition"));
  assert.ok(markup.includes("exact sheet, visual and control totals are unavailable"));
  assert.equal(/\d[\d,]*\s+(?:official\s+)?(?:sheets?|visuals?)\b/u.test(markup), false);
});

test("the summary purpose keeps exact micros, signs and separated currencies", () => {
  const markup = purposeMarkup("Data Transfer Summary");
  // Exact fractional micros, never rounded to cents.
  assert.ok(markup.includes("USD 1,234.56789"));
  assert.ok(markup.includes("USD 9,876.54321"));
  // A credit keeps its sign with a real unicode minus.
  assert.ok(markup.includes("−USD 2.50"));
  // Unclassified and unknown candidates stay visible.
  assert.ok(markup.includes("Unclassified and unknown transfer candidates"));
  assert.ok(markup.includes("UNCLASSIFIED") || markup.includes("unclassified"));
  // A category with no amount on the basis reports the absence, not a zero.
  assert.ok(markup.includes("No source row carried an amount on the amortized basis"));
  assert.ok(markup.includes("Not available"));
});

test("a withheld percentage explains why it is withheld", () => {
  const markup = purposeMarkup("Data Transfer Summary");
  assert.ok(markup.includes("A percentage composition is withheld for this selection because"));
  assert.ok(markup.includes("a negative part of a total is not a share"));
});

test("byte evidence is exact micro-bytes and unavailable normalization is labelled", () => {
  const markup = purposeMarkup("Data Transfer Summary");
  assert.ok(markup.includes("1,073,741,824,000,000 µB") || markup.includes("1,000,000,000,000,000 µB"));
  assert.ok(markup.includes("rows have a missing or unpinned unit, so no total is claimed"));
});

test("internet and Global Accelerator separates the fixed fee from transfer", () => {
  const markup = purposeMarkup(
    "Internet data transfer and AWS Global Accelerator cost estimation details",
  );
  assert.ok(markup.includes("Global Accelerator fixed fee"));
  assert.ok(markup.includes("USD 18.00"));
  assert.ok(markup.includes("A fixed fee is charged per accelerator"));
  assert.ok(markup.includes("Not applicable"));
  // Billed evidence only: no forward price simulation is offered.
  assert.ok(markup.includes("does not simulate a future"));
  // The unpinned Hrs unit yields no byte total.
  assert.ok(markup.includes("Unit missing or outside the pinned taxonomy"));
});

test("regional detail never substitutes a Region field for a missing endpoint", () => {
  const markup = purposeMarkup("Regional data transfer details");
  assert.ok(markup.includes("us-east-1 → eu-central-1"));
  assert.ok(markup.includes("Source not reported"));
  assert.ok(markup.includes("Destination not reported"));
  assert.ok(markup.includes("could not be routed"));
  // The group with no amount on any basis is unavailable, never USD 0.00.
  assert.ok(markup.includes("No amortized amount on any of the 4 source rows"));
  assert.equal(markup.includes("USD 0.00"), false);
});

test("Availability Zone detail discloses missing zones and endpoint limits", () => {
  const markup = purposeMarkup("Data transfer Availability Zone details");
  assert.ok(markup.includes("us-east-1a"));
  assert.ok(markup.includes("AZ not reported"));
  assert.ok(markup.includes("does not identify both zones of the traffic"));
  // A proven-zero charge is shown as zero and is not counted as paid transfer.
  assert.ok(markup.includes("USD 0.00"));
  assert.ok(/carry no amortized charge and are not presented as paid transfer/u.test(markup));
});

test("CloudFront claims billed cost and usage only", () => {
  const markup = purposeMarkup("CloudFront cost and usage analysis");
  assert.ok(markup.includes("USD 777.00"));
  assert.ok(markup.includes("No CDN telemetry"));
  assert.ok(markup.includes("Amazon CloudFront"));
});

test("source lineage and unretained manifest coverage are disclosed", () => {
  const markup = purposeMarkup("Data Transfer Summary");
  assert.ok(markup.includes(GENERATION_ID));
  assert.ok(markup.includes(MANIFEST_SHA));
  assert.ok(markup.includes("manifest object counts were not retained"));
  assert.ok(markup.includes("MANIFEST OBJECT COVERAGE UNAVAILABLE"));
});

test("an absent report is a labelled state rather than an empty dashboard", () => {
  const markup = render(view.FinopsDataTransferPurposes, {
    envelope: { ...ENVELOPE, report: null, sourceState: "source_incomplete" },
  });
  assert.ok(markup.includes("No data-transfer analysis for this connection"));
  assert.ok(markup.includes("source incomplete"));
  assert.ok(markup.includes("Nothing is shown as zero in the meantime."));
  assert.equal(markup.includes("USD"), false);
});
