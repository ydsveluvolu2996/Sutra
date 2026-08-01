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
  assert.match(panel, /Payer account/u);
  assert.match(panel, /All services/u);
  assert.match(panel, /Impact by anomaly month/u);
  assert.match(panel, /Impact by service/u);
  assert.match(panel, /Export filtered CSV/u);
  assert.match(panel, /Root-cause drilldown/u);
  assert.match(panel, /Read-only provider operation coverage/u);
  assert.match(panel, /billing currency units/u);
  assert.match(panel, /\^\[=\+\\-@\]/u);
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
            score: { current: 82, maximum: 91 },
            impact: { maximum: 125, total: 120, actualSpend: 320, expectedSpend: 200, percentage: 60 },
            rootCauses: [{ service: "Amazon EC2", region: "us-east-1", linkedAccountId: "111122223333", usageType: "BoxUsage:m7g.large", contribution: 110 }],
            rootCausesOmitted: 0,
          }],
          monitors: [{ type: "DIMENSIONAL", dimension: "SERVICE", lastEvaluatedAt: "2026-08-01T09:00:00.000Z" }],
          subscriptions: [{ frequency: "IMMEDIATE", threshold: 100, monitorCount: 1 }],
          disclaimer: "Provider evidence only.",
        },
        sutra: { anomalies: [], evaluatedDays: 1, disclaimer: "Independent statistical evidence." },
        disclaimer: "No optimization or invoice assurance.",
      },
    };
    const markup = renderToStaticMarkup(createElement(anomalyModule.AwsCostAnomalyPanel, {
      connectionId: `conn_${"a".repeat(32)}`,
      initialData,
    }));
    assert.match(markup, /Amazon EC2/u);
    assert.match(markup, /Impact by anomaly month/u);
    assert.match(markup, /Export filtered CSV/u);
    assert.match(markup, /Root-cause drilldown/u);
    assert.match(markup, /GET ANOMALIES/u);
    assert.match(markup, /billing currency units/u);
    assert.doesNotMatch(markup, /fixture|sample finding|placeholder spend/iu);
  } finally {
    await vite.close();
  }
});
