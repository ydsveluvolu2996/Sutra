import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const route = await readFile(resolve(root, "app/api/v1/enterprise/readiness/route.ts"), "utf8");

test("enterprise readiness is explicitly connection and tenant scoped", () => {
  assert.match(route, /requireConnectionScope\(request, "connection:read"\)/u);
  assert.match(route, /getPilotStateForOrg\(scope\.orgId, connection\.id\)/u);
  assert.match(route, /listPeriods\(scope, connection\.id\)/u);
  assert.match(route, /listSignoffs\(scope, connection\.id\)/u);
  assert.match(route, /buildComplianceReport\(state, complianceExceptions, now\)/u);
  assert.match(route, /signoff\.reportSha256 === complianceReport\.reportSha256/u);
  assert.match(route, /listDestinations\(scope\.orgId, scope\.customerId\)/u);
  assert.match(route, /withObservedNotificationReadiness\([\s\S]*storedDestinations,[\s\S]*jobs,[\s\S]*workerConfigured/u);
  assert.match(route, /new ItsmConnectorRepository\(\)\.list\(scope\)/u);
});

test("enterprise readiness derives ITSM secret posture from every enabled connector", () => {
  assert.match(route, /filter\(\(connector\) => connector\.enabled\)[\s\S]*every\(\(connector\) => connector\.secretStorage === "managed"\)/u);
  assert.doesNotMatch(route, /SUTRA_ITSM_MANAGED/u);
  assert.match(route, /outboundAt > updatedAt/u);
  assert.match(route, /inboundAt > updatedAt/u);
  assert.match(route, /bidirectionallyVerifiedConnectorCount/u);
});
