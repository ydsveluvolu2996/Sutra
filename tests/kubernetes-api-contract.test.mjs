import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/kubernetes/route.ts", import.meta.url),
  "utf8",
);
const scansRoute = await readFile(
  new URL("../app/api/v1/kubernetes/scans/route.ts", import.meta.url),
  "utf8",
);
const onboarding = await readFile(
  new URL("../app/kubernetes/kubernetes-onboarding.tsx", import.meta.url),
  "utf8",
);

test("Kubernetes API resolves customer scope server-side and never accepts credentials", () => {
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:manage", connection\.customerId\)/u);
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /register-discovered-eks/u);
  assert.match(route, /candidate\.source\.accountId === connection\.awsAccountId/u);
  assert.doesNotMatch(route, /body\.(?:orgId|customerId|token|kubeconfig|credential|roleArn)/u);
});

test("Kubernetes scan publication is bounded, scoped and persists sanitized scanner evidence", () => {
  assert.match(scansRoute, /assertSameOrigin\(request\)/u);
  assert.match(scansRoute, /requireApiSession\(request\)/u);
  assert.match(scansRoute, /assertSessionCapability\(authenticated, "sync:run", connection\.customerId\)/u);
  assert.match(scansRoute, /readBoundedJson\(request, MAX_SCAN_BODY_BYTES\)/u);
  assert.match(scansRoute, /MAX_SCAN_BODY_BYTES = 3 \* 1024 \* 1024/u);
  assert.match(onboarding, /file\.size > 2_750 \* 1024/u);
  assert.match(scansRoute, /snapshot\.clusterId !== cluster\.clusterUid/u);
  assert.match(scansRoute, /canonicalJson\(evaluateKubernetesPosture\(evidence\)\)/u);
  assert.match(scansRoute, /scannerEvidence:\s*\{/u);
  assert.match(scansRoute, /findings: snapshot\.trivyFindings/u);
  assert.doesNotMatch(scansRoute, /kubeconfig|bearer|secretAccessKey|sessionToken/iu);
});
