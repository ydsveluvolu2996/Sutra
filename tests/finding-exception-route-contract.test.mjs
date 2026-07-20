import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/findings/exceptions/route.ts", import.meta.url),
  "utf8",
);

test("Finding-exception route authenticates the session and resolves tenant scope server-side", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /getConnectionForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, capability, connection\.customerId\)/u);
  assert.match(route, /jsonResponse\(/u);
  assert.match(route, /return errorResponse\(error\)/u);
  // Tenant identity is derived from the authenticated session + resolved connection,
  // never accepted from the caller.
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|customerId)"\)/u);
  assert.match(route, /CONNECTION_ID\.test\(value\)/u);
});

test("reads require connection:read; mutations require finding:manage with same-origin + bounded body", () => {
  assert.match(route, /scopedConnection\(request, connectionId, "connection:read"\)/u);
  // Both POST and DELETE gate on finding:manage.
  const manageGates = route.match(/scopedConnection\(request, connectionId, "finding:manage"\)/gu) ?? [];
  assert.equal(manageGates.length, 2, "POST and DELETE both require finding:manage");
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /readBoundedJson\(request\)/u);
});

test("suppression is applied over the real snapshot findings, honestly and without forging an approver", () => {
  // Reuses the same active-snapshot findings the posture view loads.
  assert.match(route, /getPilotStateForOrg\(authenticated\.subject\.orgId, connectionId\)/u);
  assert.match(route, /state\.findings/u);
  assert.match(route, /applyFindingExceptions\(/u);
  // The engine reads no clock: the route passes a caller-computed nowDays.
  assert.match(route, /msToDays\(Date\.now\(\)\)/u);
  // A blank scope is refused (never a silent blanket suppression).
  assert.match(route, /An exception must scope at least one of a rule identifier or a resource reference/u);
  // The approver is the acting operator, never a client-supplied value.
  assert.match(route, /approvedBy: authenticated\.session\.user\.email/u);
  assert.doesNotMatch(route, /approvedBy: record\./u);
});
