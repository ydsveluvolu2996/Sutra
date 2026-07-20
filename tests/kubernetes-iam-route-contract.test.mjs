import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/kubernetes/iam/route.ts", import.meta.url),
  "utf8",
);

test("AWS IAM CIEM route authenticates the session and resolves tenant scope server-side", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(route, /jsonResponse\(/u);
  assert.match(route, /return errorResponse\(error\)/u);
  // Tenant identity is derived from the authenticated session and the resolved
  // connection, never accepted from the caller.
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|customerId)"\)/u);
  assert.doesNotMatch(route, /kubeconfig|bearer|secretAccessKey|sessionToken|roleArn/iu);
});

test("AWS IAM CIEM route reproduces the page computation from real evidence only", () => {
  // Same evidence source as the /kubernetes/iam page: authorized CMDB resources
  // merged with the projected latest Kubernetes workspace for the cluster.
  assert.match(route, /getPilotStateForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(route, /projectStoredKubernetesWorkspace\(workspace, connection\)/u);
  assert.match(route, /\[\.\.\.state\.resources, \.\.\.projected\]/u);
  // Same adapter -> engine composition the page runs.
  assert.match(route, /buildAwsIamCiem\(deriveAwsIamPrincipals\(resources\)\)/u);
  // Nothing is fabricated: the derivation runs over resources actually present.
  assert.doesNotMatch(route, /statements:\s*\[\]/u);
});
