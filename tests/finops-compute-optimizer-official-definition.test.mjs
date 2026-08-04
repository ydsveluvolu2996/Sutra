import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const { FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION: definition } =
  await import("../lib/finops-compute-optimizer-official-definition.ts");
const [route, panel, evidence, routeHandler] = await Promise.all([
  readFile(new URL("../app/api/v1/finops/compute-optimizer/route.ts", import.meta.url), "utf8"),
  readFile(new URL("../app/costs/finops-compute-optimizer-dashboard.tsx", import.meta.url), "utf8"),
  readFile(new URL("../docs/finops-cid-evidence/ADV-02-compute-optimizer.md", import.meta.url), "utf8"),
  readFile(new URL("../lib/finops-compute-optimizer-exact-route-handler.ts", import.meta.url), "utf8"),
]);

test("Compute Optimizer official public artifacts are immutable and exact", () => {
  assert.equal(definition.source.commit, "f9e36d88c47709f10e8fa784ad11d5cc0e728021");
  assert.equal(definition.source.version, "v5.0.0");
  for (const artifact of [
    definition.source.manifest,
    definition.source.dataset,
    definition.source.unionView,
    definition.source.changelog,
    definition.source.documentedPreview,
  ]) assert.match(artifact.sha256, /^[a-f0-9]{64}$/u);
  assert.equal(definition.publishedModuleFamilies.length, 9);
  assert.equal(definition.documentedPreviewVisuals.length, 14);
  assert.equal(definition.datasetControls.length, 9);
});

test("unpublished QuickSight definition counts remain explicitly unavailable", () => {
  assert.equal(definition.quickSightDefinition.state, "NOT_PUBLICLY_COMMITTED");
  assert.equal(definition.quickSightDefinition.exactSheetCount, null);
  assert.equal(definition.quickSightDefinition.exactVisualCount, null);
  assert.equal(definition.quickSightDefinition.exactFilterControlCount, null);
  assert.equal(definition.quickSightDefinition.exactParameterControlCount, null);
  assert.match(definition.quickSightDefinition.disclosure, /not inferred/u);
});

test("route and native UI expose the immutable inventory without claiming parity", () => {
  // The route now delegates to the shared exact route handler, so the official definition is
  // referenced one level down. Assert the delegation and that the handler still exposes it.
  assert.match(route, /finops-compute-optimizer-exact-route-handler/u);
  assert.match(routeHandler, /FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION/u);
  // Every response path must carry the immutable definition, so no state can answer while claiming
  // parity. Assert that structurally -- one wiring per jsonResponse -- rather than pinning a count that
  // moves whenever a lifecycle state is added.
  const responses = routeHandler.match(/jsonResponse\(/gu) ?? [];
  const wirings = routeHandler
    .match(/officialDefinition: *FINOPS_COMPUTE_OPTIMIZER_OFFICIAL_DEFINITION/gu) ?? [];
  assert.ok(responses.length > 0, "the exact route handler must build at least one response");
  assert.equal(wirings.length, responses.length,
    "every exact route handler response must carry the official definition");
  assert.match(panel, /Official AWS Compute Optimizer Dashboard coverage/u);
  // The disclosure was rephrased. Assert its substance: geometry is explicitly not inferred, and
  // absent evidence reads as unavailable rather than as a zero count.
  assert.match(panel, /Exact sheet\/control geometry is not inferred/u);
  assert.match(panel, /Accepted evidence unavailable/u);
  assert.match(panel, /documentedPreviewVisuals\.map/u);
  assert.match(evidence, /NOT_PUBLICLY_COMMITTED/u);
});
