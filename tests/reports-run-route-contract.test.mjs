import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runRoute = await readFile(new URL("../app/api/v1/reports/run/route.ts", import.meta.url), "utf8");
const savedRoute = await readFile(new URL("../app/api/v1/reports/saved/route.ts", import.meta.url), "utf8");

test("run route is dynamic, authenticates, and gates on the resolved tenant scope server-side", () => {
  assert.match(runRoute, /export const dynamic = "force-dynamic"/u);
  assert.match(runRoute, /requireConnectionScope\(request, "connection:read"\)/u);
  // Tenant identity comes from the resolved connection, never from the caller.
  assert.doesNotMatch(runRoute, /searchParams\.get\("(?:orgId|customerId|tenantId)"\)/u);
  assert.match(runRoute, /return errorResponse\(error\)/u);
});

test("run route enforces the CSRF origin boundary and a bounded body before validating the definition", () => {
  assert.match(runRoute, /assertSameOrigin\(request\)/u);
  assert.match(runRoute, /readBoundedJson\(request, MAX_BODY_BYTES\)/u);
  assert.match(runRoute, /validateReportDefinition\(/u);
  assert.ok(runRoute.indexOf("assertSameOrigin(request)") < runRoute.indexOf("readBoundedJson(request, MAX_BODY_BYTES)"));
});

test("run route loads rows tenant-scoped, runs the pure engine, and returns JSON by default", () => {
  assert.match(runRoute, /resourcesForQuery\(scope, connection\.id\)/u);
  assert.match(runRoute, /getPilotStateForOrg\(scope\.orgId, connection\.id\)/u);
  assert.match(runRoute, /buildReport\(definition, /u);
  assert.match(runRoute, /jsonResponse\(\{ report \}\)/u);
});

test("run route returns RFC-4180 CSV with a text/csv content type and an attachment disposition", () => {
  assert.match(runRoute, /toCsv\(report\.columns, report\.rows\)/u);
  assert.match(runRoute, /"content-type": "text\/csv; charset=utf-8"/u);
  assert.match(runRoute, /"content-disposition": 'attachment; filename="report\.csv"'/u);
});

test("saved route is dynamic, authenticates, and never trusts caller-supplied tenant ids", () => {
  assert.match(savedRoute, /export const dynamic = "force-dynamic"/u);
  assert.match(savedRoute, /requireConnectionScope\(request, capability\)/u);
  assert.doesNotMatch(savedRoute, /searchParams\.get\("(?:orgId|customerId|tenantId)"\)/u);
  assert.match(savedRoute, /jsonResponse\(/u);
  assert.match(savedRoute, /return errorResponse\(error\)/u);
});

test("saved route reads with connection:read and mutates with connection:manage behind the CSRF + bounded-body boundary", () => {
  assert.match(savedRoute, /resolveScope\(request, "connection:read"\)/u);
  assert.match(savedRoute, /resolveScope\(request, "connection:manage"\)/u);
  assert.match(savedRoute, /assertSameOrigin\(request\)/u);
  assert.match(savedRoute, /readBoundedJson\(request, MAX_BODY_BYTES\)/u);
  // assertSameOrigin must run before the body is read/parsed in POST.
  assert.ok(savedRoute.indexOf("assertSameOrigin(request)") < savedRoute.indexOf("readBoundedJson(request, MAX_BODY_BYTES)"));
});
