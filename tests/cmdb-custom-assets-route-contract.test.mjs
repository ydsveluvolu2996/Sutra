import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/cmdb/custom-assets/route.ts", import.meta.url),
  "utf8",
);

test("custom-assets route is dynamic, authenticates, and gates on tenant scope server-side", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireConnectionScope\(request, capability\)/u);
  // Tenant identity comes from the resolved connection, never from the caller.
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|customerId|tenantId)"\)/u);
  assert.match(route, /jsonResponse\(/u);
  assert.match(route, /return errorResponse\(error\)/u);
});

test("GET reads with connection:read; POST and DELETE write with connection:manage", () => {
  assert.match(route, /resolveScope\(request, "connection:read"\)/u);
  assert.match(route, /resolveScope\(request, "connection:manage"\)/u);
});

test("POST enforces the CSRF origin boundary and a bounded body before parsing the import", () => {
  assert.match(route, /assertSameOrigin\(request\)/u);
  assert.match(route, /readBoundedJson\(request, MAX_BODY_BYTES\)/u);
  assert.match(route, /parseAssetImport\(/u);
  // assertSameOrigin must run before the body is read/parsed.
  assert.ok(route.indexOf("assertSameOrigin(request)") < route.indexOf("readBoundedJson(request, MAX_BODY_BYTES)"));
});

test("bulk import discloses rejected rows alongside the imported count", () => {
  assert.match(route, /rejected: parsed\.rejected/u);
  assert.match(route, /imported/u);
});

test("DELETE is origin-checked and gated on a validated asset id", () => {
  assert.match(route, /ASSET_ID = \/\^cas_/u);
  assert.match(route, /export async function DELETE/u);
});
