import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/kubernetes/installations/plan/route.ts", import.meta.url),
  "utf8",
);
const onboarding = await readFile(
  new URL("../app/kubernetes/kubernetes-onboarding.tsx", import.meta.url),
  "utf8",
);

test("installation planning resolves tenant and cluster scope server-side", () => {
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /readBoundedJson\(request, 8 \* 1024\)/u);
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId, body\.connectionId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:manage", connection\.customerId\)/u);
  assert.match(route, /candidate\.id === body\.clusterId && candidate\.status === "active"/u);
  assert.doesNotMatch(route, /body\.(?:orgId|customerId|token|kubeconfig|credential|roleArn)/u);
  assert.doesNotMatch(route, /child_process|spawn|execFile|kubectl|helm/u);
});

test("onboarding exposes selectable modules, health and rollback without browser execution", () => {
  for (const moduleName of ["inventory", "trivy", "kyverno", "falco", "cilium", "supply-chain"]) {
    assert.match(onboarding, new RegExp(`(?:${moduleName}|${moduleName[0].toUpperCase()}${moduleName.slice(1)})`, "u"));
  }
  assert.match(onboarding, /Generate installation plan/u);
  assert.match(onboarding, /healthCommand/u);
  assert.match(onboarding, /rollbackOrder/u);
  assert.match(onboarding, /cannot execute the generated cluster commands/u);
});
