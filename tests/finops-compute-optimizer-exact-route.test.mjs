import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { register } from "node:module";
import test from "node:test";

register(new globalThis.URL("./cloudflare-loader.mjs", import.meta.url));

const { createComputeOptimizerExactGetHandler } = await import(
  "../lib/finops-compute-optimizer-exact-route-handler.ts"
);

const CONNECTION = `conn_${"a".repeat(32)}`;
const REQUEST_URL = `https://sutra.test/api/v1/finops/compute-optimizer?connectionId=${CONNECTION}`;
const SHA = "a".repeat(64);

function dependencies(overrides = {}) {
  const calls = { scopes: [], assert: [] };
  const defaults = {
    requireSession: async () => ({ subject: { orgId: "org_alpha" } }),
    getConnection: async () => ({ id: CONNECTION, customerId: "customer_alpha", sourceKind: "aws_trust_role", status: "active" }),
    assertRead: (auth, customerId) => calls.assert.push([auth.subject.orgId, customerId]),
    getHeadReference: async (scope) => { calls.scopes.push(scope); return null; },
    getStoredPlanSet: async (scope) => { calls.scopes.push(scope); return null; },
    getStoredPlan: async (scope) => { calls.scopes.push(scope); return null; },
    createEnvelope: async () => ({}),
    readPlanSet: async ({ scope }) => { calls.scopes.push(scope); return { planIds: ["plan-a"] }; },
    getGeneration: async (scope) => { calls.scopes.push(scope); return null; },
    buildDashboard: async ({ scope }) => { calls.scopes.push(scope); return { marker: "dashboard" }; },
    nowMs: () => Date.parse("2026-08-02T12:00:00.000Z"),
  };
  return { calls, value: { ...defaults, ...overrides } };
}

async function body(response) { return response.json(); }

test("GET authenticates, authorizes and derives every scope from session plus owned connection", async () => {
  const fixture = dependencies();
  const response = await createComputeOptimizerExactGetHandler(fixture.value)(new Request(REQUEST_URL));
  assert.equal(response.status, 200);
  assert.equal((await body(response)).sourceState, "EXPORT_CONFIGURATION_REQUIRED");
  assert.deepEqual(fixture.calls.assert, [["org_alpha", "customer_alpha"]]);
  assert.deepEqual(fixture.calls.scopes, [{ organizationId: "org_alpha", customerId: "customer_alpha", connectionId: CONNECTION }]);
});

test("401, 403 and unowned/inactive connections fail before evidence reads", async () => {
  for (const [expected, overrides] of [
    [401, { requireSession: async () => { throw Object.assign(new Error("secret auth detail"), { status: 401, code: "UNAUTHORIZED" }); } }],
    [403, { assertRead: () => { throw Object.assign(new Error("secret policy detail"), { status: 403, code: "FORBIDDEN" }); } }],
    [404, { getConnection: async () => null }],
    [404, { getConnection: async () => ({ id: CONNECTION, customerId: "customer_other", sourceKind: "aws_trust_role", status: "disabled" }) }],
  ]) {
    let evidenceReads = 0;
    const fixture = dependencies({ ...overrides, getHeadReference: async () => { evidenceReads += 1; return null; } });
    const response = await createComputeOptimizerExactGetHandler(fixture.value)(new Request(REQUEST_URL));
    assert.equal(response.status, expected);
    assert.equal(evidenceReads, 0);
    assert.doesNotMatch(await response.text(), /secret (?:auth|policy) detail/u);
  }
});

test("unknown, duplicate, malformed, unsafe and semantically invalid queries return sanitized 400", async () => {
  for (const suffix of [
    "&unknown=x", "&limit=1&limit=2", "&offset=-1", "&offset=01",
    "&offset=100001", "&offset=999999999999999999999", "&limit=0", "&limit=501",
    "&accountId=123", "&region=not-a-region", "&exportFamily=FABRICATED",
    "&tagValue=payments", "&search=%3Cscript%3E",
  ]) {
    let authenticated = false;
    const fixture = dependencies({ requireSession: async () => { authenticated = true; return { subject: { orgId: "org_alpha" } }; } });
    const response = await createComputeOptimizerExactGetHandler(fixture.value)(new Request(`${REQUEST_URL}${suffix}`));
    assert.equal(response.status, 400);
    assert.equal(authenticated, false);
    assert.doesNotMatch(await response.text(), /999999999999999999999/u);
  }
});

test("missing key returns bounded 503 and never reads or emits sealed evidence", async () => {
  let planReads = 0;
  const fixture = dependencies({
    getHeadReference: async () => ({ generationId: `cog_${SHA}`, planSetId: `copes_${SHA}`, planSetContentSha256: SHA }),
    getStoredPlanSet: async () => ({ contentSha256: SHA, planIds: ["plan-a"] }),
    getStoredPlan: async () => { planReads += 1; return { sealedEnvelope: { ciphertext: "secret-ciphertext" } }; },
    createEnvelope: async () => { throw new Error("secret-key-material"); },
  });
  const response = await createComputeOptimizerExactGetHandler(fixture.value)(new Request(REQUEST_URL));
  const text = await response.text();
  assert.equal(response.status, 503);
  assert.equal(planReads, 1);
  assert.match(text, /EXACT_EVIDENCE_KEY_NOT_CONFIGURED/u);
  assert.doesNotMatch(text, /secret-(?:ciphertext|key-material)/u);
});

test("immutable head ID produces a consistent ready response and exact tenant scopes", async () => {
  const generation = {
    generationId: `cog_${SHA}`,
    dataThroughAtIso: "2026-08-02T11:00:00.000Z",
    schemaAssurances: ["OFFICIAL_USER_GUIDE_CSV_LABELS"],
    unresolvedEvidence: { targetCount: 0 },
  };
  const fixture = dependencies({
    getHeadReference: async (scope) => { fixture.calls.scopes.push(scope); return { generationId: generation.generationId, planSetId: `copes_${SHA}`, planSetContentSha256: SHA }; },
    getStoredPlanSet: async (scope) => { fixture.calls.scopes.push(scope); return { contentSha256: SHA, planIds: ["plan-a"] }; },
    getStoredPlan: async (scope) => { fixture.calls.scopes.push(scope); return { planId: "plan-a" }; },
    getGeneration: async (scope, _planSet, generationId) => { fixture.calls.scopes.push(scope); assert.equal(generationId, generation.generationId); return generation; },
    buildDashboard: async ({ scope, filters }) => { fixture.calls.scopes.push(scope); assert.deepEqual(filters, { limit: 25 }); return { marker: "exact" }; },
  });
  const response = await createComputeOptimizerExactGetHandler(fixture.value)(new Request(`${REQUEST_URL}&limit=25`));
  const result = await body(response);
  assert.equal(response.status, 200);
  assert.equal(result.sourceState, "READY");
  assert.deepEqual(result.dashboard, { marker: "exact" });
  assert.deepEqual(result.collection, { available: false, state: "EXACT_SCHEDULED_HANDLER_NOT_REGISTERED" });
  assert.ok(fixture.calls.scopes.every((scope) => scope.organizationId === "org_alpha"
    && scope.customerId === "customer_alpha" && scope.connectionId === CONNECTION));
});

test("missing/corrupt stored evidence returns a sanitized 500", async () => {
  const fixture = dependencies({
    getHeadReference: async () => ({ generationId: `cog_${SHA}`, planSetId: `copes_${SHA}`, planSetContentSha256: SHA }),
    getStoredPlanSet: async () => ({ contentSha256: SHA, planIds: ["missing-plan"] }),
    getStoredPlan: async () => null,
  });
  const response = await createComputeOptimizerExactGetHandler(fixture.value)(new Request(REQUEST_URL));
  assert.equal(response.status, 500);
  assert.doesNotMatch(await response.text(), /missing-plan|stack|ciphertext/iu);
});

test("framework route binds the executable handler to production dependencies", async () => {
  const route = await readFile(new URL("../app/api/v1/finops/compute-optimizer/route.ts", import.meta.url), "utf8");
  assert.match(route, /export const GET = createComputeOptimizerExactGetHandler/u);
  assert.match(route, /requireSession: requireApiSession/u);
  assert.match(route, /assertSessionCapability\(auth, "connection:read", customerId\)/u);
  assert.match(route, /getAcceptedGeneration\(scope, planSet, generationId\)/u);
  assert.doesNotMatch(route, /ComputeOptimizerExportRepository|export-history|buildComputeOptimizerExportDashboard/u);
});
