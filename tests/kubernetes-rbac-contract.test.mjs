import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const manifest = await readFile(
  new URL("../infrastructure/kubernetes-readonly.yaml", import.meta.url),
  "utf8",
);

test("Kubernetes collector role is metadata-only and non-mutating", () => {
  assert.match(manifest, /kind: ClusterRole/u);
  assert.match(manifest, /verbs: \[get, list\]/u);
  assert.doesNotMatch(manifest, /\b(create|update|patch|delete|deletecollection|impersonate|escalate|bind)\b/u);
  assert.doesNotMatch(manifest, /^\s*-\s+secrets\s*$/mu);
  assert.doesNotMatch(manifest, /^\s*-\s+configmaps\s*$/mu);
  assert.doesNotMatch(manifest, /^\s*-\s+events\s*$/mu);
  assert.doesNotMatch(manifest, /resources:\s*\[\s*["']?\*["']?\s*\]/u);
  assert.doesNotMatch(manifest, /verbs:\s*\[\s*["']?\*["']?\s*\]/u);
});

test("collector service account does not mount a credential into arbitrary pods", () => {
  assert.match(manifest, /automountServiceAccountToken: false/u);
  assert.match(manifest, /pod-security\.kubernetes\.io\/enforce: restricted/u);
  assert.match(manifest, /namespace: sutra-system/u);
});

test("optional Trivy Operator access is limited to exact non-secret report CRDs", () => {
  assert.match(manifest, /apiGroups: \[aquasecurity\.github\.io\]/u);
  for (const resource of [
    "vulnerabilityreports",
    "configauditreports",
    "rbacassessmentreports",
    "clusterrbacassessmentreports",
    "sbomreports",
  ]) assert.match(manifest, new RegExp(`^\\s*-\\s+${resource}$`, "mu"));
  for (const forbidden of [
    "exposedsecretreports",
    "clustercompliancereports",
    "clustervulnerabilityreports",
    "clustersbomreports",
  ]) assert.doesNotMatch(manifest, new RegExp(`^\\s*-\\s+${forbidden}$`, "mu"));
});
