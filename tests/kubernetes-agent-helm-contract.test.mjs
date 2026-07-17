import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../deploy/charts/sutra-visibility/", import.meta.url);
const files = await Promise.all([
  "values.yaml",
  "templates/deployment.yaml",
  "templates/networkpolicy.yaml",
  "templates/persistentvolumeclaim.yaml",
  "templates/clusterrole.yaml",
  "templates/NOTES.txt",
].map((path) => readFile(new URL(path, root), "utf8")));
const [values, deployment, networkPolicy, pvc, role, notes] = files;

test("agent chart is disabled by default and requires immutable image, HTTPS endpoint and existing bootstrap Secret", () => {
  assert.match(values, /agent:\s*\n\s+enabled: false/u);
  assert.match(deployment, /agent\.image\.digest is required/u);
  assert.match(deployment, /must be an exact sha256 digest/u);
  assert.match(deployment, /agent\.controlPlane\.url is required/u);
  assert.match(deployment, /must be an HTTPS origin/u);
  assert.match(deployment, /must be from 300 through 86400/u);
  assert.match(deployment, /agent\.enrollment\.existingSecret is required/u);
  assert.doesNotMatch(deployment, /kind:\s*Secret/u);
  assert.doesNotMatch(values, /^\s+(?:bootstrap|token|password|clientSecret|apiKey):\s*\S+/imu);
});

test("agent pod is non-root, read-only, outbound-only and persists only its delivery state", () => {
  assert.match(deployment, /runAsNonRoot: true/u);
  assert.match(deployment, /allowPrivilegeEscalation: false/u);
  assert.match(deployment, /readOnlyRootFilesystem: true/u);
  assert.match(deployment, /drop: \[ALL\]/u);
  assert.match(deployment, /persistentVolumeClaim/u);
  assert.match(networkPolicy, /policyTypes: \[Ingress, Egress\]/u);
  assert.match(networkPolicy, /ingress: \[\]/u);
  assert.doesNotMatch(deployment, /containerPort:/u);
  assert.match(pvc, /helm\.sh\/resource-policy: keep/u);
});

test("continuous agent retains metadata-only RBAC and no Secret or ConfigMap API access", () => {
  assert.doesNotMatch(role, /^\s+- secrets\s*$/mu);
  assert.doesNotMatch(role, /^\s+- configmaps\s*$/mu);
  assert.doesNotMatch(role, /\b(create|update|patch|delete|watch|impersonate|bind|escalate)\b/u);
  assert.match(notes, /helm upgrade --install/u);
  assert.match(notes, /helm uninstall/u);
});
