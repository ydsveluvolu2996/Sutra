/* eslint-disable @typescript-eslint/no-explicit-any -- hostile-boundary fixtures intentionally mutate unknown JSON */
import assert from "node:assert/strict";
import test from "node:test";

import { canonicalJson } from "../lib/canonical-json.ts";
import { createComputeOptimizerCapabilityPostHandler } from
  "../lib/finops-compute-optimizer-capability-route-handler.ts";

const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const NOW = Date.parse("2026-08-02T12:00:00.000Z");
const REGIONS = ["ap-south-1", "us-east-1"] as const;

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)]
    .map((part) => part.toString(16).padStart(2, "0")).join("");
}

function manifest(request: any) {
  return {
    schema: "sutra.compute-optimizer-materialization-activation-manifest-response.v1",
    requestId: request.requestId,
    tenantId: request.tenantId,
    connectionId: request.connectionId,
    accountId: request.accountId,
    partition: request.partition,
    permissionPackVersion: "standard-2026-08.5",
    regions: REGIONS.map((region, index) => ({
      region,
      describeContractId: `describe_${index}`,
      launchContractId: `launch_${index}`,
      objectReadContractId: `object_${index}`,
      bucket: `sutra-co-${region}`,
      basePrefix: "exports/",
      effectivePrefix: "exports/compute-optimizer/123456789012/",
    })),
  };
}

function fixture(overrides: Record<string, unknown> = {}) {
  const calls = { assertions: [] as string[], manifests: [] as any[], records: [] as any[] };
  const value: any = {
    assertSameOrigin: () => undefined,
    readBody: async (request: Request, maximumBytes: number) => {
      assert.equal(maximumBytes, 1_024);
      return request.json();
    },
    requireSession: async () => ({ subject: { orgId: "org_alpha" } }),
    getConnection: async (organizationId: string, connectionId: string) => {
      assert.equal(organizationId, "org_alpha");
      assert.equal(connectionId, CONNECTION_ID);
      return {
        id: CONNECTION_ID,
        customerId: "customer_alpha",
        sourceKind: "aws_trust_role",
        status: "active",
        awsAccountId: "123456789012",
        partition: "aws",
        enabledRegions: ["us-east-1", "ap-south-1"],
      };
    },
    assertManage: (_auth: unknown, customerId: string) => calls.assertions.push(customerId),
    transport: {
      readActivationManifest: async (request: any) => {
        calls.manifests.push(request);
        return manifest(request);
      },
    },
    getCurrentCapability: async () => null,
    recordCapability: async (scope: any, input: any, nowMs: number) => {
      calls.records.push({ scope, input, nowMs });
      return {
        capabilityId: `cocp_${"b".repeat(64)}`,
        scope,
        accountId: input.accountId,
        partition: input.partition,
        permissionPackVersion: "standard-2026-08.5",
        regions: input.regions,
        manifestSha256: input.manifestSha256,
        verifiedAtIso: new Date(input.verifiedAtMs).toISOString(),
        enabled: input.enabled,
      };
    },
    nowMs: () => NOW,
    ...overrides,
  };
  return { calls, value };
}

function request(body: unknown): Request {
  return new Request("https://sutra.test/api/v1/finops/compute-optimizer", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://sutra.test" },
    body: JSON.stringify(body),
  });
}

test("authorized activation derives tenant/account/partition/explicit Regions server-side and records the verified manifest hash", async () => {
  const testFixture = fixture();
  const response = await createComputeOptimizerCapabilityPostHandler(testFixture.value)(
    request({ connectionId: CONNECTION_ID, enabled: true }),
  );
  assert.equal(response.status, 200);
  assert.deepEqual(testFixture.calls.assertions, ["customer_alpha"]);
  assert.equal(testFixture.calls.manifests.length, 1);
  const brokerRequest = testFixture.calls.manifests[0];
  assert.equal(brokerRequest.tenantId, "org_alpha");
  assert.equal(brokerRequest.connectionId, CONNECTION_ID);
  assert.equal(brokerRequest.accountId, "123456789012");
  assert.equal(brokerRequest.partition, "aws");
  assert.equal(brokerRequest.requiredPermissionPackVersion, "standard-2026-08.5");
  assert.match(brokerRequest.requestId, /^coav_[a-f0-9]{64}$/u);
  const recorded = testFixture.calls.records[0];
  assert.deepEqual(recorded.scope, {
    organizationId: "org_alpha", customerId: "customer_alpha", connectionId: CONNECTION_ID,
  });
  assert.deepEqual(recorded.input.regions, REGIONS);
  assert.equal(recorded.input.verifiedAtMs, NOW);
  assert.equal(recorded.nowMs, NOW);
  assert.equal(recorded.input.manifestSha256, await sha256(canonicalJson(manifest(brokerRequest))));
  const body: any = await response.json();
  assert.equal(body.capability.enabled, true);
  assert.equal(body.capability.regionCount, 2);
  assert.equal(JSON.stringify(body).includes("bucket"), false);
  assert.equal(JSON.stringify(body).includes("ContractId"), false);
});

test("identical verified activation replay returns the current capability without a second write", async () => {
  let current: any = null;
  const testFixture = fixture({
    getCurrentCapability: async () => current,
    recordCapability: async (scope: any, input: any) => {
      testFixture.calls.records.push({ scope, input });
      current = {
        capabilityId: `cocp_${"c".repeat(64)}`, scope, accountId: input.accountId,
        partition: input.partition, permissionPackVersion: "standard-2026-08.5",
        regions: input.regions, manifestSha256: input.manifestSha256,
        verifiedAtIso: new Date(NOW).toISOString(), enabled: input.enabled,
      };
      return current;
    },
  });
  const handler = createComputeOptimizerCapabilityPostHandler(testFixture.value);
  assert.equal((await handler(request({ connectionId: CONNECTION_ID, enabled: true }))).status, 200);
  assert.equal((await handler(request({ connectionId: CONNECTION_ID, enabled: true }))).status, 200);
  assert.equal(testFixture.calls.records.length, 1);
  assert.equal(testFixture.calls.manifests[0].requestId, testFixture.calls.manifests[1].requestId);
});

test("tampered or substituted manifest never persists capability state", async () => {
  for (const mutate of [
    (value: any) => ({ ...value, accountId: "999999999999" }),
    (value: any) => ({ ...value, requestId: "substituted_request" }),
    (value: any) => ({ ...value, regions: value.regions.slice(0, 1) }),
  ]) {
    const testFixture = fixture({
      transport: { readActivationManifest: async (brokerRequest: any) => mutate(manifest(brokerRequest)) },
    });
    const response = await createComputeOptimizerCapabilityPostHandler(testFixture.value)(
      request({ connectionId: CONNECTION_ID, enabled: true }),
    );
    assert.equal(response.status, 502);
    assert.equal(testFixture.calls.records.length, 0);
    assert.equal((await response.text()).includes("999999999999"), false);
  }
});

test("authorization, tenant ownership and active connection checks precede manifest transport", async () => {
  for (const [expected, overrides] of [
    [403, { assertManage: () => { throw Object.assign(new Error("secret policy"), { code: "AUTHORIZATION_DENIED", status: 403 }); } }],
    [404, { getConnection: async () => null }],
    [404, { getConnection: async () => ({ id: CONNECTION_ID, customerId: "customer_other", sourceKind: "aws_trust_role", status: "disabled", awsAccountId: "123456789012", partition: "aws", enabledRegions: REGIONS }) }],
  ] as const) {
    let transported = 0;
    const testFixture = fixture({ ...overrides, transport: { readActivationManifest: async () => { transported += 1; return null; } } });
    const response = await createComputeOptimizerCapabilityPostHandler(testFixture.value)(
      request({ connectionId: CONNECTION_ID, enabled: true }),
    );
    assert.equal(response.status, expected);
    assert.equal(transported, 0);
    assert.equal((await response.text()).includes("secret policy"), false);
  }
});

test("body is exact and browser cannot inject Regions or provider topology", async () => {
  for (const body of [
    { connectionId: CONNECTION_ID, enabled: true, regions: ["us-east-1"] },
    { connectionId: CONNECTION_ID, enabled: true, bucket: "attacker-bucket" },
    { connectionId: CONNECTION_ID },
  ]) {
    let authenticated = false;
    const testFixture = fixture({ requireSession: async () => { authenticated = true; return { subject: { orgId: "org_alpha" } }; } });
    const response = await createComputeOptimizerCapabilityPostHandler(testFixture.value)(request(body));
    assert.equal(response.status, 400);
    assert.equal(authenticated, false);
  }
  const allEnabled = fixture({
    getConnection: async () => ({ id: CONNECTION_ID, customerId: "customer_alpha", sourceKind: "aws_trust_role", status: "active", awsAccountId: "123456789012", partition: "aws", enabledRegions: ["all-enabled"] }),
  });
  const response = await createComputeOptimizerCapabilityPostHandler(allEnabled.value)(
    request({ connectionId: CONNECTION_ID, enabled: true }),
  );
  assert.equal(response.status, 409);
  assert.equal(allEnabled.calls.manifests.length, 0);
});
