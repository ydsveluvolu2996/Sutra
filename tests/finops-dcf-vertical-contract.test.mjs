import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import react from "@vitejs/plugin-react";
import { createServer } from "vite";

const root = path.resolve(import.meta.dirname, "..");
test("DCF vertical is same-tenant immutable and runtime-honest", async () => {
  const route = await readFile(
    new URL(
      "../app/api/v1/finops/data-collection-monitor/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /assertSessionCapability/u);
  assert.match(route, /DcfRuntimeRepository/u);
  assert.match(route, /getRuntimeStatus/u);
  assert.equal((route.match(/officialDefinition:\s*DATA_COLLECTION_MONITOR_OFFICIAL_DEFINITION/gu) ?? []).length, 2);
  const ui = await readFile(
    new URL(
      "../app/costs/finops-data-collection-monitor-dashboard.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  for (const value of [
    "retries",
    "latency",
    "coverage",
    "validated Step Functions execution",
    "Execution telemetry, not source truth",
    "Status Category",
    "Days back",
    "Log Links Mode",
    "All modules",
    "Execution status categories",
    "complete embedded definition",
    "no screenshot geometry is inferred",
    "hasPinnedOfficialDefinition",
  ])
    assert.match(ui, new RegExp(value, "iu"));
  for (const url of [
    new URL(
      "../drizzle/0107_finops_dcf_execution_history.sql",
      import.meta.url,
    ),
    new URL(
      "../postgres/migrations/0102_finops_dcf_execution_history.sql",
      import.meta.url,
    ),
  ])
    assert.match(await readFile(url, "utf8"), /FINOPS_DCF_SNAPSHOT_IMMUTABLE/u);
  assert.match(
    await readFile(
      new URL(
        "../postgres/migrations/0102_finops_dcf_execution_history.sql",
        import.meta.url,
      ),
      "utf8",
    ),
    /REVOKE ALL ON finops_dcf_snapshots FROM PUBLIC/u,
  );
});

test("DCF native UI renders the exact public artifact and sheet audit with execution evidence", async () => {
  const vite = await createServer({
    root,
    configFile: false,
    logLevel: "silent",
    plugins: [react()],
    server: { middlewareMode: true },
  });
  try {
    const dashboardModule = await vite.ssrLoadModule(
      "/app/costs/finops-data-collection-monitor-dashboard.tsx",
    );
    const definitionModule = await vite.ssrLoadModule(
      "/lib/finops-data-collection-monitor-official-definition.ts",
    );
    const report = {
      connectionId: `conn_${"a".repeat(32)}`,
      officialDefinition: definitionModule.DATA_COLLECTION_MONITOR_OFFICIAL_DEFINITION,
      collection: {
        state: "ready",
        reason: "DCF_COLLECTION_READY",
        sourceState: "READY",
        lastAttemptAt: "2026-08-02T00:00:00.000Z",
      },
      generatedAtIso: "2026-08-02T00:00:00.000Z",
      summary: {
        moduleCount: 1,
        executionCount: 1,
        runningCount: 0,
        failureCount: 1,
        retryCount: 1,
        staleModuleCount: 0,
      },
      modules: [{
        moduleId: "cur",
        moduleName: "CUR collector",
        sourceId: "aws_cur2_data_export",
        executionCount: 1,
        successCount: 0,
        failureCount: 1,
        retryCount: 1,
        lastStartedAt: "2026-08-01T23:00:00.000Z",
        latestStatus: "FAILED",
        latencyMs: [600_000],
        coverage: { accepted: 90, rejected: 10, expected: 100 },
      }],
      executions: [{
        generationId: `dcg_${"b".repeat(64)}`,
        moduleId: "cur",
        moduleName: "CUR collector",
        sourceId: "aws_cur2_data_export",
        expectedCadenceMinutes: 60,
        execution: {
          executionArn: "arn:aws:states:us-east-1:111122223333:execution:dcf:run-1",
          status: "FAILED",
          startedAt: "2026-08-01T23:00:00.000Z",
          stoppedAt: "2026-08-01T23:10:00.000Z",
          attempt: 2,
          errorCode: "TIMEOUT",
        },
        consoleUrl: "https://console.aws.amazon.com/states/home?region=us-east-1#/v2/executions/details/arn%3Aaws%3Astates%3Aus-east-1%3A111122223333%3Aexecution%3Adcf%3Arun-1",
      }],
      lineage: [],
      limitations: ["Provider binding pending"],
    };
    const html = renderToStaticMarkup(createElement(
      dashboardModule.DataCollectionMonitorView,
      { report },
    ));
    for (const expected of [
      "Official Data Collection Monitor definition coverage",
      "2 sheets",
      "10 upstream visuals mapped",
      "EMBEDDED QUICKSIGHT DEFINITION",
      "EMBEDDED DATASET TEMPLATE",
      "EMBEDDED SQL VIEW QUERY",
      "Main",
      "About",
      "Status Category",
      "Log Links Mode",
      "CUR collector",
      "TIMEOUT",
    ]) assert.match(html, new RegExp(expected, "iu"));
    assert.doesNotMatch(html, /sample|fixture|placeholder/iu);

    const css = await readFile(
      new URL("../app/costs/finops-data-collection-monitor-dashboard.module.css", import.meta.url),
      "utf8",
    );
    assert.match(css, /\.official > nav button\[aria-current="page"\]/u);
    assert.match(css, /\.official button:focus-visible/u);
    assert.match(css, /@media \(max-width: 1000px\)[\s\S]*\.sheetEvidence/u);
  } finally {
    await vite.close();
  }
});
