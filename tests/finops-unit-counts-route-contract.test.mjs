import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/finops/unit-counts/route.ts", import.meta.url),
  "utf8",
);

test("unit-counts route is dynamic, authenticates, and gates on tenant scope server-side", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireConnectionScope\(request, capability\)/u);
  // Tenant identity comes from the resolved connection, never from the caller.
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|customerId|tenantId)"\)/u);
  assert.match(route, /jsonResponse\(/u);
  assert.match(route, /return errorResponse\(error\)/u);
});

test("GET reads with connection:read; POST writes with connection:manage", () => {
  assert.match(route, /resolveScope\(request, "connection:read"\)/u);
  assert.match(route, /resolveScope\(request, "connection:manage"\)/u);
});

test("POST enforces the CSRF origin boundary, a bounded body, and full validation before writing", () => {
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /readBoundedJson\(request, MAX_BODY_BYTES\)/u);
  assert.match(route, /isValidPeriod\(period\)/u);
  assert.match(route, /isValidUnitLabel\(unitLabel\)/u);
  assert.match(route, /isValidUnitCount\(count\)/u);
  // assertSameOrigin must run before the body is read/parsed.
  assert.ok(route.indexOf("assertSameOrigin(request)") < route.indexOf("readBoundedJson(request, MAX_BODY_BYTES)"));
});
