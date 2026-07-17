import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const root = new URL("../", import.meta.url);

test("security module charts are exact reviewed pins and Cilium is AWS VPC CNI chained", async () => {
  const [script, cilium, trivy, falco, kyverno] = await Promise.all([
    readFile(new URL("scripts/kubernetes-security-stack.mjs", root), "utf8"),
    readFile(new URL("deploy/kubernetes/security-stack/cilium-aws-vpc-cni-values.yaml", root), "utf8"),
    readFile(new URL("deploy/kubernetes/security-stack/trivy-values.yaml", root), "utf8"),
    readFile(new URL("deploy/kubernetes/security-stack/falco-values.yaml", root), "utf8"),
    readFile(new URL("deploy/kubernetes/security-stack/kyverno-values.yaml", root), "utf8"),
  ]);
  assert.match(script, /version: "0\.32\.1"/u);
  assert.match(script, /version: "9\.1\.0"/u);
  assert.match(script, /version: "3\.8\.2"/u);
  assert.match(script, /version: "1\.19\.5"/u);
  assert.match(cilium, /chainingMode: aws-cni/u);
  assert.match(cilium, /exclusive: false/u);
  assert.match(cilium, /relay:\s*\n\s+enabled: true/u);
  assert.match(cilium, /kubeProxyReplacement: false/u);
  assert.match(trivy, /exposedSecretScannerEnabled: false/u);
  assert.match(falco, /kind: modern_ebpf/u);
  assert.match(kyverno, /policyReports:\s*\n\s+enabled: true/u);
});

test("plan supports module selection without tools, cluster access, or secret output", async () => {
  const { stdout } = await execute(process.execPath, [
    "scripts/kubernetes-security-stack.mjs",
    "plan",
    "--context", "arn:aws:eks:ap-south-1:738663485493:cluster/demo",
    "--modules", "trivy,kyverno",
  ], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      SUTRA_FALCO_HMAC_KEY: "must-never-appear",
      SUTRA_KUBERNETES_SERVICE_ACCOUNT_TOKEN: "must-never-appear",
    },
  });
  assert.match(stdout, /trivy-operator/u);
  assert.match(stdout, /kyverno/u);
  assert.doesNotMatch(stdout, /falco|cilium|must-never-appear/u);
  assert.match(stdout, /no changes made/u);
});

test("mutations require explicit execution and Cilium approval", async () => {
  await assert.rejects(execute(process.execPath, [
    "scripts/kubernetes-security-stack.mjs", "apply", "--modules", "trivy",
  ], { cwd: new URL("..", import.meta.url) }), /--execute/u);
  await assert.rejects(execute(process.execPath, [
    "scripts/kubernetes-security-stack.mjs", "health", "--modules", "cilium",
  ], { cwd: new URL("..", import.meta.url) }), /--allow-cni-change/u);
  const source = await readFile(new URL("scripts/kubernetes-security-stack.mjs", root), "utf8");
  assert.doesNotMatch(source, /execSync|execFileSync|\bshell:\s*true/u);
  assert.match(source, /\[\.\.\.options\.modules\]\.reverse\(\)/u);
  assert.match(source, /raw secret-like value was rejected/u);
});

test("Falco gateway contract references existing configuration and secret without embedding values", async () => {
  const manifest = await readFile(
    new URL("deploy/kubernetes/security-stack/falco-signing-gateway.contract.yaml", root),
    "utf8",
  );
  assert.match(manifest, /image: SET_BY_ORCHESTRATOR/u);
  assert.match(manifest, /configMapKeyRef:/u);
  assert.match(manifest, /secretKeyRef:/u);
  assert.doesNotMatch(manifest, /\b(?:data|stringData):/u);
  assert.match(manifest, /automountServiceAccountToken: false/u);
  assert.match(manifest, /readOnlyRootFilesystem: true/u);
  assert.match(manifest, /allowPrivilegeEscalation: false/u);
  assert.match(manifest, /kind: NetworkPolicy/u);
});
