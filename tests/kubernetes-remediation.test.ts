import assert from "node:assert/strict";
import test from "node:test";
import { buildRemediationPlan } from "../lib/kubernetes-remediation.ts";

test("a privileged-workload issue yields a hardening patch, a Kyverno policy, and a network policy", () => {
  const plan = buildRemediationPlan({ ruleId: "exposed-privileged-workload", workload: "payments/frontend" });
  const kinds = plan.artifacts.map((a) => a.kind);
  assert.ok(kinds.includes("kubectl-patch"));
  assert.ok(kinds.includes("kyverno-policy"));
  assert.ok(kinds.includes("network-policy"));
  const patch = plan.artifacts.find((a) => a.kind === "kubectl-patch");
  assert.match(patch?.content ?? "", /-n payments patch deployment frontend/u);
  assert.match(patch?.content ?? "", /"privileged": false/u);
  const policy = plan.artifacts.find((a) => a.kind === "kyverno-policy");
  assert.match(policy?.content ?? "", /validationFailureAction: Audit/u);
});

test("a vulnerability issue yields a digest-pinned image-upgrade step naming the package and fix", () => {
  const plan = buildRemediationPlan({
    ruleId: "exposed-vulnerable-workload", workload: "payments/api",
    packageName: "openssl", fixedVersion: "3.0.2", cveId: "CVE-2026-9",
  });
  const upgrade = plan.artifacts.find((a) => a.kind === "image-upgrade");
  assert.ok(upgrade !== undefined);
  assert.match(upgrade.content, /Upgrade openssl to 3\.0\.2/u);
  assert.match(upgrade.content, /CVE-2026-9/u);
  assert.match(upgrade.content, /sha256:<new-digest>/u);
  // Exposed rules also get a default-deny network policy.
  assert.ok(plan.artifacts.some((a) => a.kind === "network-policy"));
});

test("a vulnerability with no fix explains mitigation instead of a version bump", () => {
  const plan = buildRemediationPlan({ ruleId: "critical-vulnerability", workload: "batch/worker", packageName: "zlib", fixedVersion: null });
  const upgrade = plan.artifacts.find((a) => a.kind === "image-upgrade");
  assert.match(upgrade?.content ?? "", /No fixed version is published for zlib/u);
  // A non-exposed rule gets no network policy.
  assert.ok(!plan.artifacts.some((a) => a.kind === "network-policy"));
});

test("an over-permissioned identity issue yields an RBAC review artifact", () => {
  const plan = buildRemediationPlan({ ruleId: "exposed-overpermissioned-identity", workload: "kube-system/ops" });
  assert.ok(plan.artifacts.some((a) => a.kind === "rbac-review"));
  assert.ok(plan.artifacts.some((a) => a.kind === "network-policy"));
});

test("every artifact carries a validation note and the plan an operator disclaimer", () => {
  const plan = buildRemediationPlan({ ruleId: "runtime-active-privileged-workload", workload: "payments/frontend" });
  assert.ok(plan.artifacts.length > 0);
  for (const artifact of plan.artifacts) assert.ok(artifact.note.length > 0, `${artifact.kind} needs a note`);
  assert.match(plan.disclaimer, /operator-validated suggestions, not automatic changes/u);
});

test("an unknown rule produces no artifacts rather than a wrong fix", () => {
  const plan = buildRemediationPlan({ ruleId: "some-future-rule", workload: "x/y" });
  assert.equal(plan.artifacts.length, 0);
});

test("workload without a namespace defaults safely and output is deterministic", () => {
  const build = () => buildRemediationPlan({ ruleId: "exposed-privileged-workload", workload: "loneworkload" });
  const plan = build();
  const patch = plan.artifacts.find((a) => a.kind === "kubectl-patch");
  assert.match(patch?.content ?? "", /-n default patch deployment loneworkload/u);
  assert.deepEqual(build(), plan);
});
