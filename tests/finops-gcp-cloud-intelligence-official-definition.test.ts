import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION as definition,
} from "../lib/finops-gcp-cloud-intelligence-official-definition.ts";

const root = path.resolve(import.meta.dirname, "..");

test("ADD-03 pins every published GCP dashboard artifact and preserves absent artifacts as null", () => {
  assert.equal(
    definition.source.commit,
    "d0b5983db3a0931a63fcc21a9f7e2764483cfcaf",
  );
  assert.equal(
    definition.source.manifestSha256,
    "78ed3d8245be60aea8f212e38f1458d6ea5be8b9f0fe660deee71f494ec7087c",
  );
  assert.equal(
    definition.source.embeddedDefinitionSha256,
    "f0c8192efe855309d5cd63189b9a7c10e0819b2ee7eb64e124fae47588347b07",
  );
  assert.equal(
    definition.source.deploymentTemplateSha256,
    "d6d4b02fd0ca40270e212600e88bf021e431db924875fb0d3670b5ec6cdea8a4",
  );
  assert.equal(
    definition.source.readmeSha256,
    "3e8baa8574a604fe4d061beebbe1a84cb4ea28afb0fc8e36a35b5c3b5bcd9059",
  );
  assert.equal(definition.publication.changelogPath, null);
  assert.equal(definition.publication.releaseVersion, null);
  assert.equal(definition.publication.standaloneQuickSightDefinitionPath, null);
  assert.equal(definition.publication.completeQuickSightDefinitionEmbedded, true);
  assert.deepEqual(
    definition.artifacts.map((artifact) => artifact.kind),
    [
      "README",
      "MANIFEST_CONTAINER",
      "EMBEDDED_QUICKSIGHT_DEFINITION",
      "DEPLOYMENT_TEMPLATE",
      "EMBEDDED_DATASET",
      "EMBEDDED_DATASET",
      "EMBEDDED_VIEW_QUERY",
      "EMBEDDED_VIEW_QUERY",
      "EMBEDDED_VIEW_QUERY",
    ],
  );
});

test("ADD-03 preserves the exact complete QuickSight inventory", () => {
  assert.deepEqual(definition.totals, {
    sheets: 7,
    visuals: 60,
    parameterControls: 47,
    filterControls: 7,
    parameterDeclarations: 14,
    calculatedFields: 53,
    filterGroups: 172,
    columnConfigurations: 23,
    datasets: 2,
    views: 3,
  });
  assert.deepEqual(
    definition.sheets.map((sheet) => [sheet.name, sheet.visualCount]),
    [
      ["Summary", 27],
      ["Compute Engine", 19],
      ["Cloud SQL", 7],
      ["Big Query", 3],
      ["Network", 3],
      ["Kubernetes", 1],
      ["About", 0],
    ],
  );
  assert.equal(
    definition.sheets.reduce((sum, sheet) => sum + sheet.visualCount, 0),
    definition.totals.visuals,
  );
  assert.equal(
    definition.sheets.reduce(
      (sum, sheet) => sum + sheet.parameterControls.length,
      0,
    ),
    definition.totals.parameterControls,
  );
  assert.equal(
    definition.sheets.reduce(
      (sum, sheet) => sum + sheet.filterControls.length,
      0,
    ),
    definition.totals.filterControls,
  );
  assert.equal(
    Object.values(definition.visualTypes).reduce(
      (sum, count) => sum + count,
      0,
    ),
    definition.totals.visuals,
  );
  for (const sheet of definition.sheets) {
    assert.equal(
      Object.values(sheet.visualTypes).reduce(
        (sum, count) => sum + count,
        0,
      ),
      sheet.visualCount,
    );
    assert.deepEqual(sheet.filterControls, ["Cost Type"]);
  }
});

test("ADD-03 keeps dataset publication and live adapter gaps evidence-honest", () => {
  assert.deepEqual(definition.datasets, [
    {
      identifier: "gcp_currency",
      inputColumnCount: 2,
      uniqueInputColumnCount: 2,
      physicalTableCount: 1,
      logicalTableCount: 1,
    },
    {
      identifier: "gcp_summary_with_pricing",
      inputColumnCount: 72,
      uniqueInputColumnCount: 66,
      physicalTableCount: 2,
      logicalTableCount: 3,
    },
  ]);
  assert.deepEqual(
    definition.views,
    ["gcp_currency", "gcp_current_pricing", "gcp_summary"],
  );
  assert.equal(
    definition.nativeBinding.state,
    "GCP_BIGQUERY_BILLING_EXPORT_ADAPTER_NOT_DEPLOYED",
  );
  assert.equal(definition.nativeBinding.permanentRuntimeAdapterAvailable, false);
  assert.equal(definition.nativeBinding.liveProviderGenerationAvailable, false);
  assert.equal(definition.nativeBinding.serviceAccountKeyAccepted, false);
  assert.equal(definition.cidFrameworkAudit.gcpDashboardSpecificArtifactCount, 0);
});

test("ADD-03 returns and validates the frozen audit in every successful state", async () => {
  const [route, dashboard] = await Promise.all([
    readFile(
      path.join(root, "app/api/v1/finops/gcp-cloud-intelligence/route.ts"),
      "utf8",
    ),
    readFile(
      path.join(root, "app/costs/finops-gcp-cloud-intelligence-dashboard.tsx"),
      "utf8",
    ),
  ]);
  assert.equal(route.match(/jsonResponse\(/gu)?.length, 4);
  assert.equal(
    route.match(/officialDefinition:\s*GCP_CLOUD_INTELLIGENCE_OFFICIAL_DEFINITION/gu)?.length,
    4,
  );
  assert.match(dashboard, /function hasPinnedOfficialDefinition/u);
  assert.match(dashboard, /GCP official definition was not recognized/u);
  assert.match(
    dashboard,
    /const official=<GcpCloudIntelligenceOfficialDefinitionPanel definition=\{state\.officialDefinition\}\/>/u,
  );
  assert.equal(dashboard.match(/\{official\}/gu)?.length, 5);
});
