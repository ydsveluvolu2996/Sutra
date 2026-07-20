import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/registry/inventory/route.ts", import.meta.url),
  "utf8",
);

test("Registry inventory route authenticates the session and resolves tenant scope server-side", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(route, /jsonResponse\(/u);
  assert.match(route, /return errorResponse\(error\)/u);
  // Tenant identity is derived from the authenticated session + resolved connection,
  // never accepted from the caller.
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|customerId)"\)/u);
  assert.match(route, /CONNECTION_ID\.test\(connectionId\)/u);
});

test("strict param validation: only connectionId is accepted", () => {
  assert.match(route, /some\(\(key\) => key !== "connectionId"\)/u);
});

test("loads real observed image refs through the adapter and the inventory engine only", () => {
  assert.match(route, /listClusters\(scope\)/u);
  assert.match(route, /new KubernetesSupplyChainRepository\(\)/u);
  assert.match(route, /buildRegistryInventoryInput\(/u);
  assert.match(route, /inventoryRegistry\(input\)/u);
  // Honest source flag: coverage is unknown when no clusters were scanned.
  assert.match(route, /sourceCollected: clusters\.length > 0/u);
  // Inventory/policy only — this route must never reach into CVE scanning.
  assert.doesNotMatch(route, /vulnerability|trivy|cve/iu);
});
