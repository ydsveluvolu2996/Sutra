import assert from "node:assert/strict";
import test from "node:test";
import {
  createKubernetesInstallationPlan,
  KubernetesInstallationPlanError,
} from "../lib/kubernetes-installation-plan.ts";

const base = {
  clusterId: `kcluster_${"a".repeat(48)}`,
  clusterName: "customer-production",
  context: "arn:aws:eks:ap-south-1:123456789012:cluster/customer-production",
} as const;

test("creates a customer-reviewable modular lifecycle without executing mutations", () => {
  const plan = createKubernetesInstallationPlan({
    ...base,
    modules: ["inventory", "trivy", "kyverno", "falco", "cilium", "supply-chain"],
  });
  assert.equal(plan.schema, "sutra.kubernetes-installation-plan.v1");
  assert.equal(plan.lifecycle.state, "planned");
  assert.equal(plan.lifecycle.mutationsExecuted, false);
  assert.equal(plan.lifecycle.requiresCniApproval, true);
  assert.deepEqual(plan.lifecycle.installOrder, [
    "inventory", "trivy", "kyverno", "falco", "cilium", "supply-chain",
  ]);
  assert.deepEqual(plan.lifecycle.rollbackOrder, [
    "supply-chain", "cilium", "falco", "kyverno", "trivy", "inventory",
  ]);
  assert.match(plan.lifecycle.preflightCommand, /--allow-cni-change/u);
  assert.match(plan.lifecycle.healthCommand, /--format json/u);
  assert.ok(plan.prerequisites.some((item) => item.id === "cni-change"));
  assert.deepEqual(plan.safety, {
    secretsCollected: false,
    configMapValuesCollected: false,
    kubeconfigAcceptedByApi: false,
    auditFirstAdmission: true,
    ciliumRequiresExplicitApproval: true,
  });
});

test("orders selections deterministically and omits CNI approval when Cilium is absent", () => {
  const plan = createKubernetesInstallationPlan({
    ...base,
    modules: ["falco", "inventory", "trivy"],
  });
  assert.deepEqual(plan.lifecycle.installOrder, ["inventory", "trivy", "falco"]);
  assert.equal(plan.lifecycle.requiresCniApproval, false);
  assert.doesNotMatch(plan.lifecycle.preflightCommand, /allow-cni-change/u);
  assert.ok(plan.modules.every((module) => module.expectedHealthChecks.length > 0));
});

test("rejects duplicate, empty, unknown and shell-injection input", () => {
  for (const input of [
    { ...base, modules: [] },
    { ...base, modules: ["trivy", "trivy"] },
    { ...base, modules: ["unknown"] },
    { ...base, context: "prod;curl example.invalid", modules: ["trivy"] },
    { ...base, clusterName: "prod\ncluster", modules: ["trivy"] },
  ]) {
    assert.throws(
      () => createKubernetesInstallationPlan(input as never),
      KubernetesInstallationPlanError,
    );
  }
});
