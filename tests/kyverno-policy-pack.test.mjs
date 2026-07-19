import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../deploy/policies/kyverno/", import.meta.url);
const included = [
  "audit-workload-security.yaml",
  "audit-workload-reliability.yaml",
  "audit-image-supply-chain.yaml",
];

async function source(name) {
  return readFile(new URL(name, root), "utf8");
}

test("default Kustomize target contains only audit-first policies", async () => {
  const kustomization = await source("kustomization.yaml");
  assert.deepEqual(
    [...kustomization.matchAll(/^\s+- (audit-[a-z-]+\.yaml)$/gmu)].map((match) => match[1]),
    included,
  );
  assert.doesNotMatch(kustomization, /optional|signature|provenance|promotion-request/u);
  for (const name of included) {
    const policy = await source(name);
    assert.match(policy, /validationFailureAction: Audit/u);
    assert.match(policy, /failurePolicy: Ignore/u);
    assert.match(policy, /sutra\.io\/promotion-state: audit/u);
    assert.doesNotMatch(policy, /validationFailureAction: Enforce/u);
  }
});

test("audit pack covers every requested workload and supply-chain control", async () => {
  const security = await source("audit-workload-security.yaml");
  const reliability = await source("audit-workload-reliability.yaml");
  const supplyChain = await source("audit-image-supply-chain.yaml");
  for (const rule of [
    "disallow-privileged-containers",
    "disallow-privilege-escalation",
    "disallow-host-namespaces",
    "disallow-host-path",
    "disallow-dangerous-capabilities",
    "require-non-root",
    "require-runtime-default-seccomp",
  ]) assert.match(security, new RegExp(`name: ${rule}`, "u"));
  for (const rule of [
    "require-resource-requests-and-limits",
    "require-liveness-and-readiness-probes",
  ]) assert.match(reliability, new RegExp(`name: ${rule}`, "u"));
  for (const rule of [
    "require-trusted-registry",
    "require-image-digest",
  ]) assert.match(supplyChain, new RegExp(`name: ${rule}`, "u"));
  assert.match(security, /SYS_ADMIN/u);
  assert.match(security, /hostNetwork/u);
  assert.match(security, /runAsNonRoot/u);
  assert.match(supplyChain, /\*@sha256:\*/u);
  assert.match(supplyChain, /\*\.dkr\.ecr\.\*\.amazonaws\.com\/\*/u);
  assert.match(supplyChain, /public\.ecr\.aws\/\*/u);
  assert.match(supplyChain, /ghcr\.io\/\*/u);
  assert.doesNotMatch(supplyChain, /operator: NotMatches/u);
});

test("opt-in enforce overlay flips the audit pack to blocking and is not in the default target", async () => {
  const rootKustomization = await source("kustomization.yaml");
  // The default target must never pull in the enforce overlay.
  assert.doesNotMatch(rootKustomization, /enforce/u);

  const overlay = await source("enforce/kustomization.yaml");
  // Reuses the exact audit policies as bases (no duplicated policy bodies).
  for (const name of included) assert.match(overlay, new RegExp(`\\.\\./${name}`, "u"));
  // Flips all three fields to blocking, fail-closed, enforce-promoted.
  assert.match(overlay, /path: \/spec\/validationFailureAction\n\s+value: Enforce/u);
  assert.match(overlay, /path: \/spec\/failurePolicy\n\s+value: Fail/u);
  assert.match(overlay, /promotion-state\n\s+value: enforce/u);
  // One patch target per audit policy.
  assert.equal([...overlay.matchAll(/name: sutra-[a-z-]+-audit/gu)].length, included.length);
});

test("microsegmentation generate policy creates a default-deny NetworkPolicy per namespace", async () => {
  const policy = await source("enforce/generate-default-deny-networkpolicy.yaml");
  assert.match(policy, /kind: ClusterPolicy/u);
  assert.match(policy, /generate:/u);
  assert.match(policy, /kind: NetworkPolicy/u);
  assert.match(policy, /kinds: \[Namespace\]/u);
  assert.match(policy, /podSelector: \{\}/u);
  assert.match(policy, /policyTypes: \[Ingress, Egress\]/u);
  // Still excludes the reviewed system namespaces, and is enforce-scoped only.
  assert.match(policy, /namespaces: \[kube-system, kube-public, kube-node-lease, kyverno\]/u);
  assert.match(policy, /sutra\.io\/promotion-state: enforce/u);
});

test("every default policy excludes the reviewed system namespaces", async () => {
  for (const name of included) {
    const policy = await source(name);
    assert.match(policy, /namespaces: \[kube-system, kube-public, kube-node-lease, kyverno\]/u);
  }
});

test("signature and provenance templates are excluded, visibly incomplete, and fail closed only after opt-in", async () => {
  const signature = await source("optional/signature-verification.template.yaml");
  const provenance = await source("optional/provenance-verification.template.yaml");
  for (const template of [signature, provenance]) {
    assert.match(template, /intentionally excluded from kustomization\.yaml/u);
    assert.match(template, /sutra\.io\/template-state: requires-explicit-configuration/u);
    assert.match(template, /validationFailureAction: Enforce/u);
    assert.match(template, /failurePolicy: Fail/u);
    assert.match(template, /SET_ME/u);
    assert.match(template, /required: true/u);
    assert.match(template, /verifyDigest: true/u);
  }
  assert.match(signature, /publicKeys/u);
  assert.match(provenance, /predicateType: https:\/\/slsa\.dev\/provenance\/v1/u);
});

test("promotion representation requires independent approval and expiring exact exceptions", async () => {
  const promotion = await source("promotion-request.example.yaml");
  const readme = await source("README.md");
  assert.match(promotion, /fromMode: Audit/u);
  assert.match(promotion, /toMode: Enforce/u);
  assert.match(promotion, /requiredDifferentUser: true/u);
  assert.match(promotion, /approvedBy: null/u);
  assert.match(promotion, /policy: sutra-workload-security-audit/u);
  assert.match(promotion, /rule: disallow-host-path/u);
  assert.match(promotion, /namespace: application-namespace/u);
  assert.match(promotion, /resourceName: legacy-worker/u);
  assert.match(promotion, /expiresAt:/u);
  assert.match(promotion, /state: PendingIndependentReview/u);
  assert.match(readme, /must never run `kubectl`, Helm, or mutate a customer cluster/u);
  assert.match(readme, /different authorized human/u);
});

test("admission browser is evidence-only and exposes no cluster mutation action", async () => {
  const browser = await readFile(
    new URL("../app/kubernetes/admission/admission-workspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(browser, /sutra\.kubernetes-admission\.v1/u);
  assert.match(browser, /No browser-to-cluster mutation/u);
  assert.match(browser, /disabled type="button">Submit through approved change system/u);
  assert.doesNotMatch(browser, /fetch\([^)]*\{[^}]*method:\s*["'](?:POST|PUT|PATCH|DELETE)/su);
  assert.doesNotMatch(browser, /kubectl\s+(?:apply|create|delete|patch)|helm\s+(?:install|upgrade|uninstall)/iu);
});
