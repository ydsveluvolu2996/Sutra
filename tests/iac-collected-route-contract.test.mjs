import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/iac-scan/collected/route.ts", import.meta.url),
  "utf8",
);

test("collected IaC route authenticates the session and resolves tenant scope server-side", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(route, /jsonResponse\(/u);
  assert.match(route, /return errorResponse\(error\)/u);
  // Tenant identity comes from the authenticated session + resolved connection,
  // never from the caller; the customerId is used as the scan tenant.
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|customerId)"\)/u);
  assert.match(route, /orgId: authenticated\.subject\.orgId, customerId: connection\.customerId/u);
});

test("collected IaC route strictly whitelists and validates its query params", () => {
  assert.match(route, /\[\.\.\.url\.searchParams\.keys\(\)\]\.some\(\(key\) => key !== "connectionId" && key !== "clusterId"\)/u);
  assert.match(route, /CONNECTION_ID = \/\^conn_\[a-f0-9\]\{32\}\$\/u/u);
  assert.match(route, /CLUSTER_ID = \/\^kcluster_\[a-f0-9\]\{48\}\$\/u/u);
  assert.match(route, /CONNECTION_ID\.test\(connectionId\)/u);
  assert.match(route, /CLUSTER_ID\.test\(clusterIdValue\)/u);
});

test("collected IaC route reads already-collected workload specs and runs the committed engine via the adapter", () => {
  // Real ingest: tenant-scoped cluster list + stored workload specs, not pasted text.
  assert.match(route, /new KubernetesRepository\(\)/u);
  assert.match(route, /repository\.listClusters\(scope\)/u);
  assert.match(route, /repository\.listWorkloadScans\(scope, cluster\.id\)/u);
  assert.match(route, /workload\.kind === "Workload"/u);
  // Adapter -> committed scanner composition; tenant flows into the scan options.
  assert.match(route, /buildCollectedIacInput\(collected\)/u);
  assert.match(route, /scanIacResources\(input\.resources, \{ tenant: connection\.customerId \}\)/u);
  assert.match(route, /coverage: input\.coverage/u);
  // A requested cluster outside the tenant-scoped list is a not-found, never a
  // silent empty scan; no fabricated findings are constructed in the route.
  assert.match(route, /targets\.length === 0/u);
  assert.match(route, /code: "NOT_FOUND"/u);
});
