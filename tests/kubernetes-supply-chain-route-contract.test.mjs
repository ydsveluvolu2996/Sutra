import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/kubernetes/supply-chain/trust/route.ts", import.meta.url),
  "utf8",
);

test("Supply-chain trust route authenticates the session and resolves tenant scope server-side", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(route, /customerId: connection\.customerId, clusterId/u);
  assert.match(route, /jsonResponse\(/u);
  assert.match(route, /return errorResponse\(error\)/u);
  // The evidence limit is bounded, matching the raw supply-chain route.
  assert.match(route, /limit < 1 \|\| limit > 500/u);
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|customerId)"\)/u);
});

test("Supply-chain trust route mirrors the trust panel without fabricating VEX or vulnerabilities", () => {
  // Loads the same stored evidence the panel consumes.
  assert.match(route, /new KubernetesSupplyChainRepository\(\)\.list\(scope, limit\)/u);
  // One artifact per image digest, using the same adapter the page uses.
  assert.match(route, /byDigest\.set\(record\.image\.digest, record\)/u);
  assert.match(route, /evidenceToArtifact\(record\)/u);
  // Evidence honesty: no fabricated VEX/vulnerability inputs — the engine's
  // "submitted attestation metadata only" claim boundary stands.
  assert.match(route, /verifySupplyChainTrust\(\{/u);
  assert.match(route, /vexStatements:\s*\[\]/u);
  assert.match(route, /vulnerabilities:\s*\[\]/u);
});
