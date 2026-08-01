import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  FOCUS_OFFICIAL_DEFINITION as definition,
} from "../lib/finops-focus-official-definition.ts";

const root = path.resolve(import.meta.dirname, "..");

test("ADD-04 pins the complete AWS FOCUS source artifact set", () => {
  assert.equal(
    definition.source.commit,
    "f9e36d88c47709f10e8fa784ad11d5cc0e728021",
  );
  assert.equal(
    definition.source.manifestSha256,
    "a9521d2ece8cb8defe0d791ca018c660d6872394a75593fae1d0acfe12b9c4cb",
  );
  assert.equal(
    definition.source.definitionSha256,
    "bc7bafbcb47e745dd256a151ee3fbe260aad10515fc5e626e02aec0c6e6ea1cc",
  );
  assert.equal(
    definition.source.changelogSha256,
    "41bb336c1dcfe285c5b5dcfd469c6170a9d2cad4db41055a15f3506257606541",
  );
  assert.deepEqual(
    definition.artifacts.map((artifact) => artifact.kind),
    [
      "MANIFEST_CONTAINER",
      "STANDALONE_QUICKSIGHT_DEFINITION",
      "CHANGELOG",
      "CONSOLIDATION_HELPER",
      "CONSOLIDATION_QUERY_TEMPLATE",
      "EMBEDDED_DATASET",
      "EMBEDDED_DATASET",
      "EMBEDDED_VIEW_QUERY",
      "EMBEDDED_VIEW_QUERY",
      "DYNAMIC_CONSOLIDATION_SCHEMA",
    ],
  );
  assert.equal(definition.publication.completeQuickSightDefinitionPublished, true);
  assert.equal(definition.publication.externalTemplateId, null);
});

test("ADD-04 preserves the exact public QuickSight structural inventory", () => {
  assert.deepEqual(definition.totals, {
    sheets: 3,
    visuals: 27,
    parameterControls: 5,
    filterControls: 15,
    parameterDeclarations: 6,
    calculatedFields: 24,
    filterGroups: 45,
    columnConfigurations: 16,
    datasets: 2,
  });
  assert.deepEqual(
    definition.sheets.map((item) => [item.name, item.visualCount]),
    [["Billing Summary", 18], ["MoM Trends", 9], ["About", 0]],
  );
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
    Object.values(definition.visualTypes).reduce(
      (sum, count) => sum + count,
      0,
    ),
    definition.totals.visuals,
  );
});

test("ADD-04 maps only documented purposes and keeps provider gaps explicit", () => {
  assert.equal(definition.guidance.documentedPurposes.length, 5);
  assert.equal(
    definition.sheets.find((item) => item.name === "About")?.documentedPurpose,
    null,
  );
  const states = new Map(
    definition.providerSources.map((source) => [
      source.provider,
      source.nativeBindingState,
    ]),
  );
  assert.equal(states.get("AWS"), "BOUND_FOCUS_1_2");
  assert.equal(
    states.get("AZURE"),
    "AZURE_FOCUS_1_0_NORMALIZED_BINDING_NOT_DEPLOYED",
  );
  assert.equal(states.get("GCP"), "GCP_FOCUS_EXPORT_ADAPTER_NOT_DEPLOYED");
  assert.equal(
    states.get("OCI"),
    "OCI_SOURCE_DISCOVERY_AND_BINDING_NOT_DEPLOYED",
  );
  const gcp = definition.providerSources.find((source) =>
    source.provider === "GCP"
  );
  assert.equal(gcp?.sourceKind, "NATIVE_DETAILED_BILLING_NOT_FOCUS");
  assert.match(gcp?.disclosure ?? "", /not evidence of a GCP FOCUS adapter/u);
});

test("ADD-04 exposes the audit in every successful route state and outside report rendering", async () => {
  const [route, dashboard] = await Promise.all([
    readFile(path.join(root, "app/api/v1/finops/focus/route.ts"), "utf8"),
    readFile(path.join(root, "app/costs/finops-focus-dashboard.tsx"), "utf8"),
  ]);
  assert.equal(route.match(/return jsonResponse\(/gu)?.length, 5);
  assert.equal(
    route.match(/officialDefinition: FOCUS_OFFICIAL_DEFINITION/gu)?.length,
    5,
  );
  assert.match(
    dashboard,
    /<FocusOfficialDefinitionPanel definition=\{envelope\.officialDefinition\} \/>/u,
  );
  assert.match(
    dashboard,
    /\{envelope === null \? null : \(\s*<FocusOfficialDefinitionPanel/u,
  );
  assert.match(
    dashboard,
    /body\.officialDefinition\.source\.definitionSha256 !== "bc7bafbcb47e745dd256a151ee3fbe260aad10515fc5e626e02aec0c6e6ea1cc"/u,
  );
});
