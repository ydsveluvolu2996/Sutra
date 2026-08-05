import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const goals = readFileSync(
  new URL("../app/api/v1/finops/kpi-goals/route.ts", import.meta.url),
  "utf8",
);
const taxonomy = readFileSync(
  new URL("../app/api/v1/finops/taxonomy/route.ts", import.meta.url),
  "utf8",
);

for (const [name, route] of [["KPI goals", goals], ["taxonomy", taxonomy]]) {
  test(`${name} route is dynamic, session-authenticated, bounded, and resolves the customer from a live AWS connection`, () => {
    assert.match(route, /export const dynamic = "force-dynamic"/u);
    assert.match(route, /requireApiSession\(request\)/u);
    assert.match(route, /readBoundedJson\(request, BODY_BYTES\)/u);
    assert.match(route, /getConnectionForOrg\(\s*authenticated\.subject\.orgId/u);
    assert.match(route, /connection\.sourceKind !== "aws_trust_role"/u);
    assert.match(route, /connection\.status !== "active"/u);
    assert.match(route, /assertSessionCapability\(authenticated, capability, connection\.customerId\)/u);
    assert.ok(
      route.indexOf("requireApiSession(request)") < route.indexOf("readBoundedJson(request, BODY_BYTES)"),
      "authentication and mutation same-origin enforcement must precede body parsing",
    );
    assert.doesNotMatch(route, /body\.(?:orgId|organizationId|customerId|actorId)/u);
    assert.match(route, /exactRecord/u);
    assert.match(route, /errorResponse\(error\)/u);
  });
}

test("GET is connectionId-only with read access; POST requires manage access and server actor identity", () => {
  for (const route of [goals, taxonomy]) {
    assert.match(route, /key !== "connectionId"/u);
    assert.match(route, /"connection:read"/u);
    assert.match(route, /"connection:manage"/u);
    assert.match(route, /authenticated\.subject\.userId/u);
  }
  assert.match(goals, /BODY_KEYS/u);
  assert.match(goals, /targetBasisPoints/u);
  assert.match(goals, /rbacDecision/u);
  assert.match(taxonomy, /ALLOW_LIST_KEYS/u);
  assert.match(taxonomy, /ASSIGNMENT_KEYS/u);
  assert.match(taxonomy, /value\.length > 10_000/u);
});
