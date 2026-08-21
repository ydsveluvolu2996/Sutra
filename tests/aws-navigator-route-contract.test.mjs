import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("../app/api/v1/cmdb/navigator/route.ts", import.meta.url), "utf8");

test("AWS Navigator route derives tenant/account scope on the server and rejects substitution", () => {
  assert.match(source, /requirePilotActor\(request, "workspace:read"\)/u);
  assert.match(source, /getConnectionForOrg\(actor\.orgId, selectedConnectionId\)/u);
  assert.match(source, /assertSessionCapability\(actor\.authenticated, "connection:read", connection\.customerId\)/u);
  assert.match(source, /getPilotStateForOrg\(actor\.orgId, connection\.id\)/u);
  assert.match(source, /assertAwsNavigatorStateBoundary\(connection, state\)/u);
  assert.doesNotMatch(source, /searchParams\.get\("(?:orgId|customerId|accountId)"\)/u);
  assert.doesNotMatch(source, /@aws-sdk/u);
});

test("AWS Navigator route accepts only bounded navigation filters", () => {
  assert.match(source, /ALLOWED_PARAMETERS = new Set\(\["connectionId", "path", "q", "region"\]\)/u);
  assert.match(source, /getAll\(key\)\.length > 1/u);
  assert.match(source, /buildAwsNavigatorEnvelope/u);
});
