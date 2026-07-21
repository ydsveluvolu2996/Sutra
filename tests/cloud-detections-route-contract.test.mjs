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
  assert.match(route, /buildCloudDetectionInputs\(workspace\.events, \{/u);
  assert.match(route, /tenant: connection\.customerId/u);
  assert.match(route, /buildCloudDetections\(inputs\.events\)/u);
  // Coverage (present vs absent sources) is returned to the client, never hidden.
  assert.match(route, /coverage: inputs\.coverage/u);
});

test("cloud-detections route feeds read-only GuardDuty findings as a second source", () => {
  // GuardDuty findings are read from the connection's already-collected
  // inventory snapshot (read-only guardduty:ListDetectors/ListFindings/
  // GetFindings), reshaped, and merged into the engine's event stream.
  assert.match(route, /getPilotStateForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(route, /AWS\.NATIVE\.GUARDDUTY\.FINDING/u);
  assert.match(route, /guardDutyFindings/u);
  // A source with no collection pipeline is declared absent, not faked empty:
  // GuardDuty is fed only when an inventory snapshot exists for the connection.
  assert.match(route, /pilot\.activeSnapshot !== null/u);
  // The route reshapes findings read-only; it must not construct any AWS SDK
  // command or mutate the account.
  assert.doesNotMatch(route, /new\s+[A-Za-z]+Command\(/u);
});
