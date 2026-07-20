import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(
  new URL("../app/api/v1/finops/reports/route.ts", import.meta.url),
  "utf8",
);
const jobsRoute = await readFile(
  new URL("../app/api/internal/jobs/run/route.ts", import.meta.url),
  "utf8",
);

test("reports route is dynamic, authenticates, and gates on tenant scope server-side", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, capability, connection\.customerId\)/u);
  assert.match(route, /assertSessionCapability\(authenticated, "connection:manage", connection\.customerId\)/u);
  // Tenant identity comes from the resolved connection, never from the caller.
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|customerId|tenantId)"\)/u);
  assert.match(route, /return errorResponse\(error\)/u);
});

test("GET reads with connection:read; mutations require connection:manage", () => {
  assert.match(route, /resolveTenantScope\(request, "connection:read"\)/u);
  assert.match(route, /resolveTenantScope\(request, "connection:manage"\)/u);
});

test("POST and DELETE enforce the CSRF origin boundary; POST reads a bounded body", () => {
  // Both state-changing verbs assert same-origin.
  const sameOrigin = [...route.matchAll(/assertSameOrigin\(request\)/gu)];
  assert.ok(sameOrigin.length >= 2, "expected assertSameOrigin on both POST and DELETE");
  assert.match(route, /readBoundedJson\(request, MAX_BODY_BYTES\)/u);
  // Create/update validates every field before touching the repository.
  assert.match(route, /REPORT_NAME\.test\(name\)/u);
  assert.match(route, /CONNECTION_ID\.test\(connectionId\)/u);
  assert.match(route, /cadence !== "weekly" && cadence !== "monthly"/u);
  assert.match(route, /deliveryKind !== "webhook" && deliveryKind !== "email"/u);
  // A disable action and a delete path both exist.
  assert.match(route, /record\.action === "setEnabled"/u);
  assert.match(route, /export async function DELETE\(/u);
});

test("the internal jobs tick enqueues due scheduled reports", () => {
  assert.match(jobsRoute, /ensureDueScheduledReportsEnqueued\(queue, new FinopsScheduledReportRepository\(\)\)/u);
});
