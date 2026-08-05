import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * Renders every official sheet of all three Foundational dashboards against a
 * realistic canonical report, and asserts the honesty rules hold: exact micros
 * are printed, missing evidence is disclosed rather than shown as zero, and no
 * sheet is silently blank.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const cudos = await vite.ssrLoadModule("/app/costs/finops-cudos-dashboard.tsx");
const cid = await vite.ssrLoadModule("/app/costs/finops-cost-intelligence-sheets-dashboard.tsx");
const kpi = await vite.ssrLoadModule("/app/costs/finops-kpi-sheets-dashboard.tsx");
const sheets = await vite.ssrLoadModule("/app/costs/finops-foundational-sheets.ts");
after(async () => vite.close());

const render = (component, props) => renderToStaticMarkup(createElement(component, props));

const cost = (basis, totalMicros, coverage = "complete") => ({
  basis, totalMicros, contributingLineCount: 10, missingLineCount: 0, coverage,
});
const COSTS = (micros) => [cost("amortized", micros), cost("unblended", micros)];

const CUDOS_REPORT = {
  ok: true,
  schema: "sutra.finops-cudos.v1",
  selectedCostBasis: "amortized",
  evidence: {
    organizationId: "org_1", customerId: "cus_1", connectionId: `conn_${"a".repeat(32)}`,
    exportName: "foundational-cur2-export-v1", billingPeriod: "2026-07",
    generationId: `fbg_${"b".repeat(64)}`, activeLineCount: 4210,
    sourceFormats: ["parquet"], currencies: ["USD"], evidenceWindow: null,
  },
  executive: [{
    currency: "USD", lineCount: 4210, accountCount: 12, serviceCount: 34,
    regionCount: 6, resourceCount: 980,
    costs: COSTS("1234567890"),
    chargeKinds: [
      { chargeKind: "usage", present: true, lineCount: 4000, sourceChargeKinds: ["Usage"], costs: COSTS("1300000000") },
      { chargeKind: "credit", present: true, lineCount: 40, sourceChargeKinds: ["Credit"], costs: COSTS("-65432110") },
      { chargeKind: "tax", present: false, lineCount: 0, sourceChargeKinds: [], costs: COSTS("0") },
    ],
  }],
  trends: {
    daily: [
      { currency: "USD", period: "2026-07-01", lineCount: 100, costs: COSTS("40000000") },
      { currency: "USD", period: "2026-07-02", lineCount: 110, costs: COSTS("41500000") },
      { currency: "USD", period: "2026-07-03", lineCount: 0, costs: COSTS(null) },
      { currency: "USD", period: "2026-07-04", lineCount: 120, costs: COSTS("43000000") },
    ],
    weekly: [
      { currency: "USD", period: "2026-06-29", lineCount: 700, costs: COSTS("290000000") },
      { currency: "USD", period: "2026-07-06", lineCount: 720, costs: COSTS("301000000") },
    ],
    monthly: [
      { currency: "USD", period: "2026-06", lineCount: 4000, costs: COSTS("1180000000") },
      { currency: "USD", period: "2026-07", lineCount: 4210, costs: COSTS("1234567890") },
    ],
  },
  rankings: {
    accounts: [{ currency: "USD", dimension: "account", rank: 1, value: "111122223333", label: "Platform", lineCount: 900, selectedCostBasis: "amortized", selectedTotalMicros: "500000000", costs: COSTS("500000000") }],
    services: [{ currency: "USD", dimension: "service", rank: 1, value: "AmazonEC2", label: "Amazon EC2", lineCount: 1200, selectedCostBasis: "amortized", selectedTotalMicros: "700000000", costs: COSTS("700000000") }],
    regions: [{ currency: "USD", dimension: "region", rank: 1, value: "us-east-1", label: "US East (N. Virginia)", lineCount: 2000, selectedCostBasis: "amortized", selectedTotalMicros: "800000000", costs: COSTS("800000000") }],
    serviceCategories: [{ currency: "USD", dimension: "service_category", rank: 1, value: "Compute", label: "Compute", lineCount: 1500, selectedCostBasis: "amortized", selectedTotalMicros: "760000000", costs: COSTS("760000000") }],
  },
  commitments: [{
    currency: "USD", costBasis: "amortized",
    coverage: {
      status: "complete", coveredCostMicros: "600000000", classifiedEligibleCostMicros: "1000000000",
      coverageBasisPoints: "6000", coveredLineCount: 500, onDemandLineCount: 300,
      excludedSpotLineCount: 20, unknownClassificationLineCount: 5, missingCostLineCount: 0,
      incompleteReasons: [],
    },
    utilization: {
      status: "partial", appliedUsageCostMicros: "580000000", explicitUnusedCostMicros: "20000000",
      commitmentFeeCostMicros: "600000000", utilizationBasisPoints: null,
      appliedUsageLineCount: 500, explicitUnusedLineCount: 3, commitmentFeeLineCount: 12,
      missingCostLineCount: 0, incompleteReasons: ["no_explicit_unused_commitment_line"],
    },
    trueUp: {
      status: "complete", amortizedMinusUnblendedMicros: "-12000000",
      commitmentLineCount: 12, missingUnblendedLineCount: 0, missingAmortizedLineCount: 0,
    },
  }],
  modules: [
    { moduleId: "compute", lineCount: 1200, services: ["AmazonEC2"], sourceLineIdCount: 1200, sourceLineIds: ["li-1", "li-2"], sourceLineIdsTruncated: true, currencies: [{ currency: "USD", lineCount: 1200, costs: COSTS("700000000") }] },
    { moduleId: "s3", lineCount: 300, services: ["AmazonS3"], sourceLineIdCount: 300, sourceLineIds: ["li-3"], sourceLineIdsTruncated: false, currencies: [{ currency: "USD", lineCount: 300, costs: COSTS("90000000") }] },
    { moduleId: "database", lineCount: 200, services: ["AmazonRDS"], sourceLineIdCount: 200, sourceLineIds: [], sourceLineIdsTruncated: false, currencies: [{ currency: "USD", lineCount: 200, costs: COSTS("150000000") }] },
  ],
  drilldowns: {
    lineCount: 4210,
    resource: { status: "complete", availableLineCount: 4210, missingLineCount: 0 },
    hourly: { status: "partial", availableLineCount: 3000, missingLineCount: 1210 },
    resourceHourly: { status: "unavailable", availableLineCount: 0, missingLineCount: 4210 },
  },
  unitCosts: {
    metrics: [{
      currency: "USD", service: "AmazonEC2", usageUnit: "Hrs", lineCount: 1200,
      costBasis: "amortized", cost: cost("amortized", "700000000"),
      usageQuantityMicros: "3600000000",
      exactRatio: { costMicrosNumerator: "700000000", usageQuantityMicrosDenominator: "3600000000" },
      unavailableReason: null,
    }],
    totalMetrics: 1, truncated: false,
    invariant: "currencies_and_usage_units_are_never_combined",
  },
  opportunities: {
    estimates: [{
      ruleId: "CUDOS_CUR_EXPLICIT_UNUSED_COMMITMENT", ruleVersion: "1.0.0",
      classification: "cur_derived_review_candidate", subjectType: "commitment",
      subjectId: "sp-123", accountId: "111122223333", region: null, service: "AmazonEC2",
      currency: "USD",
      evidenceWindow: { fromInclusiveIso: "2026-07-01T00:00:00.000Z", toExclusiveIso: "2026-08-01T00:00:00.000Z", derivedFrom: "canonical_usage_intervals" },
      estimate: { type: "observed_cost_exposure", costBasis: "amortized", totalMicros: "20000000", isSavingsClaim: false },
      assumptions: [], confidence: "medium", sourceLineIdCount: 3, sourceLineIds: ["li-9"],
      sourceLineIdsTruncated: false, remediationClaim: null, reviewRequired: true,
    }],
    totalCandidates: 1, truncated: false,
    disclaimer: "CUR-derived review candidates are observed billing patterns, not telemetry, savings, compatibility, purchase, or remediation recommendations.",
  },
  failures: [],
};

const CUDOS_ENVELOPE = {
  connectionId: `conn_${"a".repeat(32)}`,
  selectedPeriod: "2026-07",
  availablePeriods: [{ period: "2026-07", generationId: `fbg_${"b".repeat(64)}`, committedAtIso: "2026-08-01T00:00:00.000Z" }],
  report: CUDOS_REPORT,
  sourceState: "complete",
  sourceEvidence: {
    activeGeneration: {
      manifestSha256: "c".repeat(64), generationId: `fbg_${"b".repeat(64)}`,
      sourceUpdatedAtIso: "2026-07-31T22:00:00.000Z", observedAtIso: "2026-08-01T00:00:00.000Z",
      committedAtIso: "2026-08-01T00:00:00.000Z", acceptedRows: 4210, rejectedRows: 0,
      activeFileCount: 3, incompleteReasons: [],
    },
  },
};

const CID_REPORT = {
  ok: true,
  schema: "sutra.finops-cost-intelligence.v1",
  costBasis: "amortized",
  allocationMode: "showback",
  inclusionPolicy: {
    id: "invoice_total",
    description: "Every charge on the invoice is included.",
    classes: { standard: "include", tax: "include", support: "include", credit: "include", refund: "include", marketplace: "include" },
  },
  taxonomyEvidence: { source: "aws_organizations", sourceEvidenceId: "aws-organizations:1", observedAtIso: "2026-08-01T00:00:00.000Z" },
  baselinePeriod: "2026-06",
  comparisonPeriod: "2026-07",
  summaries: [
    { period: "2026-06", currency: "USD", sourceTotalMicros: "1200000000", includedMicros: "1180000000", excludedMicros: "20000000", includedLineCount: 4000, excludedLineCount: 40, excludedByClass: [{ chargeClass: "credit", amountMicros: "20000000", lineCount: 40 }], averageDailyRunRate: { numeratorMicros: "1180000000", observedDays: 30, roundedMicrosPerDay: "39333333" } },
    { period: "2026-07", currency: "USD", sourceTotalMicros: "1260000000", includedMicros: "1234567890", excludedMicros: "25432110", includedLineCount: 4210, excludedLineCount: 45, excludedByClass: [{ chargeClass: "credit", amountMicros: "25432110", lineCount: 45 }], averageDailyRunRate: { numeratorMicros: "1234567890", observedDays: 31, roundedMicrosPerDay: "39824770" } },
  ],
  allocations: [{
    period: "2026-07", currency: "USD", sourceTotalMicros: "1260000000",
    includedMicros: "1234567890", excludedMicros: "25432110",
    rootUnallocatedMicros: "34000000", rootUnallocatedLineCount: 12,
    children: [
      { dimension: "business_unit", value: "Platform", amountMicros: "800000000", lineCount: 2000, unallocatedMicros: "0", unallocatedLineCount: 0, children: [] },
      { dimension: "business_unit", value: "__unallocated__", amountMicros: "34000000", lineCount: 12, unallocatedMicros: "34000000", unallocatedLineCount: 12, children: [] },
    ],
  }],
  movers: [
    { currency: "USD", dimension: "service", value: "AmazonEC2", baselineMicros: "600000000", comparisonMicros: "700000000", absoluteDeltaMicros: "100000000", deltaPercentBasisPoints: "1667", percentageState: "available" },
    { currency: "USD", dimension: "service", value: "AWSLambda", baselineMicros: "0", comparisonMicros: "5000000", absoluteDeltaMicros: "5000000", deltaPercentBasisPoints: null, percentageState: "zero_baseline" },
  ],
  momPivot: {
    baselinePeriod: "2026-06", comparisonPeriod: "2026-07",
    dimensions: ["business_unit", "service"],
    cells: [{ currency: "USD", rowDimension: "business_unit", rowValue: "Platform", columnDimension: "service", columnValue: "AmazonEC2", baselineMicros: "600000000", comparisonMicros: "700000000", deltaMicros: "100000000", deltaPercentBasisPoints: "1667" }],
  },
  explorer: {
    period: "2026-07",
    groups: [{ currency: "USD", dimensions: [{ dimension: "service", value: "AmazonEC2" }], amountMicros: "700000000", lineCount: 1200 }],
  },
  forecasts: [{
    currency: "USD", status: "available", model: "integer_linear_trend_v1",
    trainingWindow: { startPeriod: "2026-02", endPeriod: "2026-07", periods: 6 },
    forecastPeriod: "2026-08", forecastMicros: "1290000000",
    confidenceRange: { method: "mean_absolute_residual_band", lowerMicros: "1250000000", upperMicros: "1330000000", meanAbsoluteResidualMicros: "40000000", disclosure: "deterministic_error_band_not_statistical_confidence" },
    evidenceLabels: ["canonical_export"],
  }],
  commitments: {
    sourcePeriod: "2026-07", asOfIso: "2026-08-01T00:00:00.000Z", expiresWithinDays: 90,
    items: [{
      commitmentArnOrId: "arn:aws:savingsplans::sp-1", commitmentType: "savings_plan",
      terms: { pricingTerm: "1yr", purchaseOption: "no_upfront", chargeFrequency: "monthly", startIso: "2025-09-01T00:00:00.000Z" },
      endIso: "2026-09-01T00:00:00.000Z", expiresInDays: 31, owner: null,
      receivingAccountId: "111122223333", grossMicros: "600000000", usedMicros: "580000000",
      unusedMicros: null, usageQuantity: null, onDemandEquivalentMicros: null, netSavingsMicros: null,
      coverage: { evidenceLabel: "partial", complete: false, missing: ["unused_charges", "public_on_demand_cost", "usage_quantity"] },
    }],
    untrackable: [{ lineItemId: "li-77", reason: "missing_expiry" }],
  },
};

const CID_ENVELOPE = {
  connectionId: `conn_${"a".repeat(32)}`,
  selectedPeriods: ["2026-06", "2026-07"],
  availablePeriods: [{ period: "2026-07", generationId: `fbg_${"b".repeat(64)}`, committedAtIso: "2026-08-01T00:00:00.000Z" }],
  report: CID_REPORT,
  taxonomyConfigured: true,
  sourceState: "complete",
  sourceEvidence: { periods: [{ period: "2026-07", generationId: `fbg_${"b".repeat(64)}`, manifestSha256: "c".repeat(64), sourceUpdatedAtIso: null, observedAtIso: "2026-08-01T00:00:00.000Z", committedAtIso: "2026-08-01T00:00:00.000Z", acceptedRows: 4210, rejectedRows: 0 }] },
};

const KPI_FORMULA = (id, label) => ({
  id, formulaVersion: "1.0.0", label,
  numeratorDefinition: `${id} numerator`, denominatorDefinition: `${id} denominator`,
  targetDirection: "increase", authoritativeEvidenceRequired: false,
  curClassification: "candidate_estimate",
});

const KPI_IDS = [
  "ec2_previous_generation", "ec2_spot_share", "ec2_graviton_share", "ec2_amd_share",
  "ebs_gp3_adoption", "aged_snapshots", "s3_standard_concentration", "rds_graviton_share",
  "rds_open_source_engine_share", "elasticache_graviton_share", "opensearch_graviton_share",
  "lambda_graviton_share", "compute_on_demand_ratio", "sagemaker_on_demand_ratio",
  "rds_on_demand_ratio", "elasticache_on_demand_ratio", "opensearch_on_demand_ratio",
  "redshift_on_demand_ratio", "dynamodb_on_demand_ratio",
];

const KPI_REPORT = {
  ok: true,
  schema: "sutra.finops-kpi.v1",
  scope: {
    organizationId: "org_1", customerId: "cus_1", connectionId: `conn_${"a".repeat(32)}`,
    exportName: "foundational-cur2-export-v1", billingPeriod: "2026-07",
    generationId: `fbg_${"b".repeat(64)}`,
  },
  formulaRegistry: KPI_IDS.map((id) => KPI_FORMULA(id, id.replace(/_/gu, " "))),
  evidenceWindow: {
    startIso: "2026-07-01T00:00:00.000Z", endIso: "2026-07-31T23:59:59.000Z",
    evaluatedAtIso: "2026-08-01T00:00:00.000Z",
    sourceEvidenceId: `aws-data-export:${"c".repeat(64)}`, manifestSha256: "c".repeat(64),
  },
  measurements: KPI_IDS.map((id, index) => ({
    kpiId: id, formulaVersion: "1.0.0",
    state: index === 5 ? "insufficient_evidence" : "measured",
    findingKind: "candidate_estimate", validationRequired: true,
    selectedGoal: index % 3 === 0
      ? {
        id: `goal-${index}`, version: 2, targetDirection: "increase", targetBasisPoints: 5000,
        effectiveFromIso: "2026-01-01T00:00:00.000Z", effectiveToIso: null,
        actorId: "usr_1", auditReference: "ref-1",
        rbacDecisionId: `dec-${index}`, rbacEvidenceReference: "evi-1",
      }
      : null,
    eligibleLineCount: 100, classifiableLineCount: index === 5 ? 0 : 90,
    unclassifiedLineCount: index === 5 ? 100 : 10,
    evidenceCompleteness: index === 5 ? "none" : "partial",
    reasonCodes: index === 5 ? ["AUTHORITATIVE_SNAPSHOT_AGE_EVIDENCE_MISSING"] : ["CUR_INSTANCE_FAMILY_CANDIDATE"],
    segments: index === 5 ? [] : [{
      basis: "usage_quantity", currency: "USD", usageUnit: "Hrs",
      numerator: "3600", denominator: "9000", currentBasisPoints: 4000,
      ratioRemainder: "0", ratioDenominator: "10000",
      goalStatus: index % 3 === 0 ? "not_met" : "no_goal",
      gapBasisPoints: index % 3 === 0 ? -1000 : null,
      sourceLineIds: ["li-1"], sourceLineIdsTruncated: false,
    }],
  })),
  opportunities: [{
    kpiId: "ec2_graviton_share", formulaVersion: "1.0.0",
    evidenceWindowStartIso: "2026-07-01T00:00:00.000Z", evidenceWindowEndIso: "2026-07-31T23:59:59.000Z",
    sourceEvidenceId: "aws-data-export:x", sourceLineId: "li-5", resourceId: "i-123",
    currency: "USD", usageUnit: "Hrs", findingKind: "candidate_estimate", confidence: "low",
    validationRequired: true, assumptionIds: [], assumptionReferences: [],
    estimatedSavingsMicros: null, rateApplicationRemainder: null, rateDenominator: null,
    reasonCode: "CUR_INSTANCE_FAMILY_CANDIDATE",
  }],
  opportunitiesTruncated: false,
  failures: [],
};

const KPI_ENVELOPE = { report: KPI_REPORT, goalsConfigured: 7 };

test("every CUDOS sheet renders content and no sheet is silently blank", () => {
  for (const sheet of sheets.FINOPS_CUDOS_SHEETS.sheets) {
    const html = render(cudos.FinopsCudosSheetContent, { report: CUDOS_REPORT, sheet });
    assert.ok(html.length > 120, `${sheet.name} rendered almost nothing`);
    // A sheet either shows data or states why it cannot.
    const informative = html.includes("<table") || html.includes("role=\"img\"")
      || html.includes("class=\"") || html.includes("role=\"status\"");
    assert.ok(informative, `${sheet.name} rendered no recognizable content`);
  }
});

test("CUDOS prints exact micro amounts and keeps credits negative", () => {
  const billing = render(cudos.FinopsCudosSheetContent, {
    report: CUDOS_REPORT,
    sheet: sheets.findSheet(sheets.FINOPS_CUDOS_SHEETS, "executive-billing-summary"),
  });
  // 1234567890 micros is exactly USD 1,234.56789.
  assert.ok(billing.includes("1,234.56789"), "exact micro amount must be printed in full");
  // A credit keeps its sign with the unicode minus the exact formatter uses.
  assert.ok(billing.includes("−") , "negative amounts must use the unicode minus");
  assert.ok(billing.includes("65.43211"), "credit magnitude must be exact");
  // A charge kind proven absent is disclosed, not omitted.
  assert.ok(billing.includes("Proven absent"));
});

test("a CUDOS trend gap is a gap, never a zero", () => {
  const html = render(cudos.FinopsCudosSheetContent, {
    report: CUDOS_REPORT,
    sheet: sheets.findSheet(sheets.FINOPS_CUDOS_SHEETS, "executive-trends"),
  });
  assert.ok(html.includes("Not collected"), "an uncollected day must say so");
  assert.ok(html.includes("role=\"img\""), "the trend must render as a real chart");
});

test("CUDOS withholds a percentage the engine could not compute", () => {
  const html = render(cudos.FinopsCudosSheetContent, {
    report: CUDOS_REPORT,
    sheet: sheets.findSheet(sheets.FINOPS_CUDOS_SHEETS, "executive-ri-sp-summary"),
  });
  // Coverage is complete and shows a figure; utilization is partial and must not.
  assert.ok(html.includes("60.00%"), "complete coverage must show its exact percentage");
  assert.ok(html.includes("Utilization is unavailable"), "a withheld percentage must be explained");
  assert.ok(html.includes("no explicit unused commitment line"));
});

test("a CUDOS module sheet with no classified line proves absence rather than showing zero", () => {
  const html = render(cudos.FinopsCudosSheetContent, {
    report: CUDOS_REPORT,
    sheet: sheets.findSheet(sheets.FINOPS_CUDOS_SHEETS, "gametech-media"),
  });
  assert.ok(html.includes("proven absence"), "an unclassified module must state proven absence");
  assert.equal(html.includes("$0.00"), false, "absence must not be rendered as zero cost");
});

test("every Cost Intelligence sheet renders content", () => {
  for (const sheet of sheets.FINOPS_COST_INTELLIGENCE_SHEETS.sheets) {
    const html = render(cid.FinopsCostIntelligenceSheetContent, { report: CID_REPORT, sheet });
    assert.ok(html.length > 120, `${sheet.name} rendered almost nothing`);
  }
});

test("Cost Intelligence reports unallocated cost and withholds an undefined percentage", () => {
  const summary = render(cid.FinopsCostIntelligenceSheetContent, {
    report: CID_REPORT,
    sheet: sheets.findSheet(sheets.FINOPS_COST_INTELLIGENCE_SHEETS, "cost-summary"),
  });
  assert.ok(summary.includes("Unallocated"), "unallocated cost must be named, not distributed");

  const changes = render(cid.FinopsCostIntelligenceSheetContent, {
    report: CID_REPORT,
    sheet: sheets.findSheet(sheets.FINOPS_COST_INTELLIGENCE_SHEETS, "summary-of-changes"),
  });
  // A zero baseline cannot produce a percentage; it must say so.
  assert.ok(changes.includes("No baseline"), "a zero-baseline change must not show a percentage");
  assert.ok(changes.includes("16.67%"), "a real change must show its exact percentage");
});

test("Cost Intelligence names the missing commitment evidence per row", () => {
  const html = render(cid.FinopsCostIntelligenceSheetContent, {
    report: CID_REPORT,
    sheet: sheets.findSheet(sheets.FINOPS_COST_INTELLIGENCE_SHEETS, "expiring-ri-sp-tracker"),
  });
  assert.ok(html.includes("unused charges"));
  assert.ok(html.includes("public on demand cost"));
  assert.ok(html.includes("usage quantity"));
  // Untrackable lines are disclosed rather than dropped.
  assert.ok(html.includes("li-77"));
});

test("every KPI sheet renders content", () => {
  for (const sheet of sheets.FINOPS_KPI_SHEETS.sheets) {
    const html = render(kpi.FinopsKpiSheetContent, {
      report: KPI_REPORT, sheet, goalsConfigured: 7,
    });
    assert.ok(html.length > 120, `${sheet.name} rendered almost nothing`);
  }
});

test("a KPI service sheet shows only the formulas the official definition assigns it", () => {
  const ec2Sheet = sheets.findSheet(sheets.FINOPS_KPI_SHEETS, "ec2");
  const html = render(kpi.FinopsKpiSheetContent, {
    report: KPI_REPORT, sheet: ec2Sheet, goalsConfigured: 7,
  });
  assert.deepEqual([...ec2Sheet.formulaIds], [
    "ec2_previous_generation", "ec2_spot_share", "ec2_graviton_share", "ec2_amd_share",
  ]);
  for (const id of ec2Sheet.formulaIds) {
    assert.ok(html.includes(id.replace(/_/gu, " ")), `${id} missing from the EC2 sheet`);
  }
  // A formula belonging to another sheet must not appear here.
  assert.equal(html.includes("s3 standard concentration"), false);
});

test("an unmeasured KPI states its reason instead of showing a value", () => {
  const html = render(kpi.FinopsKpiSheetContent, {
    report: KPI_REPORT,
    sheet: sheets.findSheet(sheets.FINOPS_KPI_SHEETS, "ebs"),
    goalsConfigured: 7,
  });
  assert.ok(html.includes("Not measured"), "an unmeasured KPI must say so");
  assert.ok(
    html.includes("authoritative snapshot age evidence missing"),
    "the reason code must be surfaced",
  );
});

test("KPI goals are presented read-only with their authorization evidence", () => {
  const html = render(kpi.FinopsKpiSheetContent, {
    report: KPI_REPORT,
    sheet: sheets.findSheet(sheets.FINOPS_KPI_SHEETS, "set-kpi-goals"),
    goalsConfigured: 7,
  });
  assert.ok(html.includes("read-only"), "the goals panel must state that it does not mutate");
  assert.ok(html.includes("dec-0"), "the authorization decision must be shown");
  assert.ok(html.includes("50.00%"), "the exact target must be shown");
});

test("KPI withholds a savings estimate with no approved assumption", () => {
  const html = render(kpi.FinopsKpiSheetContent, {
    report: KPI_REPORT,
    sheet: sheets.findSheet(sheets.FINOPS_KPI_SHEETS, "about"),
    goalsConfigured: 7,
  });
  assert.ok(html.includes("Withheld"), "a savings estimate with no rate must be withheld");
  assert.ok(html.includes("candidate estimate"), "measurements must be labelled as candidates");
  // All 19 governed formulas are documented.
  for (const id of KPI_IDS) assert.ok(html.includes(id.replace(/_/gu, " ")), id);
});

test("the sheet shell exposes real tabs for every official sheet", () => {
  const html = render(cudos.FinopsCudosSheets, { envelope: CUDOS_ENVELOPE });
  assert.equal((html.match(/role="tab"/gu) ?? []).length, 19);
  assert.equal((html.match(/role="tabpanel"/gu) ?? []).length, 1);
  assert.equal((html.match(/aria-selected="true"/gu) ?? []).length, 1);
  // The pinned definition totals are shown so the reader knows what is mirrored.
  assert.ok(html.includes("407"));
  assert.ok(html.includes("19"));

  const cidHtml = render(cid.FinopsCostIntelligenceSheets, { envelope: CID_ENVELOPE });
  assert.equal((cidHtml.match(/role="tab"/gu) ?? []).length, 10);
  const kpiHtml = render(kpi.FinopsKpiSheets, { envelope: KPI_ENVELOPE });
  assert.equal((kpiHtml.match(/role="tab"/gu) ?? []).length, 10);
  // KPI mirrors definition v2.2.1.
  assert.ok(kpiHtml.includes("v2.2.1"));
});

test("each sheet discloses its audited coverage and gaps", () => {
  // The Compute sheet is PARTIAL in the CUDOS audit and must show its reason.
  const html = render(cudos.FinopsCudosSheets, {
    envelope: CUDOS_ENVELOPE, initialSheetKey: "compute",
  });
  assert.ok(html.includes("PARTIAL"), "the audited classification must be visible");
  assert.ok(
    html.includes("Telemetry-specific utilization and rightsizing are not inferred from billing rows."),
    "the audited gap text must be shown verbatim",
  );
});

test("a report that is not ok renders nothing rather than a misleading empty dashboard", () => {
  for (const [component, envelope] of [
    [cudos.FinopsCudosSheets, { ...CUDOS_ENVELOPE, report: { ok: false, schema: "sutra.finops-cudos.v1", failures: [{ code: "ROW_LIMIT_EXCEEDED", field: "rows" }] } }],
    [cid.FinopsCostIntelligenceSheets, { ...CID_ENVELOPE, report: null }],
    [kpi.FinopsKpiSheets, { report: null, goalsConfigured: 0 }],
  ]) {
    assert.equal(render(component, { envelope }), "");
  }
});
