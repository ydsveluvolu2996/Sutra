import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  AMAZON_CONNECT_OFFICIAL_DEFINITION as definition,
} from "../lib/finops-amazon-connect-official-definition.ts";

const root = path.resolve(import.meta.dirname, "..");

test("ADD-11 pins every public dashboard and dependency artifact", () => {
  assert.equal(
    definition.source.commit,
    "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
  );
  assert.equal(
    definition.source.manifestSha256,
    "dc39d46a29881b54384ff57feee193f23fa23bd6631cc3dda39352cd2960cbea",
  );
  assert.equal(
    definition.source.embeddedDefinitionSha256,
    "c5078f8b73558a7ab1bc388e24dd52fae0ddd954f5097aec8e50b6552fdfc0b8",
  );
  assert.equal(
    definition.source.changelogSha256,
    "147cab6cc9d5e2e95126ea39ae1b3df8efbee3b880788daef4114e6ca14383b2",
  );
  assert.deepEqual(
    definition.artifacts.map((artifact) => [artifact.kind, artifact.sha256]),
    [
      ["MANIFEST_CONTAINER", "dc39d46a29881b54384ff57feee193f23fa23bd6631cc3dda39352cd2960cbea"],
      ["EMBEDDED_QUICKSIGHT_DEFINITION", "c5078f8b73558a7ab1bc388e24dd52fae0ddd954f5097aec8e50b6552fdfc0b8"],
      ["CHANGELOG", "147cab6cc9d5e2e95126ea39ae1b3df8efbee3b880788daef4114e6ca14383b2"],
      ["PUBLIC_DEPENDENCY_DATASET_DEFINITION", "8e509103b770e7deb220a04eba63703c47db3142f08033bbb70c93498acc3ab8"],
      ["PUBLIC_DEPENDENCY_SQL_QUERY", "57b8ab6ec7d22e0bd642c1bbe44f5bc5cc2cce8523ef0c795ce410a1ae3dec8e"],
    ],
  );
  assert.equal(definition.source.latestDocumentedVersion, "v1.1.1");
  assert.equal(definition.publication.completeQuickSightDefinitionEmbedded, true);
  assert.equal(definition.publication.standaloneTemplateBodyPath, null);
});

test("ADD-11 preserves the complete QuickSight structural inventory", () => {
  assert.deepEqual(definition.totals, {
    sheets: 8,
    visuals: 121,
    parameterControls: 47,
    filterControls: 14,
    parameterDeclarations: 18,
    calculatedFields: 33,
    filterGroups: 157,
    columnConfigurations: 8,
    datasets: 2,
  });
  assert.deepEqual(definition.sheets.map((sheet) => [sheet.name, sheet.visualCount]), [
    ["Overview", 16],
    ["Contact Center", 8],
    ["Connect", 23],
    ["Telecom", 17],
    ["Daily Usage", 27],
    ["Call Details", 22],
    ["Contact Search", 7],
    ["About", 1],
  ]);
  assert.equal(
    definition.sheets.reduce((sum, item) => sum + item.visualCount, 0),
    definition.totals.visuals,
  );
  assert.equal(
    definition.sheets.reduce(
      (sum, item) => sum + item.parameterControls.length,
      0,
    ),
    definition.totals.parameterControls,
  );
  assert.equal(
    definition.sheets.reduce(
      (sum, item) => sum + item.filterControls.length,
      0,
    ),
    definition.totals.filterControls,
  );
  assert.equal(
    Object.values(definition.visualTypes).reduce((sum, count) => sum + count, 0),
    definition.totals.visuals,
  );
});

test("ADD-11 maps only the seven documented purposes and preserves unpublished contracts as null", () => {
  assert.equal(
    definition.sheets.filter((item) => item.documentedPurpose !== null).length,
    7,
  );
  assert.equal(
    definition.sheets.find((item) => item.name === "About")?.documentedPurpose,
    null,
  );
  const resourceConnect = definition.dataContracts.find((item) =>
    item.identifier === "resource_connect_view"
  );
  assert.equal(resourceConnect?.datasetDefinitionPublished, false);
  assert.equal(resourceConnect?.datasetDefinitionPath, null);
  assert.equal(resourceConnect?.datasetDefinitionSha256, null);
  assert.equal(resourceConnect?.queryPublished, false);
  assert.equal(resourceConnect?.queryPath, null);
  assert.equal(resourceConnect?.querySha256, null);
  assert.equal(resourceConnect?.inputColumnCount, null);
  const summary = definition.dataContracts.find((item) =>
    item.identifier === "summary_view"
  );
  assert.equal(summary?.datasetDefinitionPublished, true);
  assert.equal(summary?.queryPublished, true);
  assert.equal(summary?.inputColumnCount, 50);
  assert.equal(
    definition.sheets.find((item) => item.name === "Contact Center")?.nativeCoverage,
    "UNAVAILABLE",
  );
  assert.equal(
    definition.sheets.find((item) => item.name === "Contact Search")?.nativeCoverage,
    "PARTIAL",
  );
});

test("ADD-11 exposes and renders the audit in ready and configuration responses", async () => {
  const [route, dashboard] = await Promise.all([
    readFile(
      path.join(root, "app/api/v1/finops/amazon-connect-cost-insights/route.ts"),
      "utf8",
    ),
    readFile(
      path.join(root, "app/costs/finops-amazon-connect-cost-insights-dashboard.tsx"),
      "utf8",
    ),
  ]);
  assert.equal(
    route.match(/officialDefinition:AMAZON_CONNECT_OFFICIAL_DEFINITION/gu)?.length,
    2,
  );
  assert.match(dashboard, /report\.officialDefinition/u);
  assert.match(
    dashboard,
    /configuration\?<AmazonConnectOfficialDefinitionPanel definition=\{configuration\.officialDefinition\}/u,
  );
  assert.match(dashboard, /Amazon Connect official definition was not recognized/u);
});
