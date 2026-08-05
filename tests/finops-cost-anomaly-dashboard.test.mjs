import assert from "node:assert/strict";
import { after, test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

/**
 * Renders every official sheet of the ADV-03 Cost Anomaly dashboard against a
 * realistic `/api/v1/finops/cost-anomaly` envelope and asserts the honesty rules
 * hold:
 *
 * - AWS-reported amounts are printed exactly as AWS reported them, unrounded.
 * - Sutra statistical amounts are integer micro-unit strings and are printed
 *   exactly with the canonical micro formatter.
 * - A value AWS withheld is a labelled gap, never a zero.
 * - A percentage AWS did not report is stated as withheld, never derived.
 * - A negative provider percentage keeps its sign.
 * - With no accepted materialization, nothing is presented as measured.
 */

const vite = await createServer({
  root: new URL("..", import.meta.url).pathname,
  configFile: false,
  logLevel: "silent",
  plugins: [react()],
  server: { middlewareMode: true },
});
const anomaly = await vite.ssrLoadModule("/app/costs/finops-cost-anomaly-dashboard.tsx");
const definition = await vite.ssrLoadModule("/lib/finops-cost-anomaly-official-definition.ts");
after(async () => vite.close());

const render = (component, props) => renderToStaticMarkup(createElement(component, props));

const OFFICIAL = definition.COST_ANOMALY_OFFICIAL_DEFINITION;
const SHEETS = anomaly.FINOPS_COST_ANOMALY_SHEETS;

const amount = (total, observed, unavailable) => ({
  total, observedValueCount: observed, unavailableValueCount: unavailable,
});

const ANOMALIES = [
  {
    anomalyId: "a-1",
    startDate: "2026-07-03",
    endDate: "2026-07-05",
    feedback: "YES",
    score: { current: 84, maximum: 91 },
    impact: {
      maximum: 410.5,
      total: 1234.567891,
      actualSpend: 5678.9,
      expectedSpend: 4444.332109,
      percentage: 27.78,
    },
    rootCauses: [
      {
        service: "AmazonEC2", region: "us-east-1", linkedAccountId: "111122223333",
        usageType: "BoxUsage:m6i.large", contribution: 900.25,
      },
      {
        service: "AmazonRDS", region: "us-west-2", linkedAccountId: "444455556666",
        usageType: null, contribution: null,
      },
    ],
    rootCausesOmitted: 2,
    monitorType: "DIMENSIONAL",
    monitorDimension: "SERVICE",
  },
  {
    anomalyId: "a-2",
    startDate: "2026-07-20",
    endDate: null,
    feedback: null,
    score: { current: 66, maximum: 66 },
    impact: {
      maximum: 88.125, total: 88.125, actualSpend: 300.5, expectedSpend: 212.375,
      // AWS can report a negative impact percentage; the sign is preserved.
      percentage: -12.5,
    },
    rootCauses: [{
      service: "AmazonS3", region: null, linkedAccountId: null,
      usageType: "TimedStorage-ByteHrs", contribution: 50.5,
    }],
    rootCausesOmitted: 0,
    monitorType: "CUSTOM",
    monitorDimension: null,
  },
  {
    anomalyId: "a-3",
    startDate: null,
    endDate: "2026-07-01",
    feedback: "PLANNED_ACTIVITY",
    score: { current: 12, maximum: 40 },
    impact: {
      maximum: 15, total: null, actualSpend: null, expectedSpend: null, percentage: null,
    },
    rootCauses: [],
    rootCausesOmitted: 0,
    monitorType: null,
    monitorDimension: null,
  },
  {
    anomalyId: "a-4",
    startDate: "2026-06-15",
    endDate: "2026-06-20",
    feedback: "NO",
    score: { current: 30, maximum: 35 },
    impact: {
      maximum: 5, total: null, actualSpend: null, expectedSpend: null, percentage: null,
    },
    rootCauses: [],
    rootCausesOmitted: 0,
    monitorType: "DIMENSIONAL",
    monitorDimension: "LINKED_ACCOUNT",
  },
];

const ANALYSIS = {
  schema: "sutra.aws-cost-anomaly-analysis.v1",
  lifecycleBasis: "PROVIDER_END_DATE_RELATIVE_TO_COLLECTION_DAY",
  summary: {
    findingCount: 4,
    openWindowCount: 1,
    endedWindowCount: 3,
    missingStartDateCount: 1,
    missingRootCauseCount: 2,
    totalImpact: amount(1234.567891 + 88.125, 2, 2),
    maximumImpact: amount(410.5 + 88.125 + 15 + 5, 4, 0),
    actualSpend: amount(5678.9 + 300.5, 2, 2),
    expectedSpend: amount(4444.332109 + 212.375, 2, 2),
    assessmentCounts: {
      accurateAnomaly: 1, notAnIssue: 1, plannedActivity: 1, notSubmitted: 1,
    },
  },
  monthly: [
    {
      month: "2026-06",
      findingCount: 1,
      totalImpact: amount(null, 0, 1),
      actualSpend: amount(null, 0, 1),
      expectedSpend: amount(null, 0, 1),
    },
    {
      month: "2026-07",
      findingCount: 2,
      totalImpact: amount(1234.567891 + 88.125, 2, 0),
      actualSpend: amount(5678.9 + 300.5, 2, 0),
      expectedSpend: amount(4444.332109 + 212.375, 2, 0),
    },
  ],
  movers: {
    service: [
      { value: "AmazonEC2", findingCount: 1, contribution: amount(900.25, 1, 0) },
      { value: "AmazonS3", findingCount: 1, contribution: amount(50.5, 1, 0) },
      { value: "AmazonRDS", findingCount: 1, contribution: amount(null, 0, 1) },
    ],
    linkedAccount: [
      { value: "111122223333", findingCount: 1, contribution: amount(900.25, 1, 0) },
      { value: "444455556666", findingCount: 1, contribution: amount(null, 0, 1) },
    ],
    region: [
      { value: "us-east-1", findingCount: 1, contribution: amount(900.25, 1, 0) },
      { value: "us-west-2", findingCount: 1, contribution: amount(null, 0, 1) },
    ],
    usageType: [
      { value: "BoxUsage:m6i.large", findingCount: 1, contribution: amount(900.25, 1, 0) },
      { value: "TimedStorage-ByteHrs", findingCount: 1, contribution: amount(50.5, 1, 0) },
    ],
  },
  monitorCoverage: [
    { type: "CUSTOM", dimension: null, monitorCount: 1, evaluatedMonitorCount: 0 },
    { type: "DIMENSIONAL", dimension: "SERVICE", monitorCount: 1, evaluatedMonitorCount: 1 },
  ],
  subscriptionCoverage: [
    {
      frequency: "DAILY", subscriptionCount: 1, numericThresholdCount: 1,
      expressionThresholdCount: 0, confirmedEmailSubscriberCount: 2,
      confirmedSnsSubscriberCount: 1, declinedSubscriberCount: 1, unknownSubscriberCount: 1,
    },
    {
      frequency: "IMMEDIATE", subscriptionCount: 1, numericThresholdCount: 0,
      expressionThresholdCount: 1, confirmedEmailSubscriberCount: 0,
      confirmedSnsSubscriberCount: 0, declinedSubscriberCount: 0, unknownSubscriberCount: 0,
    },
  ],
};

const REPORT = {
  aws: {
    source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION",
    status: "PARTIAL",
    windowStartDate: "2026-06-05",
    windowEndDate: "2026-08-04",
    coverage: [
      {
        operation: "GET_ANOMALIES", status: "SUCCEEDED", pagesObserved: 2,
        recordsObserved: 4, recordsAccepted: 4, recordsRejected: 0, recordsOmitted: 0,
        errorCode: null,
      },
      {
        operation: "GET_ANOMALY_MONITORS", status: "SUCCEEDED", pagesObserved: 1,
        recordsObserved: 2, recordsAccepted: 2, recordsRejected: 0, recordsOmitted: 0,
        errorCode: null,
      },
      {
        operation: "GET_ANOMALY_SUBSCRIPTIONS", status: "PARTIAL", pagesObserved: 1,
        recordsObserved: 3, recordsAccepted: 2, recordsRejected: 1, recordsOmitted: 0,
        errorCode: "THROTTLED",
      },
    ],
    anomalies: ANOMALIES,
    monitors: [
      {
        type: "DIMENSIONAL", dimension: "SERVICE", specificationPresent: true,
        dimensionalValueCount: 42, lastEvaluatedAt: "2026-08-04T05:00:00.000Z",
      },
      {
        type: "CUSTOM", dimension: null, specificationPresent: false,
        dimensionalValueCount: null, lastEvaluatedAt: null,
      },
    ],
    subscriptions: [
      {
        frequency: "DAILY", monitorCount: 2, monitorArnsOmitted: 1, threshold: 100.5,
        thresholdExpressionPresent: false,
        subscriberCounts: {
          emailConfirmed: 2, emailDeclined: 1, snsConfirmed: 1, snsDeclined: 0, unknown: 1,
        },
      },
      {
        frequency: "IMMEDIATE", monitorCount: 1, monitorArnsOmitted: 0, threshold: null,
        thresholdExpressionPresent: true,
        subscriberCounts: {
          emailConfirmed: 0, emailDeclined: 0, snsConfirmed: 0, snsDeclined: 0, unknown: 0,
        },
      },
    ],
    disclaimer:
      "AWS findings, impact, scores, and root causes are provider observations "
      + "returned by AWS Cost Anomaly Detection for the displayed window.",
  },
  sutra: {
    source: "SUTRA_STATISTICAL_BILLING_SIGNALS",
    anomalies: [{
      dateIso: "2026-07-14", service: "AmazonEC2", currency: "USD",
      amountMicros: "1234567890", baselineMicros: "400000000", ratio: 3.0864,
    }],
    evaluatedDays: 61,
    disclaimer: "Statistical billing signals are not provider findings.",
  },
  analysis: ANALYSIS,
  disclaimer:
    "AWS Cost Anomaly Detection findings and Sutra statistical billing signals "
    + "are independent sources. Absence in one source is not evidence that the "
    + "other source is complete or that spend is correct.",
};

const ENVELOPE = {
  source: "AWS_COST_EXPLORER_COST_ANOMALY_DETECTION",
  officialDefinition: OFFICIAL,
  state: "partial",
  latestAttemptStatus: "partial",
  collectedAt: "2026-08-04T06:00:00.000Z",
  dataThroughAt: "2026-08-04T00:00:00.000Z",
  freshness: { ageHours: 6, staleAfterHours: 36 },
  dashboard: REPORT,
  sutraInput: { periods: ["2026-07", "2026-06"], lineCount: 41_200, capped: true },
};

const WAITING_ENVELOPE = {
  ...ENVELOPE,
  state: "waiting",
  latestAttemptStatus: "running",
  collectedAt: null,
  dataThroughAt: null,
  freshness: { ageHours: null, staleAfterHours: 36 },
  dashboard: null,
  sutraInput: { periods: [], lineCount: 0, capped: false },
};

const sheet = (key) => {
  const found = SHEETS.sheets.find((entry) => entry.key === key);
  assert.ok(found !== undefined, `sheet ${key} is missing from the inventory`);
  return found;
};

const anomaliesSheet = () => render(anomaly.FinopsCostAnomalySheetContent, {
  envelope: ENVELOPE, sheet: sheet("aws-cost-anomalies"),
});
const aboutSheet = () => render(anomaly.FinopsCostAnomalySheetContent, {
  envelope: ENVELOPE, sheet: sheet("about"),
});

test("the sheet inventory is exactly the pinned official definition", () => {
  assert.equal(SHEETS.totalSheets, OFFICIAL.totals.sheets);
  assert.equal(SHEETS.totalVisuals, OFFICIAL.totals.visuals);
  assert.equal(
    SHEETS.totalControls,
    OFFICIAL.totals.parameterControls + OFFICIAL.totals.filterControls,
  );
  assert.equal(SHEETS.totalSheets, 2);
  assert.equal(SHEETS.totalVisuals, 6);
  assert.equal(SHEETS.totalControls, 12);
  assert.deepEqual(SHEETS.sheets.map((entry) => entry.key), ["aws-cost-anomalies", "about"]);
  // No sheet may claim full coverage while the audit records a partial visual.
  assert.equal(SHEETS.supportedSheets, 0);
  assert.equal(SHEETS.source.sha256, OFFICIAL.source.embeddedDefinitionSha256);
});

test("every official sheet renders real content and no sheet is silently blank", () => {
  for (const entry of SHEETS.sheets) {
    for (const envelope of [ENVELOPE, WAITING_ENVELOPE]) {
      const html = render(anomaly.FinopsCostAnomalySheetContent, { envelope, sheet: entry });
      assert.ok(html.length > 120, `${entry.name} rendered almost nothing`);
      const informative = html.includes("<table")
        || html.includes("role=\"img\"")
        || html.includes("role=\"status\"");
      assert.ok(informative, `${entry.name} rendered no recognizable content`);
    }
  }
});

test("provider amounts print exactly as AWS reported them, unrounded", () => {
  const html = anomaliesSheet();
  // 1234.567891 keeps all six decimals and gains only digit grouping.
  assert.ok(html.includes("1,234.567891"), "the provider total impact must not be rounded");
  assert.ok(html.includes("4,444.332109"), "the provider expected spend must not be rounded");
  assert.ok(html.includes("88.125"), "a provider amount with three decimals stays exact");
  assert.ok(html.includes("900.25"), "a root-cause contribution stays exact");
});

test("a value AWS withheld is a labelled gap, never a zero", () => {
  const html = anomaliesSheet();
  assert.ok(html.includes("Not reported by AWS"), "a withheld provider value must say so");
  // Two of four findings reported a total impact; the aggregate says so explicitly.
  assert.ok(
    html.includes("2 of 4 findings reported this value"),
    "an aggregate must disclose how many findings carried the value",
  );
  assert.ok(html.includes("2 withheld by AWS"), "withheld provider values must be counted");
  // A finding with no provider start date is excluded from every start-date group
  // and says so rather than being bucketed into an invented period.
  assert.ok(html.includes("no provider start date"));
  assert.ok(html.includes("remain listed in the details table"));
  // A period whose findings reported no impact is a chart gap labelled as such.
  assert.ok(html.includes("Not collected"), "an uncollected period must say so");
});

test("a percentage AWS did not report is withheld, and a negative one keeps its sign", () => {
  const html = anomaliesSheet();
  assert.ok(html.includes("Withheld by AWS"), "an unreported percentage must be withheld");
  assert.ok(html.includes("27.78%"), "a reported percentage must be shown exactly");
  assert.ok(html.includes("−12.5%"), "a negative percentage keeps its sign with a unicode minus");
});

test("root causes AWS did not attribute are never inferred", () => {
  const html = anomaliesSheet();
  assert.ok(html.includes("AWS returned no root cause"));
  assert.ok(html.includes("omitted by the bounded read"), "a bounded read must disclose omissions");
  assert.ok(html.includes("Not supplied"), "an unsupplied root-cause dimension must say so");
  assert.ok(
    html.includes("ranking rather than plotted as zero"),
    "a mover with no contribution must be excluded and disclosed, not plotted as zero",
  );
  assert.ok(html.includes("AmazonRDS"), "the excluded mover must still be named");
});

test("the provider lifecycle uses the collection day and states its basis", () => {
  const html = anomaliesSheet();
  assert.ok(html.includes("Open window"));
  assert.ok(html.includes("Window ended"));
  assert.ok(html.includes("provider end date relative to collection day"));
  // The official Active/Past gap is preserved verbatim from the audit.
  assert.ok(html.includes(
    "AWS CID Active/Past uses last-update age and a configurable day parameter",
  ));
});

test("monitors, subscriptions and per-operation coverage are shown as collected", () => {
  const html = anomaliesSheet();
  assert.ok(html.includes("Detection coverage"));
  assert.ok(html.includes("Expression threshold only"), "an expression-only threshold must say so");
  assert.ok(html.includes("100.5"), "a numeric subscription threshold stays exact");
  assert.ok(html.includes("Not reported"), "an absent monitor dimension must say so");
  assert.ok(html.includes("omitted"), "omitted monitor references must be disclosed");
  assert.ok(html.includes("THROTTLED"), "a failed or partial operation shows its error code");
  assert.ok(
    html.includes("does not publish an expected total-record count"),
    "completeness must not be expressed as a percentage AWS cannot support",
  );
});

test("every official visual renders as a real chart or table with its audit note", () => {
  const html = anomaliesSheet();
  assert.ok((html.match(/role="img"/gu) ?? []).length >= 4, "the visuals must be real charts");
  assert.ok((html.match(/<table/gu) ?? []).length >= 4, "exact values must exist as tables");
  for (const visual of OFFICIAL.sheets[0].visuals) {
    assert.ok(html.includes(visual.remainingGap), `${visual.name} lost its audited gap`);
  }
});

test("Sutra statistical signals print exact micro-units and stay a separate source", () => {
  const html = aboutSheet();
  // 1234567890 micros is exactly USD 1,234.56789.
  assert.ok(html.includes("USD 1,234.56789"), "statistical micros must print exactly");
  assert.ok(html.includes("USD 400.00"), "a whole micro amount keeps two decimals");
  assert.ok(html.includes("Statistical billing signals are not provider findings."));
  assert.ok(html.includes("independent sources"), "the two engines must not be conflated");
  assert.ok(
    html.includes("capped"),
    "a capped statistical input must be disclosed so absence is not read as proof",
  );
});

test("the About sheet proves the pinned definition and preserves the disclosures", () => {
  const html = aboutSheet();
  assert.ok(html.includes(OFFICIAL.source.commit));
  assert.ok(html.includes(OFFICIAL.source.manifestSha256));
  assert.ok(html.includes(OFFICIAL.source.embeddedDefinitionSha256));
  assert.ok(html.includes("Matches pin"));
  assert.ok(html.includes("no standalone query artifact is published"));
  // React escapes apostrophes in text nodes; compare against the escaped form.
  const escaped = (value) => value.replaceAll("'", "&#x27;");
  for (const note of OFFICIAL.disclosures) assert.ok(html.includes(escaped(note)), note);
  for (const name of OFFICIAL.parameterDeclarations) assert.ok(html.includes(name), name);
});

test("the About sheet reports freshness from the provider timestamp", () => {
  const html = aboutSheet();
  assert.ok(html.includes("6 hours"), "the provider evidence age must be shown");
  assert.ok(html.includes("stale after 36 hours"));
  assert.ok(html.includes("partial"), "the collection state must be visible");
});

test("with no accepted materialization nothing is presented as measured", () => {
  const anomalies = render(anomaly.FinopsCostAnomalySheetContent, {
    envelope: WAITING_ENVELOPE, sheet: sheet("aws-cost-anomalies"),
  });
  assert.ok(anomalies.includes("never zero"), "missing provider evidence must say it is not zero");
  assert.ok(anomalies.includes("collecting or unavailable"));
  assert.equal(
    anomalies.includes("Observed total impact"),
    false,
    "no aggregate may be shown without an accepted materialization",
  );

  const about = render(anomaly.FinopsCostAnomalySheetContent, {
    envelope: WAITING_ENVELOPE, sheet: sheet("about"),
  });
  // The pinned definition is still provable, and freshness is withheld.
  assert.ok(about.includes(OFFICIAL.source.embeddedDefinitionSha256));
  assert.ok(about.includes("Not available"), "an absent timestamp must be labelled");
  assert.ok(about.includes("none is available for this connection yet"));
});

test("the sheet shell exposes real tabs for both official sheets", () => {
  const html = render(anomaly.FinopsCostAnomalySheets, { envelope: ENVELOPE });
  assert.equal((html.match(/role="tab"/gu) ?? []).length, 2);
  assert.equal((html.match(/role="tabpanel"/gu) ?? []).length, 1);
  assert.equal((html.match(/aria-selected="true"/gu) ?? []).length, 1);
  assert.ok(html.includes("official sheets"));
  assert.ok(html.includes(OFFICIAL.source.embeddedDefinitionSha256.slice(0, 12)));
  // The status strip states the partial collection plainly.
  assert.ok(html.includes("4 accepted findings"));
  assert.ok(html.includes("At least one bounded AWS operation did not complete"));
});

test("the About sheet can be opened directly from the shell", () => {
  const html = render(anomaly.FinopsCostAnomalySheets, {
    envelope: ENVELOPE, initialSheetKey: "about",
  });
  assert.ok(html.includes("Matches pin"));
  assert.equal((html.match(/aria-selected="true"/gu) ?? []).length, 1);
});
