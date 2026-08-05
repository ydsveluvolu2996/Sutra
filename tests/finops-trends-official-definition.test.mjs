import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const { FINOPS_TRENDS_OFFICIAL_DEFINITION: definition } = await import(
  "../lib/finops-trends-official-definition.ts"
);

test("ADD-09 pins every public Trends artifact at the immutable AWS commit", () => {
  assert.equal(
    definition.source.commit,
    "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
  );
  assert.equal(definition.source.dashboardId, "trends-dashboard");
  assert.equal(definition.source.templateId, "cudos-trends-dashboard-template");
  assert.equal(definition.source.latestDocumentedVersion, "v5.1.0");
  assert.equal(definition.source.manifestMinimumTemplateDescription, "v5.0.0");
  assert.deepEqual(
    definition.artifacts.map(({ kind, path, sha256 }) => [kind, path, sha256]),
    [
      ["RESOURCE_MANIFEST", "cid/builtin/core/data/resources.yaml", "41ad438cea2a297f62976689e77eee8fda371913a6af53c946fb615bdccb5b71"],
      ["CHANGELOG", "changes/CHANGELOG-trends.md", "7ce940a15cdd50957df18f0a362484a04e9be44f665aefede779c87401f7365e"],
      ["DEPLOYMENT_TEMPLATE", "cfn-templates/cid-plugin.yml", "b96a47e6b53418293ec7127d0a95f96f2ffdae2781cde2b2dffcabad926a713d"],
      ["ATHENA_QUERY", "cid/builtin/core/data/queries/trends/daily_anomaly_detection.sql", "a17a40f084dfebbf14c146bfc466282f78a14607c5898a19a53b320c13e9901b"],
      ["ATHENA_QUERY", "cid/builtin/core/data/queries/trends/monthly_anomaly_detection.sql", "e21fce72e791f95d9e7d4a01952367ed41b27391069a082fc51d19e85e96dfa2"],
      ["ATHENA_QUERY", "cid/builtin/core/data/queries/trends/monthly_bill_by_account.sql", "30916d149b3d7d06f8ef9cedbb281cd71e3c14e8d0f41d5f0232abd0019c6fe1"],
      ["SPICE_DATASET_DEFINITION", "cid/builtin/core/data/datasets/trends/daily_anomaly_detection.json", "bf9d4e26a4d2fb13f9f6dc05c9f5b38e4853d20733c4fce5370f856cf43aafc5"],
      ["SPICE_DATASET_DEFINITION", "cid/builtin/core/data/datasets/trends/monthly_anomaly_detection.json", "705bafb2b8c2abe7d217addc454b026d1c573e85f9d10658c6811aa9711fccb4"],
      ["SPICE_DATASET_DEFINITION", "cid/builtin/core/data/datasets/trends/monthly_bill_by_account.json", "f33c76de9e8c12d12129d0491dcf5cb1e326db666ea35b177f81622e5e093739"],
    ],
  );
});

test("ADD-09 keeps unpublished QuickSight object totals explicitly unknown", () => {
  assert.equal(definition.quickSightDefinition.publishedInRepository, false);
  assert.equal(definition.quickSightDefinition.serviceHostedTemplate, true);
  assert.equal(definition.quickSightDefinition.pixelParityClaimed, false);
  for (const value of [
    definition.quickSightDefinition.sheetCount,
    definition.quickSightDefinition.visualCount,
    definition.quickSightDefinition.filterControlCount,
    definition.quickSightDefinition.parameterControlCount,
    definition.quickSightDefinition.parameterCount,
    definition.quickSightDefinition.calculatedFieldCount,
  ]) assert.equal(value, null);
  assert.equal(definition.documentedControls.length, 7);
  assert.equal(definition.controlsNotExhaustivelyEnumeratedByAws, true);
  assert.deepEqual(definition.datasets.map((dataset) => [
    dataset.id,
    dataset.inputColumnCount,
    dataset.importMode,
  ]), [
    ["daily-anomaly-detection", 6, "SPICE"],
    ["monthly-anomaly-detection", 6, "SPICE"],
    ["monthly-bill-by-account", 14, "SPICE"],
  ]);
});

test("ADD-09 maps every documented feature area without hiding provider gaps", () => {
  assert.deepEqual(definition.documentedFeatureAreas.map((area) => area.name), [
    "Periodic trends and actuals",
    "ML-powered forecast",
    "Service category and service usage trends",
    "Three-month service percentage change",
    "AWS account trends",
    "Filter controls and one-click filtering",
    "Global usage map",
    "Threshold alerts and scheduled delivery",
    "AWS Usage v5.1 additions",
  ]);
  assert.equal(
    definition.documentedFeatureAreas.find((area) =>
      area.name === "ML-powered forecast")?.nativeCoverage,
    "UNAVAILABLE",
  );
  assert.equal(
    definition.documentedFeatureAreas.find((area) =>
      area.name === "AWS account trends")?.gap,
    "AWS_ORGANIZATIONS_API_EVIDENCE_NOT_INGESTED",
  );
  assert.equal(
    definition.documentedFeatureAreas.find((area) =>
      area.name === "Global usage map")?.gap,
    "AUTHORITATIVE_REGION_COORDINATES_NOT_INGESTED",
  );
});

test("ADD-09 API and UI expose the audit in every successful state", async () => {
  const [route, panel] = await Promise.all([
    readFile(new URL("../app/api/v1/finops/trends/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/costs/finops-cur-intelligence-panels.tsx", import.meta.url), "utf8"),
  ]);
  assert.equal(
    route.match(/officialDefinition:\s*FINOPS_TRENDS_OFFICIAL_DEFINITION/gu)?.length,
    5,
  );
  assert.match(panel, /<TrendsOfficialCoverage definition=\{officialDefinition\}/u);
  assert.match(panel, /envelope as TrendsEnvelope\)\.officialDefinition/gu);
  assert.match(panel, /Exact sheets, visuals, filter controls, parameter controls/u);
  assert.match(panel, /Pixel parity is not claimed/u);
});
