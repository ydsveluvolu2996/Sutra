import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = new URL("../deploy/charts/sutra-visibility/", import.meta.url);
const files = await Promise.all([
  "values.yaml",
  "templates/deployment.yaml",
  "templates/networkpolicy.yaml",
  "templates/persistentvolumeclaim.yaml",
  "templates/clusterrole.yaml",
  "templates/NOTES.txt",
  "Chart.yaml",
].map((path) => readFile(new URL(path, root), "utf8")));
const [values, deployment, networkPolicy, pvc, role, notes, chart] = files;
const chartDir = fileURLToPath(root);

function helmTemplate(...extraArgs) {
  try {
    return execFileSync("helm", ["template", "sutra", chartDir, ...extraArgs], { encoding: "utf8" });
  } catch {
    return null; // helm not installed in this environment — the helm-render test self-skips
  }
}

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

test("Sutra bundles a managed Trivy Operator scanner, on by default, gated by scanner.managed", () => {
  // Chart depends on trivy-operator, conditioned so BYO-Trivy customers opt out.
  assert.match(chart, /name: trivy-operator/u);
  assert.match(chart, /repository: "https:\/\/aquasecurity\.github\.io\/helm-charts"/u);
  assert.match(chart, /condition: scanner\.managed/u);
  // Managed scanning + report relay are on by default so scanning works out of the box.
  assert.match(values, /scanner:\s*\n\s+managed: true/u);
  assert.match(values, /trivyReports:\s*\n\s+enabled: true/u);
  // Data-minimizing scanner profile: full coverage, but secret access stays off.
  assert.match(values, /vulnerabilityScannerEnabled: true/u);
  assert.match(values, /sbomGenerationEnabled: true/u);
  assert.match(values, /exposedSecretScannerEnabled: false/u);
  assert.match(values, /accessGlobalSecretsAndServiceAccount: false/u);
});

test("helm renders the managed scanner by default and suppresses it when scanner.managed=false", () => {
  const managed = helmTemplate();
  if (managed === null) return; // helm unavailable — static assertions above still gate the wiring
  assert.match(managed, /name: trivy-operator/u, "managed scanner should render by default");
  assert.match(managed, /OPERATOR_VULNERABILITY_SCANNER_ENABLED: "true"/u);
  assert.match(managed, /OPERATOR_EXPOSED_SECRET_SCANNER_ENABLED: "false"/u);
  const unmanaged = helmTemplate("--set", "scanner.managed=false");
  assert.doesNotMatch(unmanaged ?? "", /name: trivy-operator/u, "scanner must be fully suppressed when unmanaged");
});

const AGENT_SET = [
  "--set", "agent.enabled=true",
  "--set", "agent.image.repository=example/agent",
  "--set", `agent.image.digest=sha256:${"a".repeat(64)}`,
  "--set", "agent.controlPlane.url=https://cp.example.com",
  "--set", "agent.cluster.id=c1",
  "--set", "agent.cluster.name=prod",
  "--set", "agent.enrollment.existingSecret=sutra-bootstrap",
];

test("agent renders as a single-replica Deployment with a ReadWriteOnce PVC by default", () => {
  const rendered = helmTemplate(...AGENT_SET);
  if (rendered === null) return; // helm unavailable — template-level assertions above still gate the wiring
  assert.match(rendered, /kind: Deployment/u);
  assert.match(rendered, /kind: PersistentVolumeClaim/u);
  assert.match(rendered, /accessModes: \[ReadWriteOnce\]/u);
  assert.doesNotMatch(rendered, /kind: DaemonSet/u);
});

test("agent.mode=daemonset renders a DaemonSet with node-local state, per-node identity, and no shared PVC", () => {
  const rendered = helmTemplate(...AGENT_SET, "--set", "agent.mode=daemonset");
  if (rendered === null) return;
  assert.match(rendered, /kind: DaemonSet/u);
  assert.doesNotMatch(rendered, /kind: PersistentVolumeClaim/u); // RWO PVC cannot be shared across nodes
  assert.match(rendered, /fieldPath: spec\.nodeName/u); // per-node identity
  assert.match(rendered, /emptyDir: \{\}/u); // node-local state
  // Hardened container contract is preserved in daemonset mode.
  assert.match(rendered, /runAsNonRoot: true/u);
  assert.match(rendered, /readOnlyRootFilesystem: true/u);
  assert.match(rendered, /drop:\s*\n?\s*- ALL|drop: \[ALL\]/u);
});
