import assert from "node:assert/strict";
import test from "node:test";
import { AWS_SUPPORT_CASES_OFFICIAL_DEFINITION as definition } from "../lib/finops-aws-support-cases-official-definition.ts";

test("ADV-09 pins every publicly provable Support Cases artifact", () => {
  assert.equal(
    definition.source.manifest.sha256,
    "4d9970206b4c927bb1d0cf1afd4e2a732370472f1b2f54c2681c13d71131e8fa",
  );
  assert.equal(
    definition.source.changelog.sha256,
    "385bc28ba04f119c41ada8a3490c2a753abc6f79e3b9a6331213a8c59ea7969c",
  );
  assert.equal(
    definition.source.preview.sha256,
    "3702251ed48abe49e529ea5fc12ce3e44a3fce570043f44797a95b94b855852a",
  );
  assert.deepEqual(definition.documentedTabs, [
    "Cases Summary",
    "Contact Summary",
    "About",
  ]);
  assert.equal(definition.publishedDatasets.length, 2);
  assert.deepEqual(
    definition.publishedDatasets.map((dataset) => dataset.uniqueInputColumns),
    [3, 35],
  );
});

test("ADV-09 never fabricates managed QuickSight counts or weakens privacy", () => {
  assert.equal(definition.quickSightDefinition.state, "NOT_PUBLICLY_COMMITTED");
  assert.equal(definition.quickSightDefinition.exactSheetCount, null);
  assert.equal(definition.quickSightDefinition.exactVisualCount, null);
  assert.equal(definition.quickSightDefinition.exactFilterControlCount, null);
  assert.equal(
    definition.quickSightDefinition.exactParameterControlCount,
    null,
  );
  for (const field of [
    "Subject",
    "Communication body",
    "CC email addresses",
    "Generative summary fields",
  ]) {
    assert.ok(definition.privacyBoundary.intentionallyExcluded.includes(field));
  }
});
