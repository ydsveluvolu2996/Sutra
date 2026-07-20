import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new URL("./cloudflare-loader.mjs", import.meta.url));

const route = await readFile(
  new URL("../app/api/v1/finops/showback/route.ts", import.meta.url),
  "utf8",
);
const { buildShowback } = await import("../lib/finops-showback.ts");
const { buildShowbackInput } = await import("../lib/finops-showback-inputs.ts");

test("Showback route is force-dynamic, authenticates the session, and never trusts caller tenant ids", () => {
  assert.match(route, /export const dynamic = "force-dynamic"/u);
  assert.match(route, /requireApiSession\(request\)/u);
  // Org-level capability gate (org/MSP-wide read), then a per-customer filter.
  assert.match(route, /assertSessionCapability\(authenticated, "connection:read"\)/u);
  assert.match(route, /const orgId = authenticated\.subject\.orgId/u);
  assert.match(route, /listConnectionsForOrg\(orgId\)/u);
  assert.match(route, /jsonResponse\(/u);
  assert.match(route, /return errorResponse\(error\)/u);
  // Tenant identity is derived from the session + resolved connections, never
  // accepted from the caller. Only the billing period is read from the query.
  assert.doesNotMatch(route, /searchParams\.get\("(?:orgId|customerId|connectionId)"\)/u);
  assert.match(route, /searchParams\.get\("period"\)/u);
});

test("Showback route filters to only the customers the session may read (no cross-tenant leak)", () => {
  // Each connection's customer is authorized individually; connections the
  // session cannot read are filtered out before any CUR line is touched.
  assert.match(route, /authorize\(authenticated\.subject, \{/u);
  assert.match(route, /capability: "connection:read",\s*customerId: connection\.customerId,/u);
  // Well-formed connection ids only (the workspace repo requires the shape).
  assert.match(route, /CONNECTION_ID\.test\(connection\.id\)/u);
});

test("Showback route wires the pure engine verbatim and joins customer names", () => {
  assert.match(route, /from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/finops-showback"/u);
  assert.match(route, /from "\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/lib\/finops-showback-inputs"/u);
  // The account-map is built from the org's connections and handed to the
  // adapter exactly as the engine expects; the engine call is not reshaped.
  assert.match(route, /accountToCustomer\[connection\.awsAccountId\] = connection\.customerId/u);
  assert.match(route, /buildShowback\(buildShowbackInput\(\{ curLines, accountToCustomer \}\)\)/u);
  // Reads are tenant-scoped through the FinOps workspace repository per customer.
  assert.match(route, /repository\.linesForPeriod\(\{ orgId, customerId: connection\.customerId \}/u);
  // The response joins the human-readable customer name onto each bucket.
  assert.match(route, /customerName: customerNameById\.get\(bucket\.customerId\)/u);
});

test("Showback route discloses unattributed spend and never sums across currencies", () => {
  // Per-currency results are mapped straight through — currencies are not merged.
  assert.match(route, /report\.results\.map\(\(currencyResult\)/u);
  assert.match(route, /currency: currencyResult\.currency/u);
  // Unattributed spend is surfaced, never dropped or reassigned.
  assert.match(route, /unattributedMicros: currencyResult\.unattributedMicros/u);
  assert.match(route, /unattributedLineCount: currencyResult\.unattributedLineCount/u);
  assert.match(route, /disclaimer: report\.disclaimer/u);
});

test("engine contract the route relies on: per-customer aggregation, unattributed disclosure, per-currency separation", () => {
  // Mirror exactly what the route builds: an account -> customer map plus the
  // concatenated CUR lines from several connections.
  const accountToCustomer = { "111122223333": "custA", "777788889999": "custB" };
  const line = (overrides) => ({
    lineItemId: "li",
    usageAccountId: "111122223333",
    service: "AmazonEC2",
    chargeCategory: "Usage",
    usageStartIso: "2026-07-01T00:00:00.000Z",
    amountMicros: "10000000",
    currency: "USD",
    tags: {},
    ...overrides,
  });
  const curLines = [
    line({}), // custA USD 10.00
    line({ lineItemId: "li2", service: "AmazonS3", amountMicros: "5000000" }), // custA USD 5.00
    line({ lineItemId: "li3", usageAccountId: "777788889999", amountMicros: "7000000" }), // custB USD 7.00
    line({ lineItemId: "li4", usageAccountId: "999999999999", amountMicros: "3000000" }), // unmapped USD 3.00
    line({ lineItemId: "li5", currency: "EUR", amountMicros: "2000000" }), // custA EUR 2.00
  ];

  const report = buildShowback(buildShowbackInput({ curLines, accountToCustomer }));

  // Currencies are never summed: one result per currency, sorted deterministically.
  assert.deepEqual(report.results.map((result) => result.currency), ["EUR", "USD"]);

  const usd = report.results.find((result) => result.currency === "USD");
  const custA = usd.customers.find((bucket) => bucket.customerId === "custA");
  const custB = usd.customers.find((bucket) => bucket.customerId === "custB");
  // Per-customer aggregation across connections/accounts, by account-map basis.
  assert.equal(custA.directMicros, "15000000");
  assert.deepEqual(custA.attributionBases, ["account-map"]);
  assert.equal(custA.lineCount, 2);
  assert.equal(custB.directMicros, "7000000");
  // Spend matching no readable customer is disclosed, never force-assigned.
  assert.equal(usd.unattributedMicros, "3000000");
  assert.equal(usd.unattributedLineCount, 1);
  assert.equal(usd.totalMicros, "25000000");

  const eur = report.results.find((result) => result.currency === "EUR");
  // EUR is its own bucket; the 25.00 USD is not mixed in.
  assert.equal(eur.totalMicros, "2000000");
  assert.equal(eur.customers.find((bucket) => bucket.customerId === "custA").directMicros, "2000000");
});
