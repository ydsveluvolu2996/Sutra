import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");

const [panel, css] = await Promise.all([
  readFile(new URL("../app/costs/finops-wave3-panels.tsx", import.meta.url), "utf8"),
  readFile(new URL("../app/costs/costs.module.css", import.meta.url), "utf8"),
]);

test("Budgets workspace renders the live AWS Cost Anomaly panel", () => {
  assert.match(panel, /<AwsCostAnomalyPanel connectionId=\{connectionId\} \/>/u);
  assert.match(panel, /\/api\/v1\/finops\/cost-anomaly\?connectionId=\$\{encodeURIComponent\(connectionId\)\}/u);
  assert.match(panel, /credentials: "same-origin"/u);
  assert.match(panel, /cache: "no-store"/u);
  assert.match(panel, /Refresh AWS findings/u);
});

test("AWS provider findings remain visibly separate from Sutra statistics", () => {
  assert.match(panel, /Authoritative AWS provider findings/u);
  assert.match(panel, /AWS provider engine/u);
  assert.match(panel, /Sutra statistical engine/u);
  assert.match(panel, /independent from Sutra statistical alerts/u);
  assert.match(panel, /This is not proof that spend is correct or optimized/u);
  assert.match(panel, /no billing lines were available/u);
  assert.doesNotMatch(panel, /demo anomaly|fixture anomaly/iu);
});

test("panel renders honest loading, configuration, waiting, complete, partial, stale, and failed states", () => {
  for (const state of ["waiting", "complete", "partial", "stale", "failed"]) {
    assert.match(panel, new RegExp(`"${state}"`, "u"));
  }
  assert.match(panel, /Loading persisted AWS Cost Anomaly evidence/u);
  assert.match(panel, /Configuration required/u);
  assert.match(panel, /Waiting for the first persisted AWS collection/u);
  assert.match(panel, /Partial AWS coverage/u);
  assert.match(panel, /Provider evidence is stale/u);
  assert.match(panel, /The latest AWS collection failed/u);
  assert.match(panel, /never substitutes sample findings or zero spend/u);
});

test("panel implements official trend, account/service filters, export, root-cause drilldown, and evidence coverage", () => {
  assert.match(panel, /Minimum impact/u);
  assert.match(panel, /Minimum current score/u);
  assert.match(panel, /Linked account/u);
  assert.match(panel, /Anomaly ID/u);
  assert.match(panel, /All services/u);
  assert.match(panel, /All usage types/u);
  assert.match(panel, /All assessments/u);
  assert.match(panel, /All monitor types/u);
  assert.match(panel, /Impact by anomaly month/u);
  assert.match(panel, /Actual versus expected spend/u);
  assert.match(panel, /\["Service", rootCauseMovers\.services\]/u);
  assert.match(panel, /\["Linked account", rootCauseMovers\.accounts\]/u);
  assert.match(panel, /\["Region", rootCauseMovers\.regions\]/u);
  assert.match(panel, /\["Usage type", rootCauseMovers\.usageTypes\]/u);
  assert.match(panel, /\{label\} contribution/u);
  assert.match(panel, /Export filtered CSV/u);
  assert.match(panel, /Root-cause drilldown/u);
  assert.match(panel, /Read-only provider operation coverage/u);
  assert.match(panel, /Provider monitor coverage by method and dimension/u);
  assert.match(panel, /Provider alert subscription coverage/u);
  assert.match(panel, /recipient addresses remain redacted/u);
  assert.match(panel, /billing currency units/u);
  assert.match(panel, /\^\[=\+\\-@\]/u);
  assert.doesNotMatch(panel, /impact\.total\s*\?\?\s*anomaly\.impact\.maximum/u);
  assert.doesNotMatch(panel, /money\(anomaly\.impact\.[\s\S]{0,100}"USD"/u);
});

test("enterprise layout has responsive provider and Sutra evidence cards", () => {
  assert.match(css, /\.costAnomalyKpis \{ display: grid; grid-template-columns: repeat\(4/u);
  assert.match(css, /\.costAnomalySources \{ display: grid; grid-template-columns: repeat\(2/u);
  assert.match(css, /@media screen and \(max-width: 860px\)[\s\S]*\.costAnomalySources \{ grid-template-columns: 1fr;/u);
  assert.match(css, /@media screen and \(max-width: 520px\)[\s\S]*\.costAnomalyKpis \{ grid-template-columns: 1fr;/u);
  assert.match(panel, /aria-label="AWS Cost Anomaly summary"/u);
  assert.match(panel, /aria-label="AWS provider anomaly findings"/u);
  assert.match(panel, /aria-label="Sutra statistical anomaly signals"/u);
});

test("complete provider evidence renders filters, trends, root causes, and coverage without fixtures", async () => {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const anomalyModule = await vite.ssrLoadModule("/app/costs/finops-wave3-panels.tsx");
    const initialData = {
      state: "complete",
      latestAttemptStatus: "succeeded",
      collectedAt: "2026-08-01T10:00:00.000Z",
      dataThroughAt: "2026-08-01T09:00:00.000Z",
      freshness: { ageHours: 1, staleAfterHours: 36 },
      sutraInput: { periods: ["2026-07"], lineCount: 1, capped: false },
      dashboard: {
        aws: {
          status: "COMPLETE",
          windowStartDate: "2026-07-01",
          windowEndDate: "2026-08-01",
          coverage: [{ operation: "GET_ANOMALIES", status: "SUCCEEDED", pagesObserved: 1, recordsObserved: 1, recordsAccepted: 1, recordsRejected: 0, recordsOmitted: 0, errorCode: null }],
          anomalies: [{
            anomalyId: "anomaly-render",
            startDate: "2026-07-20",
            endDate: "2026-07-21",
            feedback: "PLANNED_ACTIVITY",
            monitorType: "DIMENSIONAL",
            monitorDimension: "SERVICE",
            score: { current: 82, maximum: 91 },
            impact: { maximum: 125, total: 120, actualSpend: 320, expectedSpend: 200, percentage: 60 },
            rootCauses: [{ service: "Amazon EC2", region: "us-east-1", linkedAccountId: "111122223333", usageType: "BoxUsage:m7g.large", contribution: 110 }],
            rootCausesOmitted: 0,
          }],
          monitors: [{ type: "DIMENSIONAL", dimension: "SERVICE", specificationPresent: false, dimensionalValueCount: 25, lastEvaluatedAt: "2026-08-01T09:00:00.000Z" }],
          subscriptions: [{ frequency: "IMMEDIATE", threshold: 100, monitorCount: 1, monitorArnsOmitted: 0, thresholdExpressionPresent: false, subscriberCounts: { emailConfirmed: 0, emailDeclined: 0, snsConfirmed: 1, snsDeclined: 0, unknown: 0 } }],
          disclaimer: "Provider evidence only.",
        },
        sutra: { anomalies: [], evaluatedDays: 1, disclaimer: "Independent statistical evidence." },
        analysis: {
          schema: "sutra.aws-cost-anomaly-analysis.v1",
          lifecycleBasis: "PROVIDER_END_DATE_RELATIVE_TO_COLLECTION_DAY",
          summary: {
            findingCount: 1,
            openWindowCount: 0,
            endedWindowCount: 1,
            missingStartDateCount: 0,
            missingRootCauseCount: 0,
            totalImpact: { total: 120, observedValueCount: 1, unavailableValueCount: 0 },
            maximumImpact: { total: 125, observedValueCount: 1, unavailableValueCount: 0 },
            actualSpend: { total: 320, observedValueCount: 1, unavailableValueCount: 0 },
            expectedSpend: { total: 200, observedValueCount: 1, unavailableValueCount: 0 },
            assessmentCounts: { accurateAnomaly: 0, notAnIssue: 0, plannedActivity: 1, notSubmitted: 0 },
          },
          monthly: [{ month: "2026-07", findingCount: 1, totalImpact: { total: 120, observedValueCount: 1, unavailableValueCount: 0 }, actualSpend: { total: 320, observedValueCount: 1, unavailableValueCount: 0 }, expectedSpend: { total: 200, observedValueCount: 1, unavailableValueCount: 0 } }],
          movers: {
            service: [{ value: "Amazon EC2", findingCount: 1, contribution: { total: 110, observedValueCount: 1, unavailableValueCount: 0 } }],
            linkedAccount: [{ value: "111122223333", findingCount: 1, contribution: { total: 110, observedValueCount: 1, unavailableValueCount: 0 } }],
            region: [{ value: "us-east-1", findingCount: 1, contribution: { total: 110, observedValueCount: 1, unavailableValueCount: 0 } }],
            usageType: [{ value: "BoxUsage:m7g.large", findingCount: 1, contribution: { total: 110, observedValueCount: 1, unavailableValueCount: 0 } }],
          },
          monitorCoverage: [{ type: "DIMENSIONAL", dimension: "SERVICE", monitorCount: 1, evaluatedMonitorCount: 1 }],
          subscriptionCoverage: [{ frequency: "IMMEDIATE", subscriptionCount: 1, numericThresholdCount: 1, expressionThresholdCount: 0, confirmedEmailSubscriberCount: 0, confirmedSnsSubscriberCount: 1, declinedSubscriberCount: 0, unknownSubscriberCount: 0 }],
        },
        disclaimer: "No optimization or invoice assurance.",
      },
    };
    const markup = renderToStaticMarkup(createElement(anomalyModule.AwsCostAnomalyPanel, {
      connectionId: `conn_${"a".repeat(32)}`,
      initialData,
    }));
    assert.match(markup, /Amazon EC2/u);
    assert.match(markup, /Impact by anomaly month/u);
    assert.match(markup, /Actual versus expected spend/u);
    assert.match(markup, /Service contribution/u);
    assert.match(markup, /Linked account contribution/u);
    assert.match(markup, /Region contribution/u);
    assert.match(markup, /Usage type contribution/u);
    assert.match(markup, /Planned activity/u);
    assert.match(markup, /DIMENSIONAL/u);
    assert.match(markup, /Provider alert subscription coverage/u);
    assert.match(markup, /Export filtered CSV/u);
    assert.match(markup, /Root-cause drilldown/u);
    assert.match(markup, /GET ANOMALIES/u);
    assert.match(markup, /billing currency units/u);
    assert.doesNotMatch(markup, /fixture|sample finding|placeholder spend/iu);
  } finally {
    await vite.close();
  }
});
