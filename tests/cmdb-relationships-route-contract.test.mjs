import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/cmdb/relationships/route.ts", import.meta.url),
  "utf8",
);

test("route is dynamic, authenticates, and gates on tenant scope resolved server-side", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getLatestConnectionForOrg\(authenticated\.subject\.orgId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, capability, connection\.customerId\)/u);
  // Tenant identity is derived from the resolved connection, never the caller.
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|customerId|tenantId)"\)/u);
  assert.match(route, /return errorResponse\(error\)/u);
});

test("GET reads with connection:read; mutations require connection:manage", () => {
  assert.match(route, /resolveScope\(request, "connection:read"\)/u);
  const manage = [...route.matchAll(/resolveScope\(request, "connection:manage"\)/gu)];
  assert.ok(manage.length >= 2, "expected connection:manage on both POST and DELETE");
});

test("POST and DELETE enforce the CSRF origin boundary; POST reads a bounded body", () => {
  const sameOrigin = [...route.matchAll(/assertSameOrigin\(request\)/gu)];
  assert.ok(sameOrigin.length >= 2, "expected assertSameOrigin on both POST and DELETE");
  assert.match(route, /readBoundedJson\(request, MAX_BODY_BYTES\)/u);
});

test("the graph is derived read-only and manual edges are validated against the live snapshot", () => {
  // Derived edges come from the pure engine over collected resources — no writes.
  assert.match(route, /deriveRelationships\(state\.resources\)/u);
  assert.match(route, /buildDependencyGraph\(/u);
  // A manual edge must reference two keys present in the current snapshot.
  assert.match(route, /keys\.has\(fromKey\) \|\| !keys\.has\(toKey\)/u);
  // Validation of the resource key, traversal mode and relationship id.
  assert.match(route, /RESOURCE_KEY\.test\(resourceKey\)/u);
  assert.match(route, /MODES\.has\(mode\)/u);
  assert.match(route, /RELATIONSHIP_ID\.test\(id\)/u);
  assert.match(route, /export async function GET\(/u);
  assert.match(route, /export async function POST\(/u);
  assert.match(route, /export async function DELETE\(/u);
});
