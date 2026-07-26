// The latency overlay on the network-exposure view is fed only by
// POST /api/v1/latency-samples, which has no producer in this repository. These
// assertions pin the honesty contract: when nothing was ingested the API says
// so explicitly and the UI states latency was not measured, naming the ingest
// path an operator must install — never a 0ms, a bare dash, or an empty table.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const exposureRoute = await readFile(new URL("../app/api/v1/network-exposure/route.ts", import.meta.url), "utf8");
const ingestRoute = await readFile(new URL("../app/api/v1/latency-samples/route.ts", import.meta.url), "utf8");
const browser = await readFile(new URL("../app/network-exposure/network-exposure-browser.tsx", import.meta.url), "utf8");

test("network-exposure reports latency availability from the real sample count", () => {
  assert.match(exposureRoute, /latencyMeasurementFor\(latencySamples\.length\)/u);
  assert.match(exposureRoute, /latencyMeasurement,/u);
  // Availability is derived from ingested rows, never hardcoded true.
  assert.doesNotMatch(exposureRoute, /available:\s*true/u);
});

test("network-exposure keeps tenant scope session-derived while reading samples", () => {
  assert.match(exposureRoute, /getConnectionForOrg\(actor\.orgId, connectionId\)/u);
  assert.match(exposureRoute, /assertSessionCapability\(actor\.authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(exposureRoute, /recentForConnection\(\s*\{ orgId: actor\.orgId, customerId: connection\.customerId \}/u);
  assert.doesNotMatch(exposureRoute, /searchParams\.get\("(?:orgId|customerId)"\)/u);
});

test("the UI states latency was not measured and names the required producer", () => {
  assert.match(browser, /latencyMeasurement\?\.available \?\? false/u);
  assert.match(browser, /Latency was not measured/u);
  assert.match(browser, /POST \/api\/v1\/latency-samples/u);
  assert.match(browser, /not measured/u);
  // A null p95 renders as "not measured", not as a dash that reads as fast.
  assert.match(browser, /p95Ms === null \? "not measured"/u);
  assert.doesNotMatch(browser, /p95Ms \?\? "—"/u);
});

test("the ingest route documents its producer contract and stays session-gated", () => {
  assert.match(ingestRoute, /PRODUCER CONTRACT/u);
  assert.match(ingestRoute, /No producer for this endpoint exists anywhere in this repository/u);
  assert.match(ingestRoute, /connectionId/u);
  assert.match(ingestRoute, /observedAtMs/u);
  // The endpoint and engine must still exist — an external collector may be real.
  assert.match(ingestRoute, /export async function POST/u);
  assert.match(ingestRoute, /assertSameOrigin\(request\)/u);
  assert.match(ingestRoute, /requirePilotActor\(request, "workspace:read"\)/u);
  assert.match(ingestRoute, /assertSessionCapability\(actor\.authenticated, "connection:manage", connection\.customerId\)/u);
});
