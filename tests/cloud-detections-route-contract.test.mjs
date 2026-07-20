import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/cloud-detections/route.ts", import.meta.url),
  "utf8",
);

test("cloud-detections route authenticates the session and resolves tenant scope server-side", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(route, /jsonResponse\(/u);
  assert.match(route, /return errorResponse\(error\)/u);
  // Tenant identity comes from the authenticated session + resolved connection,
  // never from the caller.
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|customerId)"\)/u);
  assert.match(route, /orgId: authenticated\.subject\.orgId,\s*customerId: connection\.customerId/u);
});

test("cloud-detections route strictly whitelists and validates its query params", () => {
  assert.match(route, /\[\.\.\.url\.searchParams\.keys\(\)\]\.some\(\(key\) => key !== "connectionId"\)/u);
  assert.match(route, /CONNECTION_ID = \/\^conn_\[a-f0-9\]\{32\}\$\/u/u);
  assert.match(route, /CONNECTION_ID\.test\(connectionId\)/u);
});

test("cloud-detections route feeds already-collected CloudTrail events through the adapter and engine", () => {
  // Real ingest: tenant-scoped collected security events, mapped by the adapter,
  // evaluated by the committed engine — no fixture or fabricated stream.
  assert.match(route, /getSecurityEventsWorkspace\(/u);
  assert.match(route, /buildCloudDetectionInputs\(workspace\.events, \{ tenant: connection\.customerId \}\)/u);
  assert.match(route, /buildCloudDetections\(inputs\.events\)/u);
  // Single-source coverage is returned to the client, never hidden.
  assert.match(route, /coverage: inputs\.coverage/u);
});
