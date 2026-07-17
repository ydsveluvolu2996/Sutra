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

test("hubble export and falco gateway options stay disabled by default, bounded and read-only", () => {
  assert.match(values, /hubble:\s*\n\s+exportFile:\s*\n\s+enabled: false/u);
  assert.match(values, /falcoGateway:\s*\n\s+healthUrl: ""/u);
  assert.match(deployment, /agent\.hubble\.exportFile\.version must be the exact Hubble version identifier/u);
  assert.match(deployment, /agent\.hubble\.exportFile\.hostPath must be an absolute node path/u);
  assert.match(deployment, /agent\.falcoGateway\.healthUrl must be a bounded in-cluster http\(s\) URL/u);
  assert.match(deployment, /SUTRA_HUBBLE_EXPORT_FILE/u);
  assert.match(deployment, /SUTRA_HUBBLE_VERSION/u);
  assert.match(deployment, /SUTRA_FALCO_GATEWAY_HEALTH_URL/u);
  assert.match(
    deployment,
    /- name: hubble-export\s*\n\s+mountPath: \/var\/run\/sutra-hubble\/events\.log\s*\n\s+readOnly: true/u,
  );
  const hostPathBlocks = deployment.match(/hostPath:/gu) ?? [];
  assert.equal(hostPathBlocks.length, 1, "only the guarded hubble export mount may use hostPath");
  assert.match(deployment, /\{\{- if \$hubbleExport\.enabled \}\}\s*\n\s+- name: hubble-export/u);
  assert.match(deployment, /type: File/u);
});

test("continuous agent retains metadata-only RBAC and no Secret or ConfigMap API access", () => {
  assert.doesNotMatch(role, /^\s+- secrets\s*$/mu);
  assert.doesNotMatch(role, /^\s+- configmaps\s*$/mu);
  assert.doesNotMatch(role, /\b(create|update|patch|delete|watch|impersonate|bind|escalate)\b/u);
  assert.match(notes, /helm upgrade --install/u);
  assert.match(notes, /helm uninstall/u);
});
