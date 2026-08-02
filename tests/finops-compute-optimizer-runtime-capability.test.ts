/* eslint-disable @typescript-eslint/no-explicit-any -- negative capability fixtures deliberately violate the production shape */
import assert from "node:assert/strict";
import test from "node:test";

import { resolveComputeOptimizerMaterializationConnection } from
  "../lib/finops-compute-optimizer-runtime-capability.ts";

const CONNECTION_ID = `conn_${"a".repeat(32)}`;
const generic = Object.freeze({
  id: CONNECTION_ID,
  customerId: "customer_alpha",
  sourceKind: "aws_trust_role",
  status: "active",
  permissionPackVersion: "standard-2026-07.4",
  awsAccountId: "123456789012",
  partition: "aws",
});
const capability = Object.freeze({
  scope: Object.freeze({
    organizationId: "org_alpha", customerId: "customer_alpha", connectionId: CONNECTION_ID,
  }),
  accountId: "123456789012",
  partition: "aws",
  permissionPackVersion: "standard-2026-08.5",
  enabled: true,
});

function dependencies(overrides: Record<string, unknown> = {}) {
  return {
    getGenericConnection: async () => generic,
    getCurrentCapability: async () => capability,
    ...overrides,
  } as any;
}

test("separate enabled capability composes an ephemeral .8.5 runtime view without mutating generic .7.4", async () => {
  const result = await resolveComputeOptimizerMaterializationConnection(
    "org_alpha", CONNECTION_ID, dependencies(),
  );
  assert.equal(result?.permissionPackVersion, "standard-2026-08.5");
  assert.equal(generic.permissionPackVersion, "standard-2026-07.4");
  assert.notEqual(result, generic);
});

test("absent, disabled, cross-tenant and mismatched account/partition capabilities are unavailable", async () => {
  const variants = [
    null,
    { ...capability, enabled: false },
    { ...capability, scope: { ...capability.scope, organizationId: "org_attacker" } },
    { ...capability, scope: { ...capability.scope, customerId: "customer_other" } },
    { ...capability, scope: { ...capability.scope, connectionId: `conn_${"b".repeat(32)}` } },
    { ...capability, accountId: "999999999999" },
    { ...capability, partition: "aws-us-gov" },
    { ...capability, permissionPackVersion: "standard-2026-07.4" },
  ];
  for (const current of variants) {
    assert.equal(await resolveComputeOptimizerMaterializationConnection(
      "org_alpha", CONNECTION_ID,
      dependencies({ getCurrentCapability: async () => current }),
    ), null);
  }
});

test("foreign, inactive or non-trust generic connections never read separate capability", async () => {
  for (const connection of [
    null,
    { ...generic, id: `conn_${"b".repeat(32)}` },
    { ...generic, status: "disabled" },
    { ...generic, sourceKind: "simulated_fixture" },
  ]) {
    let reads = 0;
    const result = await resolveComputeOptimizerMaterializationConnection(
      "org_alpha", CONNECTION_ID,
      dependencies({
        getGenericConnection: async () => connection,
        getCurrentCapability: async () => { reads += 1; return capability; },
      }),
    );
    assert.equal(result, null);
    assert.equal(reads, 0);
  }
});
