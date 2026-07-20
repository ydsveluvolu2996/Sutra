import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("../app/api/v1/alerts/route.ts", import.meta.url), "utf8");

test("the alerts route is dynamic and authenticates every method server-side", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /export async function GET\(/u);
  assert.match(route, /export async function POST\(/u);
  assert.match(route, /export async function DELETE\(/u);
  // Every method authenticates via the session; tenant identity is never taken
  // as an org/tenant id from the caller.
  const sessions = route.match(/requireApiSession\(request\)/gu) ?? [];
  assert.ok(sessions.length >= 3, "each method must require a session");
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|tenantId)"\)/u);
  assert.match(route, /authenticated\.subject\.orgId/u);
});

test("reads gate on connection:read and mutations gate on connection:manage", () => {
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read", scopedCustomerId\)/u);
  const manage = route.match(/assertSessionCapability\(authenticated, "connection:manage", scopedCustomerId\)/gu) ?? [];
  assert.ok(manage.length >= 3, "save/setEnabled/delete must gate on connection:manage");
});

test("mutations enforce same-origin and bounded JSON; strict query params", () => {
  const sameOrigin = route.match(/assertSameOrigin\(request\)/gu) ?? [];
  assert.ok(sameOrigin.length >= 2, "POST and DELETE must assert same-origin");
  assert.match(route, /readBoundedJson\(request/u);
  // GET and DELETE reject unexpected query params.
  assert.match(route, /\[\.\.\.url\.searchParams\.keys\(\)\]\.some\(/u);
});

test("responses go through the shared json/error helpers", () => {
  assert.match(route, /jsonResponse\(/u);
  assert.match(route, /return errorResponse\(error\)/u);
});

test("rule input is validated with the pure metric/comparator/severity guards", () => {
  assert.match(route, /isSupportedAlertMetric\(/u);
  assert.match(route, /isAlertComparator\(/u);
  assert.match(route, /isAlertSeverity\(/u);
  // The threshold is bounded and finite.
  assert.match(route, /Number\.isFinite\(record\.threshold\)/u);
});
