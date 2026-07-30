import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), "utf8");
}

const helper = await source("lib/api-connection-scope.ts");

const CUSTOMER_SCOPED_ROUTES = [
  "app/api/v1/reports/run/route.ts",
  "app/api/v1/reports/saved/route.ts",
  "app/api/v1/finops/allocation-rules/route.ts",
  "app/api/v1/finops/budgets/route.ts",
  "app/api/v1/finops/reports/route.ts",
  "app/api/v1/finops/resource-schedules/route.ts",
  "app/api/v1/finops/unit-counts/route.ts",
  "app/api/v1/cmdb/custom-assets/route.ts",
  "app/api/v1/cmdb/relationships/route.ts",
  "app/api/v1/cmdb/saved-queries/route.ts",
  "app/api/v1/compliance/control-assignments/route.ts",
  "app/api/v1/api-tokens/route.ts",
  "app/api/v1/governance/approvals/route.ts",
  "app/api/v1/governance/policies/route.ts",
  "app/api/v1/itsm/connectors/route.ts",
  "app/api/v1/itsm/dispatch/route.ts",
];

const SCOPED_CLIENTS = [
  "app/reports/report-builder.tsx",
  "app/costs/finops-panels.tsx",
  "app/costs/finops-wave3-panels.tsx",
  "app/costs/finops-schedule-panel.tsx",
  "app/cmdb/custom-assets-panel.tsx",
  "app/cmdb/dependencies-panel.tsx",
  "app/cmdb/workspace-panels.tsx",
  "app/compliance-frameworks/workspace-panels.tsx",
  "app/settings/api-tokens-panel.tsx",
  "app/settings/governance-policies-panel.tsx",
  "app/settings/itsm-connectors-panel.tsx",
];

test("two-customer route contract resolves the exact selected connection and authorizes its customer", () => {
  assert.match(helper, /searchParams\.get\("connectionId"\)/u);
  assert.match(helper, /CONNECTION_ID\.test\(connectionId\)/u);
  assert.match(helper, /getConnectionForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(helper, /assertSessionCapability\(authenticated, capability, connection\.customerId\)/u);
  assert.doesNotMatch(helper, /getLatestConnectionForOrg/u);
});

test("every enterprise customer-scoped API requires the shared explicit-connection boundary", async () => {
  for (const path of CUSTOMER_SCOPED_ROUTES) {
    const route = await source(path);
    assert.match(route, /requireConnectionScope/u, `${path} must resolve the selected connection`);
    assert.doesNotMatch(route, /getLatestConnectionForOrg/u, `${path} must not select customer A merely because A is newest`);
  }
});

test("every scoped client propagates connectionId from its selected workspace", async () => {
  for (const path of SCOPED_CLIENTS) {
    const client = await source(path);
    assert.match(
      client,
      /connectionId=\$\{encodeURIComponent\(connectionId\)\}/u,
      `${path} must send the selected connection so customer B never reads customer A`,
    );
  }
});

test("ITSM inbound resolves a connection within the connector customer instead of the newest org customer", async () => {
  const inbound = await source("app/api/v1/itsm/inbound/[connectorId]/route.ts");
  assert.match(inbound, /listConnectionsForOrg\(connector\.orgId\)/u);
  assert.match(inbound, /filter\(\(candidate\) => candidate\.customerId === connector\.customerId\)/u);
  assert.match(inbound, /for \(const connection of customerConnections\)/u);
  assert.doesNotMatch(inbound, /getLatestConnectionForOrg/u);
});
