import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rolePath = new URL("../deploy/charts/sutra-visibility/templates/clusterrole.yaml", import.meta.url);
const bindingPath = new URL("../deploy/charts/sutra-visibility/templates/clusterrolebinding.yaml", import.meta.url);
const valuesPath = new URL("../deploy/charts/sutra-visibility/values.yaml", import.meta.url);

test("Sutra visibility chart is read-only and excludes credentials and Secret access", async () => {
  const [role, binding, values] = await Promise.all([
    readFile(rolePath, "utf8"),
    readFile(bindingPath, "utf8"),
    readFile(valuesPath, "utf8"),
  ]);
  assert.match(role, /verbs: \[get, list\]/u);
  assert.doesNotMatch(role, /\b(create|update|patch|delete|watch|impersonate|bind|escalate)\b/u);
  assert.doesNotMatch(role, /^\s+- secrets\s*$/mu);
  assert.doesNotMatch(role, /^\s+- configmaps\s*$/mu);
  assert.doesNotMatch(role, /resources:\s*\[\s*"\*"\s*\]/u);
  assert.doesNotMatch(role, /verbs:\s*\[\s*"\*"\s*\]/u);
  assert.match(binding, /kind: Group/u);
  assert.match(binding, /\.Values\.kubernetesGroup/u);
  // Report import is on by default now that the chart bundles a managed Trivy
  // Operator; relaying Trivy reports is read-only and the agent's own RBAC above
  // still grants no Secret/ConfigMap/write access.
  assert.match(values, /trivyReports:\s*\n\s+enabled: true/u);
  assert.doesNotMatch(`${role}\n${binding}\n${values}`, /\b(token|password|clientSecret|apiKey):\s*\S+/iu);
});
