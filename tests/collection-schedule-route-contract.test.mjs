import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/collection-schedule/status/route.ts", import.meta.url),
  "utf8",
);

test("collection-schedule status route authenticates and gates on tenant scope server-side", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, "workspace:read"\)/u);
  // Per-fixture tenant scoping mirrors the Operations schedules route.
  assert.match(route, /capability: "connection:read"/u);
  assert.match(route, /fixture\.tenantId === authenticated\.subject\.orgId/u);
  assert.match(route, /jsonResponse\(/u);
  assert.match(route, /return errorResponse\(error\)/u);
  // Tenant identity comes from the session, never from the caller.
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|customerId|tenantId)"\)/u);
});

test("collection-schedule status route strictly rejects unexpected query params", () => {
  assert.match(route, /\[\.\.\.url\.searchParams\.keys\(\)\]\.length !== 0\) invalid\(\)/u);
});

test("collection-schedule status route feeds real configured schedules through the adapter and engine", () => {
  assert.match(route, /getLocalFixtureCatalog\(\)/u);
  assert.match(route, /getLocalFixtureSchedules\(fixture\)/u);
  assert.match(route, /buildCollectionScheduleInputs\(schedules, Date\.now\(\)\)/u);
  assert.match(route, /evaluateSchedules\(inputs\.schedules, inputs\.nowMinutes\)/u);
});
